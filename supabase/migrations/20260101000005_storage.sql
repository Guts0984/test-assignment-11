-- Private bucket for delivery photos. Objects are written by apps/api only (service role).
-- Reading is possible through signed URLs: the sender of the delivery and dispatchers may create them.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('delivery-photos', 'delivery-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Path layout: <delivery id>/<photo id>.<ext>
create policy delivery_photos_select on storage.objects for select to authenticated
  using (
    bucket_id = 'delivery-photos'
    and (
      (select auth.jwt()) -> 'app_metadata' ->> 'role' = 'dispatcher'
      or exists (
        select 1 from public.deliveries d
        where d.id::text = (storage.foldername(name))[1] and d.sender_id = (select auth.uid())
      )
    )
  );
-- No insert / update / delete policies: browsers cannot write to the bucket.
