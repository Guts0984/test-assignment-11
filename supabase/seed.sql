-- Demo data: 3 senders, 2 dispatchers, 30 couriers, 50 000 deliveries over 90 days in every status.
-- Deterministic (hash based, no random()), except for tokens and codes. Demo logins are in the README.
-- app.seeding = on disables the outbox/broadcast triggers and the "created only" insert rule for this script.

set app.seeding = 'on';

create function pg_temp.r(key text) returns double precision language sql immutable as
$$ select (abs(hashtextextended(key, 1) % 1000000))::double precision / 1000000 $$;

-- Kyiv midnight, N days ago
create function pg_temp.kmid(days_ago integer) returns timestamptz language sql stable as
$$ select (date_trunc('day', now() at time zone 'Europe/Kyiv') - make_interval(days => days_ago)) at time zone 'Europe/Kyiv' $$;

create function pg_temp.token() returns text language sql volatile as
$$ select translate(rtrim(encode(extensions.gen_random_bytes(16), 'base64'), '='), '+/', '-_') $$;

-- ───────── people ─────────
create temp table _people as
select 'sender'::public.user_role as role, n,
  format('a0000000-0000-4000-8000-%s', lpad(n::text, 12, '0'))::uuid as id,
  format('sender%s@example.com', n) as email,
  (array['Mariia Shevchenko', 'Taras Bondarenko', 'Oksana Melnyk'])[n] as full_name,
  'Sender-Pass-123' as pw
from generate_series(1, 3) n
union all
select 'dispatcher', n, format('d0000000-0000-4000-8000-%s', lpad(n::text, 12, '0'))::uuid,
  format('dispatcher%s@example.com', n),
  (array['Halyna Kravchuk', 'Pavlo Tkachenko'])[n], 'Dispatcher-Pass-123'
from generate_series(1, 2) n
union all
select 'courier', n, format('c0000000-0000-4000-8000-%s', lpad(n::text, 12, '0'))::uuid,
  format('courier%s@example.com', lpad(n::text, 2, '0')),
  (array['Andrii','Bohdan','Volodymyr','Hanna','Dmytro','Yevhen','Zoriana','Ivan','Kateryna','Leonid',
         'Maryna','Mykola','Nadiia','Oleh','Petro','Roman','Svitlana','Taras','Uliana','Viktor',
         'Yaroslav','Anastasiia','Oksana','Serhii','Tetiana','Yurii','Olena','Maksym','Iryna','Stepan'])[n]
  || ' ' ||
  (array['Kovalenko','Boiko','Tkachuk','Shevchuk','Kovalchuk','Bondar','Oliinyk','Moroz','Lysenko','Rudenko',
         'Savchenko','Petrenko','Marchenko','Kravets','Polishchuk','Zinchenko','Honchar','Danylenko','Yakymenko','Pavlenko',
         'Sydorenko','Klymenko','Romaniuk','Havrylenko','Kuzmenko','Fedorenko','Hrytsenko','Ostapenko','Lytvynenko','Vasylenko'])[n],
  'Courier-Pass-123'
from generate_series(1, 30) n;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, reauthentication_token, phone_change, phone_change_token
)
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email,
  extensions.crypt(pw, extensions.gen_salt('bf', 8)), now(),
  jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'role', role::text),
  jsonb_build_object('full_name', full_name), now(), now(), '', '', '', '', '', '', '', ''
from _people;

insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), id::text, id,
  jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true), 'email', now(), now(), now()
from _people;

insert into public.profiles (user_id, role, full_name, phone)
select id, role, full_name,
  '+38050' || lpad((case role when 'sender' then 1000000 when 'dispatcher' then 2000000 else 3000000 end + n)::text, 7, '0')
from _people;

insert into public.senders (user_id, company)
select id, (array['Nova Shop', 'Fresh Market', 'Tech Hub'])[n] from _people where role = 'sender';

insert into public.sender_webhooks (sender_id, url, secret)
select id, 'http://sender-stub:5000/hook', 'whsec_demo_change_me' from _people where role = 'sender';

insert into public.couriers (user_id) select id from _people where role = 'courier';

-- ───────── shifts: one per courier per day for 90 days; today 24 couriers are on shift, 6 already closed ─────────
-- Closed shifts start with zero cash; the real figures are filled in after the deliveries exist.
insert into public.shifts (courier_id, opened_at, closed_at, closed_by, expected_cash_kop, handed_cash_kop, discrepancy_kop)
select p.id, pg_temp.kmid(d) + interval '6 hours', pg_temp.kmid(d) + interval '22 hours',
  'd0000000-0000-4000-8000-000000000001', 0, 0, 0
from _people p cross join generate_series(1, 90) d where p.role = 'courier';

insert into public.shifts (courier_id, opened_at, closed_at, closed_by, expected_cash_kop, handed_cash_kop, discrepancy_kop)
select p.id, greatest(now() - interval '12 hours', pg_temp.kmid(0) - interval '1 hour'),
  least(now() - interval '1 minute', greatest(now() - interval '12 hours', pg_temp.kmid(0) - interval '1 hour') + interval '4 hours'),
  'd0000000-0000-4000-8000-000000000001', 0, 0, 0
from _people p where p.role = 'courier' and p.n > 24;

insert into public.shifts (courier_id, opened_at)
select p.id, greatest(now() - interval '12 hours', pg_temp.kmid(0) - interval '1 hour')
from _people p where p.role = 'courier' and p.n <= 24;

-- ───────── delivery plan: exact counts per status, deterministic attributes ─────────
create temp table _sd as
with ranked as (
  select i, row_number() over (order by pg_temp.r('s' || i), i) as rn from generate_series(1, 50000) i
), st as (
  select i, rn,
    case
      when rn <= 400 then 'created' when rn <= 510 then 'assigned' when rn <= 580 then 'picked_up'
      when rn <= 880 then 'failed_attempt' when rn <= 1000 then 'returning' when rn <= 2500 then 'returned'
      when rn <= 5500 then 'cancelled' else 'delivered'
    end::public.delivery_status as status
  from ranked
), at as (
  select st.*,
    case
      when status in ('returning', 'returned') then 3
      when status = 'failed_attempt' then case when pg_temp.r('a' || i) < 0.5 then 1 else 2 end
      when status = 'delivered' then case when pg_temp.r('a' || i) < 0.92 then 1 when pg_temp.r('a' || i) < 0.98 then 2 else 3 end
      when status in ('assigned', 'picked_up') then case when pg_temp.r('a' || i) < 0.9 then 1 else 2 end
      else 1
    end as a
  from st
)
select i, rn, status, a,
  case status
    when 'created' then 0
    when 'assigned' then 0
    when 'picked_up' then 0
    when 'failed_attempt' then case when pg_temp.r('d' || i) < 0.2 then 0 else 1 + floor(pg_temp.r('e' || i) * 5)::int end
    when 'returning' then 1 + floor(pg_temp.r('d' || i) * 2)::int
    when 'returned' then 2 + floor(pg_temp.r('d' || i) * 84)::int
    when 'cancelled' then floor(pg_temp.r('d' || i) * 88)::int
    else case when a = 1 and pg_temp.r('d' || i) < 0.03 then 0 else 1 + floor(pg_temp.r('e' || i) * (88 - (a - 1)))::int end
  end as dlast,
  (status = 'cancelled' and pg_temp.r('c' || i) < 0.4) as cancel_after_assign,
  gen_random_uuid() as id,
  format('a0000000-0000-4000-8000-%s', lpad((1 + floor(pg_temp.r('o' || i) * 3)::int)::text, 12, '0'))::uuid as sender_id,
  (case when pg_temp.r('z' || i) < 0.5 then 'A' when pg_temp.r('z' || i) < 0.8 then 'B' else 'C' end)::public.zone as zone,
  1 + floor(power(pg_temp.r('g' || i), 2.5) * 29999)::int as weight_g,
  case when pg_temp.r('k' || i) < 0.4
    then ((100 + floor(pg_temp.r('v' || i) * 4900)::bigint) * 100 + floor(pg_temp.r('w' || i) * 100)::bigint)
    else 0::bigint end as cod_kop,
  -- on-shift couriers 1..24 take the live work; spread active deliveries evenly so nobody exceeds 8
  1 + ((row_number() over (partition by status order by i) - 1) % 24)::int as live_courier
from at;

-- ───────── attempts (one row per assignment of a delivery to a courier) ─────────
create temp table _sa as
with base as (
  select d.i, d.status, d.a, d.dlast, d.cancel_after_assign, k.k,
    (d.dlast + (d.a - k.k)) as dd,
    (k.k = d.a and d.dlast = 0) as anchored,
    (k.k < d.a or d.status in ('picked_up', 'delivered', 'failed_attempt', 'returning', 'returned')) as has_picked,
    case
      when k.k < d.a or d.status in ('failed_attempt', 'returning', 'returned') then 'failed'
      when d.status = 'delivered' then 'delivered'
      when d.status = 'cancelled' then 'cancelled'
    end as outcome,
    case
      when k.k = d.a and d.status in ('assigned', 'picked_up') then d.live_courier
      when k.k = d.a and d.dlast = 0 then 1 + floor(pg_temp.r('u' || d.i || ':' || k.k) * 24)::int
      else 1 + floor(pg_temp.r('u' || d.i || ':' || k.k) * 30)::int
    end as courier_n
  from _sd d cross join lateral generate_series(1, d.a) k(k)
  where k.k < d.a or d.status in ('assigned', 'picked_up', 'delivered', 'failed_attempt', 'returning', 'returned')
     or (d.status = 'cancelled' and d.cancel_after_assign)
), t as (
  select b.*,
    pg_temp.kmid(b.dd) + interval '8 hours' + make_interval(secs => floor(pg_temp.r('ta' || b.i || ':' || b.k) * 4 * 3600)::int) as t_a0,
    make_interval(mins => 10 + floor(pg_temp.r('tp' || b.i || ':' || b.k) * 30)::int) as d_p,
    make_interval(mins => 20 + floor(pg_temp.r('to' || b.i || ':' || b.k) * 160)::int) as d_o
  from base b
)
select i, k, status, a, outcome, has_picked, courier_n, anchored,
  case
    when not anchored then t_a0
    when status = 'assigned' then now() - make_interval(secs => 30 + floor(pg_temp.r('x' || i) * 19 * 60)::int)
    when status = 'picked_up' then now() - make_interval(secs => 3600 + floor(pg_temp.r('x' || i) * 50 * 60)::int) - d_p
    when status = 'cancelled' then now() - make_interval(secs => 300 + floor(pg_temp.r('x' || i) * 4 * 3600)::int) - interval '20 minutes'
    else now() - make_interval(secs => 300 + floor(pg_temp.r('x' || i) * 3 * 3600)::int) - d_o - d_p
  end as t_assigned,
  null::timestamptz as t_picked, null::timestamptz as t_out
from t;

update _sa a set t_picked = case when a.has_picked then a.t_assigned + make_interval(mins => 10 + floor(pg_temp.r('tp' || a.i || ':' || a.k) * 30)::int) end;
update _sa a set t_out = case
    when a.outcome in ('failed', 'delivered') then a.t_picked + make_interval(mins => 20 + floor(pg_temp.r('to' || a.i || ':' || a.k) * 160)::int)
    when a.outcome = 'cancelled' then a.t_assigned + interval '20 minutes'
  end;

-- ───────── deliveries ─────────
create temp table _sdel as
select d.*,
  la.t_assigned as la_a, la.t_picked as la_p, la.t_out as la_o,
  case when la.courier_n is not null then format('c0000000-0000-4000-8000-%s', lpad(la.courier_n::text, 12, '0'))::uuid end as la_courier,
  case
    when d.status = 'created' then now() - make_interval(secs => 300 + floor(pg_temp.r('cr' || d.i) * 30 * 3600)::int)
    when d.status = 'cancelled' and not d.cancel_after_assign then
      (case when d.dlast = 0 then now() - make_interval(secs => 300 + floor(pg_temp.r('x' || d.i) * 4 * 3600)::int)
            else pg_temp.kmid(d.dlast) + interval '9 hours' + make_interval(secs => floor(pg_temp.r('x' || d.i) * 8 * 3600)::int) end)
        - make_interval(secs => 600 + floor(pg_temp.r('cr' || d.i) * 2 * 86400)::int)
    else fa.t_assigned - make_interval(secs => 300 + floor(pg_temp.r('cr' || d.i) * 3 * 3600)::int)
  end as created_at,
  case when d.status = 'cancelled' and not d.cancel_after_assign then
      case when d.dlast = 0 then now() - make_interval(secs => 300 + floor(pg_temp.r('x' || d.i) * 4 * 3600)::int)
           else pg_temp.kmid(d.dlast) + interval '9 hours' + make_interval(secs => floor(pg_temp.r('x' || d.i) * 8 * 3600)::int) end
  end as t_cancel_unassigned,
  row_number() over (partition by d.status order by d.i) as status_rank
from _sd d
left join _sa la on la.i = d.i and la.k = d.a
left join _sa fa on fa.i = d.i and fa.k = 1;

insert into public.deliveries (
  id, sender_id, status, courier_id, recipient_name, recipient_phone, address, zone, weight_g, cod_kop,
  fee_kop, cod_commission_kop, total_kop, attempt_no, next_attempt_at, assigned_at, picked_up_at, delivered_at,
  cod_collected_kop, delivered_shift_id, handover_blocked, wrong_code_streak, created_at, updated_at
)
select d.id, d.sender_id, d.status,
  case when d.status in ('assigned', 'picked_up', 'delivered') then d.la_courier end,
  (array['Olena','Ihor','Natalia','Vasyl','Larysa','Oleksandr','Daryna','Mykhailo','Sofiia','Artem'])[1 + floor(pg_temp.r('n1' || d.i) * 10)::int]
    || ' ' ||
  (array['Moroz','Kovalenko','Shevchenko','Bondar','Tkachenko','Melnyk','Kravchenko','Lysenko','Boyko','Savchuk'])[1 + floor(pg_temp.r('n2' || d.i) * 10)::int],
  '+38067' || lpad(floor(pg_temp.r('p' || d.i) * 10000000)::bigint::text, 7, '0'),
  jsonb_build_object(
    'city', 'Kyiv',
    'street', (array['Khreshchatyk','Velyka Vasylkivska','Peremohy Ave','Shevchenko Blvd','Sichovykh Striltsiv','Lesi Ukrainky Blvd','Obolonskyi Ave','Saksahanskoho','Antonovycha','Zoolohichna'])[1 + floor(pg_temp.r('s1' || d.i) * 10)::int],
    'house', (1 + floor(pg_temp.r('h' || d.i) * 120))::int::text,
    'apartment', (1 + floor(pg_temp.r('ap' || d.i) * 200))::int::text),
  d.zone, d.weight_g, d.cod_kop,
  app_private.calc_fee_kop(d.zone, d.weight_g), app_private.calc_cod_commission_kop(d.cod_kop),
  app_private.calc_fee_kop(d.zone, d.weight_g) + app_private.calc_cod_commission_kop(d.cod_kop),
  d.a,
  case when d.status = 'failed_attempt' then ((d.la_o at time zone 'Europe/Kyiv')::date + 1)::timestamp at time zone 'Europe/Kyiv' end,
  case when d.status in ('assigned', 'picked_up', 'delivered') then d.la_a end,
  case when d.status in ('picked_up', 'delivered') then d.la_p end,
  case when d.status = 'delivered' then d.la_o end,
  case when d.status = 'delivered' then d.cod_kop end,
  (select s.id from public.shifts s where d.status = 'delivered' and s.courier_id = d.la_courier
     and d.la_o between s.opened_at and coalesce(s.closed_at, now()) limit 1),
  (d.status = 'picked_up' and d.status_rank <= 5),
  case when d.status = 'picked_up' and d.status_rank <= 5 then 5
       when d.status = 'picked_up' and d.status_rank <= 15 then 2 else 0 end,
  d.created_at,
  coalesce(d.la_o, d.la_p, d.la_a, d.created_at)
from _sdel d
order by d.created_at, d.i;

-- link plan rows to the final numbers (for the sanity checks below nothing else is needed)
insert into public.delivery_secrets (delivery_id, recipient_code, tracking_token, tracking_channel)
select id, lpad(floor(pg_temp.r('code' || i) * 1000000)::int::text, 6, '0'), pg_temp.token(), pg_temp.token()
from _sd;

-- ───────── assignments ─────────
insert into public.assignments (delivery_id, courier_id, assigned_by, assigned_at, ended_at, end_reason)
select d.id, format('c0000000-0000-4000-8000-%s', lpad(a.courier_n::text, 12, '0'))::uuid,
  format('d0000000-0000-4000-8000-%s', lpad((1 + a.i % 2)::text, 12, '0'))::uuid,
  a.t_assigned,
  case when a.outcome is not null then a.t_out end,
  case a.outcome when 'failed' then 'failed' when 'delivered' then 'delivered' when 'cancelled' then 'cancelled' end::public.assignment_end_reason
from _sa a join _sd d on d.i = a.i;

-- ───────── history ─────────
create temp table _ev as
select * from (
  select d.i, 0 as ord, 'created'::public.event_type as type, null::public.delivery_status as from_status,
    'created'::public.delivery_status as to_status, d.created_at as t, d.sender_id as actor_id, 'sender' as actor_role,
    '{}'::jsonb as payload
  from _sdel d
  union all
  select a.i, a.k * 10 + 1, 'assigned', case when a.k = 1 then 'created' else 'failed_attempt' end::public.delivery_status, 'assigned',
    a.t_assigned, format('d0000000-0000-4000-8000-%s', lpad((1 + a.i % 2)::text, 12, '0'))::uuid, 'dispatcher',
    jsonb_build_object('courierId', format('c0000000-0000-4000-8000-%s', lpad(a.courier_n::text, 12, '0')), 'attemptNo', a.k)
  from _sa a
  union all
  select a.i, a.k * 10 + 2, 'picked_up', 'assigned', 'picked_up', a.t_picked,
    format('c0000000-0000-4000-8000-%s', lpad(a.courier_n::text, 12, '0'))::uuid, 'courier', jsonb_build_object('attemptNo', a.k)
  from _sa a where a.t_picked is not null
  union all
  select a.i, a.k * 10 + 3,
    case a.outcome when 'delivered' then 'delivered' when 'failed' then 'failed_attempt' else 'cancelled' end::public.event_type,
    case when a.outcome = 'cancelled' then 'assigned' else 'picked_up' end::public.delivery_status,
    case a.outcome when 'delivered' then 'delivered' when 'failed' then 'failed_attempt' else 'cancelled' end::public.delivery_status,
    a.t_out,
    case when a.outcome = 'cancelled' then d.sender_id else format('c0000000-0000-4000-8000-%s', lpad(a.courier_n::text, 12, '0'))::uuid end,
    case when a.outcome = 'cancelled' then 'sender' else 'courier' end,
    case a.outcome
      when 'failed' then jsonb_build_object('attemptNo', a.k, 'reason',
        (array['recipient_absent','wrong_address','recipient_refused','no_access','phone_unreachable','other'])[1 + floor(pg_temp.r('fr' || a.i || ':' || a.k) * 6)::int],
        'note', null)
      when 'delivered' then jsonb_build_object('attemptNo', a.k)
      else jsonb_build_object('reason', 'sender_request') end
  from _sa a join _sd d on d.i = a.i where a.outcome is not null
  union all
  select a.i, a.k * 10 + 4, 'returning', 'failed_attempt', 'returning', a.t_out + interval '1 second', null, 'system', '{}'::jsonb
  from _sa a join _sd d on d.i = a.i where a.outcome = 'failed' and a.k = 3
  union all
  select d.i, 99, 'returned', 'returning', 'returned',
    d.la_o + interval '1 second' + make_interval(hours => 1 + floor(pg_temp.r('rt' || d.i) * 29)::int),
    'd0000000-0000-4000-8000-000000000001', 'dispatcher', '{}'::jsonb
  from _sdel d where d.status = 'returned'
  union all
  select d.i, 5, 'cancelled', 'created', 'cancelled', d.t_cancel_unassigned, d.sender_id, 'sender',
    jsonb_build_object('reason', 'sender_request')
  from _sdel d where d.status = 'cancelled' and not d.cancel_after_assign
) e;

insert into public.delivery_events (delivery_id, type, from_status, to_status, actor_id, actor_role, device_time, server_time, payload)
select d.id, e.type, e.from_status, e.to_status, e.actor_id, e.actor_role,
  case when e.actor_role = 'courier' then e.t - make_interval(secs => floor(pg_temp.r('dv' || e.i || ':' || e.ord) * 90)::int) end,
  e.t, e.payload
from _ev e join _sd d on d.i = e.i
order by e.i, e.t, e.ord;

-- ───────── cash for closed shifts (some shifts hand in a different amount) ─────────
create temp table _cash as
select s.id, coalesce(sum(d.cod_collected_kop), 0)::bigint as expected
from public.shifts s left join public.deliveries d on d.delivered_shift_id = s.id
where s.closed_at is not null group by s.id;

-- one statement, so the shifts_closed_consistent check always sees matching figures
update public.shifts s
set expected_cash_kop = c.expected,
    handed_cash_kop = greatest(0, c.expected + case
      when c.expected > 0 and pg_temp.r('hc' || s.id) < 0.10
        then (case when pg_temp.r('hs' || s.id) < 0.7 then -1 else 1 end) * (100 + floor(pg_temp.r('ha' || s.id) * 5000)::bigint)
      else 0 end),
    discrepancy_kop = greatest(0, c.expected + case
      when c.expected > 0 and pg_temp.r('hc' || s.id) < 0.10
        then (case when pg_temp.r('hs' || s.id) < 0.7 then -1 else 1 end) * (100 + floor(pg_temp.r('ha' || s.id) * 5000)::bigint)
      else 0 end) - c.expected
from _cash c where c.id = s.id;

-- ───────── notification history for the last 45 days (already delivered) ─────────
create temp table _nt as
select gen_random_uuid() as nid, ev.id as event_id, ev.delivery_id, d.sender_id, ev.type, ev.server_time, ev.to_status, ev.from_status,
  ev.device_time, d.public_number, d.attempt_no,
  row_number() over (partition by ev.delivery_id order by ev.id) as seq
from public.delivery_events ev join public.deliveries d on d.id = ev.delivery_id
where d.created_at >= now() - interval '45 days';

insert into public.notifications (id, delivery_id, sender_id, seq, event_type, payload, status, attempts, next_attempt_at, delivered_at, created_at)
select nid, delivery_id, sender_id, seq, type,
  jsonb_build_object('id', nid, 'deliveryId', delivery_id, 'number', public_number, 'event', type, 'status', to_status,
    'previousStatus', from_status, 'attemptNo', attempt_no, 'occurredAt', server_time, 'deviceTime', device_time),
  'delivered', 1, server_time, server_time + interval '1 second', server_time
from _nt;

insert into public.notification_attempts (notification_id, attempted_at, http_status, duration_ms)
select nid, server_time + interval '1 second', 200, 20 + floor(pg_temp.r('nd' || event_id) * 280)::int from _nt;

reset app.seeding;
analyze;
