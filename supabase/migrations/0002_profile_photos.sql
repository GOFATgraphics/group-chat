-- Profile photos. Stored in a public bucket under <user id>/..., resized to a
-- small square by the app before upload.

alter table public.profiles add column avatar_path text;

-- Members may change only their own avatar, nothing else on the profile.
revoke update on public.profiles from anon, authenticated;
grant update (avatar_path) on public.profiles to authenticated;
create policy "members update own profile" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Push avatar changes to everyone who has the chat open.
alter table public.profiles replica identity full;
alter publication supabase_realtime add table public.profiles;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

create policy "members upload own avatar" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (select public.is_member())
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
create policy "members delete own avatar" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and owner_id = (select auth.uid())::text);
