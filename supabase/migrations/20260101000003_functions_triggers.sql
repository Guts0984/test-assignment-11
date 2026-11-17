-- Business rules enforced by the database itself. apps/api takes locks and checks first (to give good errors);
-- these triggers make sure no bug in the API, and no other writer, can break an invariant.
--
-- Custom SQLSTATEs (mapped to 4xx by the API):
--   DL001 illegal status transition       DL002 courier already has the maximum active deliveries
--   DL003 courier has no open shift        DL004 immutable column changed
--   DL005 deliveries must start as created

create function app_private.is_seeding() returns boolean language sql stable as $$
  select coalesce(current_setting('app.seeding', true), '') = 'on'
$$;

-- ───────── gapless numbering (invariant 2) ─────────
-- The counter row is updated inside the creating transaction. If the transaction rolls back, so does the
-- increment, so numbers are never skipped; concurrent creators queue on the row lock, so none repeat.
create function app_private.next_delivery_number() returns bigint language sql as $$
  update public.delivery_number_counter set value = value + 1 where id = 1 returning value
$$;

create function app_private.deliveries_before_insert() returns trigger language plpgsql as $$
begin
  new.number := app_private.next_delivery_number();  -- caller-supplied numbers are ignored
  if new.status <> 'created' and not app_private.is_seeding() then
    raise exception 'deliveries must be created with status created' using errcode = 'DL005';
  end if;
  return new;
end $$;
create trigger deliveries_before_insert before insert on public.deliveries
  for each row execute function app_private.deliveries_before_insert();

-- ───────── status machine, limits, immutability ─────────
create function app_private.is_valid_transition(p_from public.delivery_status, p_to public.delivery_status)
returns boolean language sql immutable as $$
  select (p_from, p_to) in (
    ('created', 'assigned'), ('failed_attempt', 'assigned'), ('assigned', 'assigned'),
    ('assigned', 'created'), ('created', 'cancelled'), ('assigned', 'cancelled'),
    ('assigned', 'picked_up'), ('picked_up', 'delivered'), ('picked_up', 'failed_attempt'),
    ('failed_attempt', 'returning'), ('returning', 'returned'),
    -- invariant 8: an offline handover with the correct code is always counted
    ('created', 'delivered'), ('assigned', 'delivered'), ('failed_attempt', 'delivered')
  )
$$;

create function app_private.deliveries_before_update() returns trigger language plpgsql as $$
declare
  active_count integer;
begin
  if new.id is distinct from old.id or new.number is distinct from old.number
     or new.sender_id is distinct from old.sender_id or new.zone is distinct from old.zone
     or new.weight_g is distinct from old.weight_g or new.cod_kop is distinct from old.cod_kop
     or new.fee_kop is distinct from old.fee_kop or new.cod_commission_kop is distinct from old.cod_commission_kop
     or new.total_kop is distinct from old.total_kop or new.created_at is distinct from old.created_at
     or new.recipient_name is distinct from old.recipient_name
     or new.recipient_phone is distinct from old.recipient_phone
     or new.address is distinct from old.address then
    raise exception 'immutable delivery column changed' using errcode = 'DL004';
  end if;

  if new.status is distinct from old.status then
    if not app_private.is_valid_transition(old.status, new.status) then
      raise exception 'illegal status transition % -> %', old.status, new.status using errcode = 'DL001';
    end if;
  elsif old.status = 'assigned' and new.courier_id is distinct from old.courier_id then
    null; -- reassignment keeps the status
  end if;

  -- Entering an active status, or moving to another courier: serialise on the courier row, then count.
  -- Same lock order as apps/api (delivery row first, courier row second), so no deadlocks.
  -- (a NULL courier is left to the courier_iff_active CHECK so the error message stays accurate)
  if new.status in ('assigned', 'picked_up') and new.courier_id is not null
     and (old.status not in ('assigned', 'picked_up') or new.courier_id is distinct from old.courier_id) then
    perform 1 from public.couriers where user_id = new.courier_id for update;
    if new.status = 'assigned' and not exists (
      select 1 from public.shifts where courier_id = new.courier_id and closed_at is null
    ) then
      raise exception 'courier has no open shift' using errcode = 'DL003';
    end if;
    select count(*) into active_count from public.deliveries
      where courier_id = new.courier_id and status in ('assigned', 'picked_up') and id <> new.id;
    if active_count >= 8 then
      raise exception 'courier already has % active deliveries', active_count using errcode = 'DL002';
    end if;
  end if;

  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end $$;
create trigger deliveries_before_update before update on public.deliveries
  for each row execute function app_private.deliveries_before_update();

-- ───────── history → outbox + live tracking ─────────
create function app_private.short_name(p_full_name text) returns text language sql immutable as $$
  select case
    when p_full_name is null then null
    when position(' ' in trim(p_full_name)) = 0 then trim(p_full_name)
    else split_part(trim(p_full_name), ' ', 1) || ' ' || left(trim(substr(trim(p_full_name), position(' ' in trim(p_full_name)) + 1)), 1) || '.'
  end
$$;

-- Lock the delivery row BEFORE the insert. The foreign key check (an AFTER trigger) takes a shared row lock;
-- if our exclusive lock were requested after it, two concurrent writers would each hold the shared lock and
-- deadlock waiting for the exclusive one. Taking the exclusive lock first makes them queue instead.
create function app_private.delivery_events_before_insert() returns trigger language plpgsql as $$
begin
  perform 1 from public.deliveries where id = new.delivery_id for update;
  return new;
end $$;
create trigger delivery_events_before_insert before insert on public.delivery_events
  for each row execute function app_private.delivery_events_before_insert();

create function app_private.delivery_events_after_insert() returns trigger language plpgsql as $$
declare
  d public.deliveries;
  s public.delivery_secrets;
  next_seq integer;
  notif_id uuid := gen_random_uuid();
  courier_name text;
begin
  if app_private.is_seeding() or new.to_status is null then
    return new;
  end if;
  -- reassignment keeps the status, so it is not a status change
  if new.to_status is not distinct from new.from_status and new.type <> 'reassigned' then
    return new;
  end if;

  -- Lock the delivery row: per-delivery sequence numbers are allocated one writer at a time, even for
  -- callers that insert a history event without touching the delivery row first.
  select * into d from public.deliveries where id = new.delivery_id for update;

  -- Outbox (invariant 10): written in the same transaction as the change, in per-delivery order.
  if new.to_status is distinct from new.from_status
     and exists (select 1 from public.sender_webhooks w where w.sender_id = d.sender_id) then
    select coalesce(max(seq), 0) + 1 into next_seq from public.notifications where delivery_id = d.id;
    insert into public.notifications (id, delivery_id, sender_id, seq, event_type, payload)
    values (
      notif_id, d.id, d.sender_id, next_seq, new.type,
      jsonb_build_object(
        'id', notif_id, 'deliveryId', d.id, 'number', d.public_number, 'event', new.type,
        'status', new.to_status, 'previousStatus', new.from_status, 'attemptNo', d.attempt_no,
        'occurredAt', new.server_time, 'deviceTime', new.device_time
      )
    );
  end if;

  -- Live tracking: Broadcast on an unguessable channel. The payload is the safe projection only.
  select * into s from public.delivery_secrets where delivery_id = d.id;
  if found then
    select app_private.short_name(p.full_name) into courier_name
      from public.profiles p where p.user_id = d.courier_id;
    perform realtime.send(
      jsonb_build_object(
        'number', d.public_number, 'status', d.status, 'attemptNo', d.attempt_no,
        'courierName', courier_name, 'amountDueKop', d.cod_kop, 'updatedAt', d.updated_at
      ),
      'tracking', 'tracking:' || s.tracking_channel, false
    );
  end if;
  return new;
end $$;
create trigger delivery_events_after_insert after insert on public.delivery_events
  for each row execute function app_private.delivery_events_after_insert();

-- ───────── 45-minute pickup timeout (invoked by pg_cron; p_now lets tests move time) ─────────
create function app_private.release_stale_assignments(p_now timestamptz default now())
returns integer language plpgsql as $$
declare
  r record;
  released integer := 0;
begin
  for r in
    select id, courier_id, assigned_at from public.deliveries
    where status = 'assigned' and assigned_at <= p_now - interval '45 minutes'
    order by assigned_at
    for update skip locked
  loop
    update public.deliveries
      set status = 'created', courier_id = null, assigned_at = null
      where id = r.id and status = 'assigned';
    update public.assignments set ended_at = p_now, end_reason = 'timeout'
      where delivery_id = r.id and ended_at is null;
    insert into public.delivery_events (delivery_id, type, from_status, to_status, actor_role, server_time, payload)
    values (
      r.id, 'released', 'assigned', 'created', 'system', p_now,
      jsonb_build_object('reason', 'pickup_timeout', 'minutes', 45, 'courierId', r.courier_id, 'assignedAt', r.assigned_at)
    );
    released := released + 1;
  end loop;
  return released;
end $$;

-- ───────── privileges ─────────
revoke all on function app_private.next_delivery_number() from public;
revoke all on function app_private.release_stale_assignments(timestamptz) from public;
