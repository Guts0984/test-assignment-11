-- Core tables. All writes go through apps/api (direct connection); browsers only ever SELECT (see RLS).

-- ───────── pricing, mirrored from packages/shared (a test compares both implementations) ─────────
create function app_private.calc_fee_kop(p_zone public.zone, p_weight_g integer)
returns bigint language sql immutable parallel safe as $$
  select (case p_zone when 'A' then 6000 when 'B' then 8000 else 11000 end)::bigint
         + 800 * greatest(0, ceil(p_weight_g / 1000.0)::bigint - 1)
$$;

create function app_private.calc_cod_commission_kop(p_cod_kop bigint)
returns bigint language sql immutable parallel safe as $$
  select case when p_cod_kop = 0 then 0 else greatest(2000, (p_cod_kop * 2 + 50) / 100) end
$$;

-- ───────── people ─────────
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role public.user_role not null,
  full_name text not null check (length(full_name) between 1 and 100),
  phone text,
  created_at timestamptz not null default now()
);

create table public.senders (
  user_id uuid primary key references public.profiles (user_id) on delete cascade,
  company text not null check (length(company) between 1 and 100)
);

create table public.sender_webhooks (
  sender_id uuid primary key references public.senders (user_id) on delete cascade,
  url text not null check (url ~ '^https?://'),
  secret text not null check (length(secret) >= 8),
  updated_at timestamptz not null default now()
);

create table public.couriers (
  user_id uuid primary key references public.profiles (user_id) on delete cascade,
  active boolean not null default true
);

-- ───────── numbering ─────────
create table public.delivery_number_counter (
  id integer primary key check (id = 1),
  value bigint not null check (value >= 0)
);
insert into public.delivery_number_counter (id, value) values (1, 0);

-- ───────── shifts ─────────
create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  courier_id uuid not null references public.couriers (user_id),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references public.profiles (user_id),
  expected_cash_kop bigint check (expected_cash_kop >= 0),
  handed_cash_kop bigint check (handed_cash_kop >= 0),
  discrepancy_kop bigint,
  constraint shifts_closed_consistent check (
    (closed_at is null and closed_by is null and expected_cash_kop is null
       and handed_cash_kop is null and discrepancy_kop is null)
    or (closed_at is not null and expected_cash_kop is not null
       and handed_cash_kop is not null and discrepancy_kop = handed_cash_kop - expected_cash_kop)
  ),
  constraint shifts_time_order check (closed_at is null or closed_at >= opened_at)
);
create unique index shifts_one_open_per_courier on public.shifts (courier_id) where closed_at is null;
create index shifts_courier_opened on public.shifts (courier_id, opened_at desc);
create index shifts_closed_at on public.shifts (closed_at) where closed_at is not null;

-- ───────── deliveries ─────────
create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  number bigint not null,
  public_number text generated always as (
    'DLV-' || case when number >= 1000000 then number::text else lpad(number::text, 6, '0') end
  ) stored,
  sender_id uuid not null references public.senders (user_id),
  status public.delivery_status not null default 'created',
  courier_id uuid references public.couriers (user_id),
  recipient_name text not null check (length(recipient_name) between 1 and 100),
  recipient_phone text not null check (recipient_phone ~ '^\+[1-9][0-9]{7,14}$'),
  address jsonb not null check (jsonb_typeof(address) = 'object'),
  zone public.zone not null,
  weight_g integer not null check (weight_g between 1 and 30000),
  cod_kop bigint not null default 0 check (cod_kop between 0 and 10000000),
  fee_kop bigint not null,
  cod_commission_kop bigint not null,
  total_kop bigint not null,
  attempt_no smallint not null default 1 check (attempt_no between 1 and 3),
  next_attempt_at timestamptz,
  assigned_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  cod_collected_kop bigint check (cod_collected_kop >= 0),
  delivered_shift_id uuid references public.shifts (id),
  handover_blocked boolean not null default false,
  wrong_code_streak smallint not null default 0 check (wrong_code_streak between 0 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint deliveries_number_unique unique (number),
  constraint deliveries_price_fee check (fee_kop = app_private.calc_fee_kop(zone, weight_g)),
  constraint deliveries_price_commission check (cod_commission_kop = app_private.calc_cod_commission_kop(cod_kop)),
  constraint deliveries_price_total check (total_kop = fee_kop + cod_commission_kop),
  -- a courier is attached exactly while the delivery is with them (or was delivered by them)
  constraint deliveries_courier_iff_active check (
    (status in ('assigned', 'picked_up', 'delivered')) = (courier_id is not null)
  ),
  constraint deliveries_delivered_fields check (
    status <> 'delivered'
    or (delivered_at is not null and cod_collected_kop is not null and cod_collected_kop = cod_kop)
  ),
  constraint deliveries_blocked_matches_streak check (not handover_blocked or wrong_code_streak >= 5)
);

create index deliveries_sender_created on public.deliveries (sender_id, created_at desc, id);
create index deliveries_sender_phone on public.deliveries (sender_id, recipient_phone);
create index deliveries_sender_status on public.deliveries (sender_id, status, created_at desc);
create index deliveries_courier_active on public.deliveries (courier_id) where status in ('assigned', 'picked_up');
create index deliveries_courier_delivered on public.deliveries (courier_id, delivered_at desc) where status = 'delivered';
create index deliveries_queue on public.deliveries (zone, created_at) where status in ('created', 'failed_attempt');
create index deliveries_status_created on public.deliveries (status, created_at desc);
create index deliveries_delivered_at on public.deliveries (delivered_at) where status = 'delivered';
create index deliveries_stale_assigned on public.deliveries (assigned_at) where status = 'assigned';
create index deliveries_shift on public.deliveries (delivered_shift_id) where delivered_shift_id is not null;
create index deliveries_created_at on public.deliveries (created_at);

-- Secrets that couriers (and every browser client) must never read. No RLS policy → no direct access at all.
create table public.delivery_secrets (
  delivery_id uuid primary key references public.deliveries (id) on delete cascade,
  recipient_code text not null check (recipient_code ~ '^[0-9]{6}$'),
  tracking_token text not null check (length(tracking_token) >= 22),
  tracking_channel text not null check (length(tracking_channel) >= 22),
  constraint delivery_secrets_token_unique unique (tracking_token),
  constraint delivery_secrets_channel_unique unique (tracking_channel)
);

alter table public.deliveries
  add constraint deliveries_shift_fk_check check (delivered_shift_id is null or status = 'delivered');

create table public.idempotency_keys (
  sender_id uuid not null references public.senders (user_id),
  key text not null check (length(key) between 8 and 128),
  request_hash text not null,
  delivery_id uuid not null references public.deliveries (id),
  created_at timestamptz not null default now(),
  primary key (sender_id, key)
);

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.deliveries (id),
  courier_id uuid not null references public.couriers (user_id),
  assigned_by uuid references public.profiles (user_id),
  assigned_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason public.assignment_end_reason,
  constraint assignments_end_consistent check ((ended_at is null) = (end_reason is null))
);
-- Invariant 3 backstop: a delivery has at most one active assignment.
create unique index assignments_one_active_per_delivery on public.assignments (delivery_id) where ended_at is null;
create index assignments_courier_active on public.assignments (courier_id) where ended_at is null;
create index assignments_courier_assigned on public.assignments (courier_id, assigned_at desc);
create index assignments_delivery on public.assignments (delivery_id, assigned_at);

create table public.delivery_events (
  id bigint generated always as identity primary key,
  delivery_id uuid not null references public.deliveries (id) on delete cascade,
  type public.event_type not null,
  from_status public.delivery_status,
  to_status public.delivery_status,
  actor_id uuid,
  actor_role text not null check (actor_role in ('sender', 'dispatcher', 'courier', 'system')),
  device_time timestamptz,
  server_time timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);
create index delivery_events_delivery on public.delivery_events (delivery_id, id);
create index delivery_events_type_time on public.delivery_events (type, server_time);
create index delivery_events_time on public.delivery_events (server_time);

create table public.courier_actions (
  courier_id uuid not null references public.couriers (user_id),
  client_action_id uuid not null,
  delivery_id uuid not null references public.deliveries (id),
  type public.action_type not null,
  device_time timestamptz not null,
  received_at timestamptz not null default now(),
  result public.action_result,
  reject_code text,
  reject_message text,
  response jsonb,
  primary key (courier_id, client_action_id),
  constraint courier_actions_reject_fields check (
    (result = 'rejected') = (reject_code is not null) or result is null
  )
);
create index courier_actions_delivery on public.courier_actions (delivery_id);
create index courier_actions_rejected on public.courier_actions (courier_id, received_at desc) where result = 'rejected';

create table public.photos (
  id uuid primary key,
  delivery_id uuid not null references public.deliveries (id),
  courier_id uuid not null references public.couriers (user_id),
  kind public.photo_kind not null,
  storage_path text not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer not null check (size_bytes between 1 and 5242880),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  created_at timestamptz not null default now()
);
create index photos_delivery on public.photos (delivery_id);

-- Cash that arrived after a shift was already closed (offline handover synced late).
create table public.cash_adjustments (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shifts (id),
  delivery_id uuid not null references public.deliveries (id),
  amount_kop bigint not null,
  reason text not null,
  created_at timestamptz not null default now()
);
create index cash_adjustments_shift on public.cash_adjustments (shift_id);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.deliveries (id) on delete cascade,
  sender_id uuid not null references public.senders (user_id),
  seq integer not null check (seq >= 1),
  event_type public.event_type not null,
  payload jsonb not null,
  status public.notification_status not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_delivery_seq unique (delivery_id, seq),
  constraint notifications_delivered_consistent check ((status = 'delivered') = (delivered_at is not null))
);
create index notifications_due on public.notifications (next_attempt_at) where status = 'pending';
create index notifications_sender_created on public.notifications (sender_id, created_at desc, id);
create index notifications_delivery_pending on public.notifications (delivery_id, seq) where status = 'pending';

create table public.notification_attempts (
  id bigint generated always as identity primary key,
  notification_id uuid not null references public.notifications (id) on delete cascade,
  attempted_at timestamptz not null default now(),
  http_status integer,
  error text,
  duration_ms integer,
  manual boolean not null default false
);
create index notification_attempts_notification on public.notification_attempts (notification_id, id);
