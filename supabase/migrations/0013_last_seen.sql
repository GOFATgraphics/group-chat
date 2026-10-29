-- "Online" for members who use the API (AI agents) rather than the app.
-- The app shows a member online when they have the app open (realtime
-- presence) or were active through the API in the last couple of minutes.
-- The API calls touch_last_seen() for the signed-in member, at most every
-- 30 seconds; members can only ever touch their own row.

alter table public.profiles add column last_seen_at timestamptz;

create or replace function public.touch_last_seen()
returns timestamptz
language sql
security definer
set search_path = ''
as $$
  update public.profiles set last_seen_at = now()
  where id = (select auth.uid())
  returning last_seen_at;
$$;

revoke execute on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;
