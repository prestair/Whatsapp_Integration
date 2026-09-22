-- Supabase Storage bucket for message images (sheet monitor + manual send).
-- Run this in the Supabase SQL Editor AFTER policies_auth.sql.
-- Creates a private bucket 'message-images' and RLS policies so only
-- authenticated (logged-in) dashboard users can upload/read, and the local
-- worker (service/secret key) can always read regardless of RLS.

insert into storage.buckets (id, name, public)
values ('message-images', 'message-images', false)
on conflict (id) do nothing;

-- Authenticated users can upload images.
drop policy if exists auth_upload_images on storage.objects;
create policy auth_upload_images on storage.objects
  for insert to authenticated
  with check (bucket_id = 'message-images');

-- Authenticated users can read images (so the dashboard can preview them).
drop policy if exists auth_read_images on storage.objects;
create policy auth_read_images on storage.objects
  for select to authenticated
  using (bucket_id = 'message-images');

-- Authenticated users can delete/replace their own uploaded images.
drop policy if exists auth_delete_images on storage.objects;
create policy auth_delete_images on storage.objects
  for delete to authenticated
  using (bucket_id = 'message-images');
