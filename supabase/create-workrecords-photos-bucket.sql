-- New namespaced Storage bucket for this app's work photos, so other apps can
-- share the same Supabase project without colliding (matches the workrecords_
-- table prefix). Run this BEFORE deploying the build whose
-- VITE_SUPABASE_PHOTO_BUCKET=workrecords_photos.
--
-- The bucket is PUBLIC (synced devices show photos by public URL). Safe to run
-- more than once.

-- 1) Create the bucket.
insert into storage.buckets (id, name, public)
values ('workrecords_photos', 'workrecords_photos', true)
on conflict (id) do update set public = true;

-- 2) Allow the app to upload / overwrite / delete / read objects in it.
-- Both roles: operators run as `anon`, the HQ admin (Supabase Auth) as
-- `authenticated`. Missing `authenticated` here silently breaks admin
-- uploads/deletes.
drop policy if exists "wr_photos_anon_insert" on storage.objects;
create policy "wr_photos_anon_insert" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'workrecords_photos');

drop policy if exists "wr_photos_anon_update" on storage.objects;
create policy "wr_photos_anon_update" on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'workrecords_photos') with check (bucket_id = 'workrecords_photos');

drop policy if exists "wr_photos_anon_delete" on storage.objects;
create policy "wr_photos_anon_delete" on storage.objects
  for delete to anon, authenticated
  using (bucket_id = 'workrecords_photos');

drop policy if exists "wr_photos_anon_select" on storage.objects;
create policy "wr_photos_anon_select" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'workrecords_photos');
