-- Row Level Security. Browsers get SELECT only, and only on what they own; every write goes through apps/api.
-- Role comes from app_metadata (writable only with the service role), never from user_metadata.

-- 1. Strip every default privilege Supabase grants to anon/authenticated on new tables.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- 2. RLS on every table (no policy = no access, e.g. delivery_secrets, idempotency_keys).
alter table public.profiles enable row level security;
alter table public.senders enable row level security;
alter table public.sender_webhooks enable row level security;
alter table public.couriers enable row level security;
alter table public.delivery_number_counter enable row level security;
alter table public.shifts enable row level security;
alter table public.deliveries enable row level security;
alter table public.delivery_secrets enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.assignments enable row level security;
alter table public.delivery_events enable row level security;
alter table public.courier_actions enable row level security;
alter table public.photos enable row level security;
alter table public.cash_adjustments enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_attempts enable row level security;

-- 3. SELECT grants for the authenticated role, narrowed by the policies below.
grant select on public.profiles, public.senders, public.sender_webhooks, public.couriers, public.shifts,
  public.deliveries, public.assignments, public.delivery_events, public.courier_actions, public.photos,
  public.cash_adjustments, public.notifications, public.notification_attempts
  to authenticated;

-- (select auth.uid()) / (select auth.jwt()) are evaluated once per statement instead of once per row.
create policy profiles_select on public.profiles for select to authenticated
  using (user_id = (select auth.uid()) or (select auth.jwt()) -> 'app_metadata' ->> 'role' = 'dispatcher');

create policy senders_select on public.senders for select to authenticated
  using (user_id = (select auth.uid()) or (select auth.jwt()) -> 'app_metadata' ->> 'role' = 'dispatcher');

-- the signing secret: only its owner
create policy sender_webhooks_select on public.sender_webhooks for select to authenticated
  using (sender_id = (select auth.uid()));

create policy couriers_select on public.couriers for select to authenticated
  using (user_id = (select auth.uid()) or (select auth.jwt()) -> 'app_metadata' ->> 'role' = 'dispatcher');

create policy shifts_select on public.shifts for select to authenticated
  using (courier_id = (select auth.uid()) or (select auth.jwt()) -> 'app_metadata' ->> 'role' = 'dispatcher');

create policy deliveries_select on public.deliveries for select to authenticated
  using (
    sender_id = (select auth.uid())
    or courier_id = (select auth.uid())
    or (select auth.jwt()) -> 'app_metadata' ->> 'role' = 'dispatcher'
  );

-- Courier sees own assignments, including ended ones: that is how a courier learns a delivery was taken away.
create policy assignments_select on public.assignments for select to authenticated
  using (courier_id = (select auth.uid()) or (select auth.jwt()) -> 'app_metadata' ->> 'role' = 'dispatcher');

create policy delivery_events_select on public.delivery_events for select to authenticated
  using (
    (select auth.jwt()) -> 'app_metadata' ->> 'role' = 'dispatcher'
    or exists (
      select 1 from public.deliveries d
      where d.id = delivery_events.delivery_id
        and (d.sender_id = (select auth.uid()) or d.courier_id = (select auth.uid()))
    )
  );

create policy courier_actions_select on public.courier_actions for select to authenticated
  using (courier_id = (select auth.uid()) or (select auth.jwt()) -> 'app_metadata' ->> 'role' = 'dispatcher');

create policy photos_select on public.photos for select to authenticated
  using (
    courier_id = (select auth.uid())
    or (select auth.jwt()) -> 'app_metadata' ->> 'role' = 'dispatcher'
    or exists (select 1 from public.deliveries d where d.id = photos.delivery_id and d.sender_id = (select auth.uid()))
  );

create policy cash_adjustments_select on public.cash_adjustments for select to authenticated
  using ((select auth.jwt()) -> 'app_metadata' ->> 'role' = 'dispatcher');

create policy notifications_select on public.notifications for select to authenticated
  using (sender_id = (select auth.uid()));

create policy notification_attempts_select on public.notification_attempts for select to authenticated
  using (exists (
    select 1 from public.notifications n
    where n.id = notification_attempts.notification_id and n.sender_id = (select auth.uid())
  ));

-- 4. Realtime: postgres_changes honours the SELECT policies above.
alter publication supabase_realtime add table
  public.deliveries, public.assignments, public.shifts, public.courier_actions;
