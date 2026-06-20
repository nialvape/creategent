-- Storage policies for the public "assets" bucket.
--
-- WHY: The app server (src/lib/supabase/client.ts) prefers SUPABASE_SERVICE_ROLE_KEY
-- but falls back to the anon key when it is unset. RLS on storage.objects then
-- blocks every upload, so audio/video/image assets were never persisted to Storage
-- (0 objects written). Audio in particular had no fallback URL and was saved as
-- "completed" with a null public_url — it showed as successful but was unplayable.
--
-- RECOMMENDED ALTERNATIVE: set SUPABASE_SERVICE_ROLE_KEY in .env.local. The
-- service role bypasses RLS, so you would NOT need these permissive policies.
-- Apply this migration only if you intend to keep using the anon key on the server.
--
-- These policies scope all access to the single MVP bucket named "assets".

drop policy if exists "assets_public_read" on storage.objects;
drop policy if exists "assets_anon_insert" on storage.objects;
drop policy if exists "assets_anon_update" on storage.objects;
drop policy if exists "assets_anon_delete" on storage.objects;

create policy "assets_public_read" on storage.objects
  for select using (bucket_id = 'assets');

create policy "assets_anon_insert" on storage.objects
  for insert with check (bucket_id = 'assets');

create policy "assets_anon_update" on storage.objects
  for update using (bucket_id = 'assets') with check (bucket_id = 'assets');

create policy "assets_anon_delete" on storage.objects
  for delete using (bucket_id = 'assets');
