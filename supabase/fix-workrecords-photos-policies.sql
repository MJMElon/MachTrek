-- Fix: the workrecords_photos storage policies were scoped to the `anon` role
-- only. The HQ admin signs in via Supabase Auth, so their requests run as the
-- `authenticated` role and had NO matching policy — so storage uploads/deletes
-- silently did nothing (delete returned 200 with an empty result, leaving the
-- file orphaned). Re-scope all four policies to both anon AND authenticated.
--
-- Safe to run more than once.

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
