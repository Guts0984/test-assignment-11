-- Photos are served ONLY through short-lived signed URLs created by apps/api (service role, SIGNED_URL_TTL_SECONDS).
-- The earlier SELECT policy let a sender read their photos directly with their JWT and, worse, mint a signed URL
-- with any lifetime (10 years), which made the API's 5-minute limit meaningless. With no policy at all on
-- storage.objects, no browser key (anon or authenticated) can read, list, sign, write or delete anything in the bucket.
drop policy if exists delivery_photos_select on storage.objects;
