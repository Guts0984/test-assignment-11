-- Extensions, private schema and enum types.

create extension if not exists pgcrypto with schema extensions;

-- Internal functions live here. The schema is NOT exposed through PostgREST (config.toml: api.schemas),
-- so nothing in it can be called with an anon/authenticated key through /rest/v1/rpc.
create schema if not exists app_private;
revoke all on schema app_private from public;

create type public.user_role as enum ('sender', 'dispatcher', 'courier');
create type public.zone as enum ('A', 'B', 'C');
create type public.delivery_status as enum (
  'created', 'assigned', 'picked_up', 'delivered',
  'failed_attempt', 'returning', 'returned', 'cancelled'
);
create type public.event_type as enum (
  'created', 'assigned', 'reassigned', 'released', 'cancelled', 'picked_up', 'delivered',
  'failed_attempt', 'returning', 'returned', 'wrong_code', 'handover_blocked', 'handover_unblocked'
);
create type public.photo_kind as enum ('handover', 'failed');
create type public.action_type as enum ('pickup', 'deliver', 'fail');
create type public.action_result as enum ('applied', 'rejected');
create type public.notification_status as enum ('pending', 'delivered');
create type public.assignment_end_reason as enum (
  'reassigned', 'timeout', 'cancelled', 'delivered', 'delivered_by_other', 'failed'
);
