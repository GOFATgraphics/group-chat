-- Group chat schema: members, messages, reactions, file storage.
-- Users are created by an admin with public.create_chat_user(); there is no self sign-up.

create extension if not exists pgcrypto with schema extensions;

-- Members ------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_.-]{2,32}$'),
  created_at timestamptz not null default now()
);

-- True when the caller is a chat member (an auth user that has a profile).
-- Blocks anyone who signs up through the API without being added by an admin.
create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()));
$$;

-- Messages -----------------------------------------------------------------
create table public.messages (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  content text check (char_length(content) <= 4000),
  attachment_path text,
  attachment_name text,
  attachment_type text,
  attachment_size bigint,
  created_at timestamptz not null default now(),
  constraint message_not_empty check (
    coalesce(char_length(trim(content)), 0) > 0 or attachment_path is not null
  )
);
create index messages_created_at_idx on public.messages (created_at desc);
create index messages_user_id_idx on public.messages (user_id);

-- Reactions ----------------------------------------------------------------
create table public.reactions (
  message_id bigint not null references public.messages (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index reactions_user_id_idx on public.reactions (user_id);

-- Row level security -------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.messages enable row level security;
alter table public.reactions enable row level security;

create policy "members read profiles" on public.profiles
  for select to authenticated using ((select public.is_member()));

create policy "members read messages" on public.messages
  for select to authenticated using ((select public.is_member()));
create policy "members post messages" on public.messages
  for insert to authenticated
  with check ((select public.is_member()) and user_id = (select auth.uid()));
create policy "authors delete own messages" on public.messages
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "members read reactions" on public.reactions
  for select to authenticated using ((select public.is_member()));
create policy "members add reactions" on public.reactions
  for insert to authenticated
  with check ((select public.is_member()) and user_id = (select auth.uid()));
create policy "members remove own reactions" on public.reactions
  for delete to authenticated using (user_id = (select auth.uid()));

-- Realtime -----------------------------------------------------------------
alter table public.reactions replica identity full;
alter table public.messages replica identity full;
alter publication supabase_realtime add table public.messages, public.reactions;

-- File storage -------------------------------------------------------------
-- Private bucket; the app shows files through short-lived signed URLs.
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-files', 'chat-files', false, 26214400) -- 25 MB
on conflict (id) do nothing;

create policy "members read chat files" on storage.objects
  for select to authenticated
  using (bucket_id = 'chat-files' and (select public.is_member()));
create policy "members upload to own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-files'
    and (select public.is_member())
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
create policy "members delete own files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'chat-files' and owner_id = (select auth.uid())::text);

-- Admin helpers (SQL editor only; not callable from the app) ----------------
-- Usernames are turned into an internal email, <username>@chat.local, because
-- Supabase Auth signs in with email. The app does the same mapping on login.
create or replace function public.create_chat_user(p_username text, p_password text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_username text := lower(trim(p_username));
  v_email text := v_username || '@chat.local';
  v_id uuid := gen_random_uuid();
begin
  if char_length(p_password) < 6 then
    raise exception 'Password must be at least 6 characters';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
    v_email, extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', jsonb_build_object('username', v_username),
    now(), now(), '', '', '', ''
  );

  insert into auth.identities (
    id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), v_id, v_id::text,
    jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
    'email', now(), now(), now()
  );

  insert into public.profiles (id, username) values (v_id, v_username);
  return v_id;
end;
$$;

create or replace function public.set_chat_user_password(p_username text, p_password text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if char_length(p_password) < 6 then
    raise exception 'Password must be at least 6 characters';
  end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
         updated_at = now()
   where email = lower(trim(p_username)) || '@chat.local';
  if not found then
    raise exception 'No user named %', p_username;
  end if;
end;
$$;

create or replace function public.delete_chat_user(p_username text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from auth.users where email = lower(trim(p_username)) || '@chat.local';
  if not found then
    raise exception 'No user named %', p_username;
  end if;
end;
$$;

revoke execute on function public.create_chat_user(text, text) from public, anon, authenticated;
revoke execute on function public.set_chat_user_password(text, text) from public, anon, authenticated;
revoke execute on function public.delete_chat_user(text) from public, anon, authenticated;
revoke execute on function public.is_member() from public, anon;
grant execute on function public.is_member() to authenticated;
