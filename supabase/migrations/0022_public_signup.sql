-- Public self-registration: a visitor signs up with email, password and
-- confirm password; the admin does NOT create users. (Ahmad, 8 Nov 2026.)
-- Local file only; apply it to Supabase separately before the app change
-- goes live.
--
-- Email confirmation is OFF in Supabase Auth for v1, so signUp returns a
-- session immediately and the new user lands straight in the chat. If
-- confirmation is ever turned ON, signUp returns no session and the app
-- shows a "check your email" screen; the profile below is still created
-- at signup time, so the confirmed user never sees "No access".
--
-- Supabase Auth settings this file assumes (verify and record in the PR):
-- * "Allow new users to sign up" is ON (the README previously recommended
--   OFF — that instruction is reversed by this change).
-- * "Confirm email" is OFF for v1.
--
-- OPEN: migration 0017 is missing from this repo (0016 -> 0018) and its
-- live status is UNKNOWN. Verify against the live database whether 0017
-- was applied there or never existed, before running this file live.
-- This file does not depend on 0017.

-- 1. Username derivation. The signup form has no username field, but
-- profiles.username is required and unique (^[a-z0-9_.-]{2,32}$), so the
-- username is derived from the email's local part.
create or replace function public.derive_username(p_email text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := lower(trim(split_part(p_email, '@', 1)));
begin
  v := regexp_replace(v, '[^a-z0-9_.-]', '_', 'g');
  v := left(v, 32);
  if v = '' then
    v := 'user';
  end if;
  return v;
end; $$;

-- 2. Profile creation for one auth user, with de-duplication. Shared by
-- the signup trigger and the backfill below so both take the same path.
-- Reserved names can never be claimed by signup: the admin (mubarak),
-- the AI members, and generic names.
create or replace function public.ensure_profile(p_id uuid, p_email text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base text := public.derive_username(p_email);
  v_name text := v_base;
  v_n int := 2;
  v_tries int := 0;
begin
  if v_name in ('mubarak', 'adam', 'ali', 'gauri', 'anurag', 'admin', 'support', 'system', 'bot') then
    v_name := v_base || '_user';
  end if;
  while exists (select 1 from public.profiles where username = v_name) loop
    v_tries := v_tries + 1;
    if v_tries > 100 then
      -- Last resort: never fail signup on a username race.
      v_name := left(v_base, 20) || '-' || substr(gen_random_uuid()::text, 1, 8);
      exit;
    end if;
    v_name := left(v_base || '-' || v_n::text, 32);
    v_n := v_n + 1;
  end loop;
  insert into public.profiles (id, username)
  values (p_id, v_name)
  on conflict (id) do nothing;
  return v_name;
exception when unique_violation then
  insert into public.profiles (id, username)
  values (p_id, left(v_base, 20) || '-' || substr(gen_random_uuid()::text, 1, 8))
  on conflict (id) do nothing;
  return v_name;
end; $$;

-- 3. Profile auto-creation on signup. Atomic with signup and impossible
-- for the client to skip: without it a signed-up user has an auth.users
-- row and no profiles row, and lands on the "No access" card. The trigger
-- runs as SECURITY DEFINER because profiles has no INSERT policy for
-- authenticated users — that is deliberate, so a signed-up user can never
-- create a second profile or choose their own username, and can never set
-- is_ai (it stays NOT NULL DEFAULT false; only SQL/admin sets it for bots).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.ensure_profile(new.id, new.email);
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4. Backfill profiles for any existing auth.users row without one.
-- Safety net only: the 8 live users already have profiles via
-- create_chat_user, so this should insert 0 rows — verify the count
-- when running it live.
do $$
declare
  r record;
begin
  for r in
    select u.id, u.email from auth.users u
    where not exists (select 1 from public.profiles p where p.id = u.id)
  loop
    perform public.ensure_profile(r.id, r.email);
  end loop;
end $$;

-- 5. No INSERT policy on profiles for authenticated users, by design.
-- Profile creation happens only in the trigger above. A client-side
-- insert must keep failing — that is what stops a signed-up user from
-- creating a second profile or choosing their own username.
-- (The existing UPDATE policy still allows only avatar_path; verify it
-- still holds after this migration and record it in the PR.)
