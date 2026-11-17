-- Background jobs. The 45-minute pickup timeout runs every minute inside Postgres.
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'release-stale-assignments',
  '* * * * *',
  $$select app_private.release_stale_assignments()$$
);
