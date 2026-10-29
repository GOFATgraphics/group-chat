-- Personal API keys: a member creates a key for their own account and gives
-- it to an AI agent, which then uses the /api endpoints as that member.
-- Only a SHA-256 hash of each key is stored; the key itself is shown once.

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  key_prefix text not null,                 -- first characters, to recognise a key in the list
  key_hash text not null unique,            -- hex SHA-256 of the full key
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index api_keys_user_id_idx on public.api_keys (user_id);

alter table public.api_keys enable row level security;

-- Members see and manage only their own keys. The server checks a presented
-- key with the service role, which bypasses these policies.
create policy "members read own api keys" on public.api_keys
  for select to authenticated using (user_id = (select auth.uid()));
create policy "members create own api keys" on public.api_keys
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_member()));
create policy "members revoke own api keys" on public.api_keys
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "members delete own api keys" on public.api_keys
  for delete to authenticated using (user_id = (select auth.uid()));

-- Members may only set revoked_at on an existing key, nothing else.
revoke update on public.api_keys from anon, authenticated;
grant update (revoked_at) on public.api_keys to authenticated;

-- Admin helper (SQL editor only): create a key for any member and get it back.
--   select public.create_api_key('adam', 'Adam''s agent');
create or replace function public.create_api_key(p_username text, p_name text default 'AI agent')
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_key text;
begin
  select id into v_user from public.profiles where username = lower(trim(p_username));
  if v_user is null then
    raise exception 'No member named %', p_username;
  end if;
  v_key := 'gck_' || translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  insert into public.api_keys (user_id, name, key_prefix, key_hash)
  values (v_user, p_name, left(v_key, 12), encode(extensions.digest(v_key, 'sha256'), 'hex'));
  return v_key;
end;
$$;

revoke execute on function public.create_api_key(text, text) from public, anon, authenticated;
