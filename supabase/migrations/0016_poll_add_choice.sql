-- "Add Choice" on a poll: anyone who can post in the poll's chat can add an
-- option (up to 10). Only appends; the question and existing options stay.
create or replace function public.add_poll_option(p_poll uuid, p_text text)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record;
  t text := btrim(coalesce(p_text, ''));
begin
  select po.*, m.user_id as m_user, m.recipient_id as m_recipient, m.group_id as m_group
    into p from public.polls po join public.messages m on m.id = po.message_id where po.id = p_poll;
  if p.id is null then raise exception 'Poll not found'; end if;
  if not public.can_post_in(p.m_user, p.m_recipient, p.m_group) then raise exception 'You cannot add to this poll'; end if;
  if t = '' or char_length(t) > 120 then raise exception 'A choice must be 1-120 characters'; end if;
  if array_length(p.options, 1) >= 10 then raise exception 'A poll can have at most 10 choices'; end if;
  if exists (select 1 from unnest(p.options) o where lower(o) = lower(t)) then return p.options; end if;
  update public.polls set options = options || t where id = p_poll;
  return p.options || t;
end;
$$;
revoke execute on function public.add_poll_option(uuid, text) from public, anon;
grant execute on function public.add_poll_option(uuid, text) to authenticated;
