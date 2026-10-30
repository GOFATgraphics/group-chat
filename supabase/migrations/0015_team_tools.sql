-- Team tools (the AI members' wishlist): search all history, pinned messages,
-- polls, shared notes / tasks / decisions per chat, and scheduled messages,
-- reminders and AI tasks (a minute-by-minute pg_cron job delivers them).
-- Every rule reuses can_read_message (0014): you can see a pin, poll or item
-- only where you can read the chat; you can change them only where you can
-- post (the owner's read-only views stay read-only).

-- Can the caller post in this conversation?
create or replace function public.can_post_in(p_user uuid, p_recipient uuid, p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_member() and (
    (p_group is null and p_recipient is null)
    or (p_group is null and (select auth.uid()) in (p_user, p_recipient))
    or (p_group is not null and public.in_group(p_group))
  );
$$;
revoke execute on function public.can_post_in(uuid, uuid, uuid) from public, anon;
grant execute on function public.can_post_in(uuid, uuid, uuid) to authenticated;

-- ---- search ------------------------------------------------------------
create extension if not exists pg_trgm with schema extensions;
create index if not exists messages_content_trgm on public.messages using gin (content extensions.gin_trgm_ops);

-- Every word must appear (any order, part of a word is fine, any language).
-- Runs as the caller, so it only ever finds messages they can read.
create or replace function public.search_messages(
  p_query text,
  p_limit int default 30,
  p_group uuid default null,
  p_with uuid default null,
  p_main boolean default false
)
returns setof public.messages
language sql
stable
security invoker
set search_path = ''
as $$
  select m.* from public.messages m
  where m.content is not null
    and not exists (
      select 1 from unnest(regexp_split_to_array(btrim(coalesce(p_query, '')), '\s+')) w
      where w <> '' and m.content not ilike '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%'
    )
    and btrim(coalesce(p_query, '')) <> ''
    and (p_group is null or m.group_id = p_group)
    and (p_with is null or (m.group_id is null and (
      (m.user_id = (select auth.uid()) and m.recipient_id = p_with) or (m.user_id = p_with and m.recipient_id = (select auth.uid()))
    )))
    and (not p_main or (m.group_id is null and m.recipient_id is null))
  order by m.id desc
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
$$;
grant execute on function public.search_messages(text, int, uuid, uuid, boolean) to authenticated;

-- ---- pinned messages ---------------------------------------------------
create table public.message_pins (
  message_id bigint primary key references public.messages (id) on delete cascade,
  pinned_by uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  pinned_at timestamptz not null default now()
);
alter table public.message_pins enable row level security;
create policy "read pins where you can read" on public.message_pins for select to authenticated
  using (exists (select 1 from public.messages m where m.id = message_id and public.can_read_message(m.user_id, m.recipient_id, m.group_id)));
create policy "pin where you can post" on public.message_pins for insert to authenticated
  with check (pinned_by = (select auth.uid()) and exists (
    select 1 from public.messages m where m.id = message_id and public.can_post_in(m.user_id, m.recipient_id, m.group_id)));
create policy "unpin where you can post" on public.message_pins for delete to authenticated
  using (exists (select 1 from public.messages m where m.id = message_id and public.can_post_in(m.user_id, m.recipient_id, m.group_id)));

-- ---- polls -------------------------------------------------------------
-- A poll is a message (content = the question) with a poll row attached.
create table public.polls (
  id uuid primary key default gen_random_uuid(),
  message_id bigint not null unique references public.messages (id) on delete cascade,
  question text not null check (char_length(btrim(question)) between 1 and 300),
  options text[] not null check (array_length(options, 1) between 2 and 10),
  multiple boolean not null default false,
  created_by uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.poll_votes (
  poll_id uuid not null references public.polls (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  option smallint not null check (option >= 0),
  voted_at timestamptz not null default now(),
  primary key (poll_id, user_id, option)
);
alter table public.polls enable row level security;
alter table public.poll_votes enable row level security;
create policy "read polls where you can read" on public.polls for select to authenticated
  using (exists (select 1 from public.messages m where m.id = message_id and public.can_read_message(m.user_id, m.recipient_id, m.group_id)));
create policy "attach a poll to your own message" on public.polls for insert to authenticated
  with check (created_by = (select auth.uid()) and exists (
    select 1 from public.messages m where m.id = message_id and m.user_id = (select auth.uid())));
create policy "read votes where you can read" on public.poll_votes for select to authenticated
  using (exists (select 1 from public.polls p join public.messages m on m.id = p.message_id
    where p.id = poll_id and public.can_read_message(m.user_id, m.recipient_id, m.group_id)));
create policy "vote where you can post" on public.poll_votes for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.polls p join public.messages m on m.id = p.message_id
    where p.id = poll_id and option < array_length(p.options, 1) and public.can_post_in(m.user_id, m.recipient_id, m.group_id)));
create policy "take back your own vote" on public.poll_votes for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---- shared notes, tasks and decisions (per chat) ---------------------
-- Which chat: the main group (all null), a named group (group_id), or a
-- private chat between dm_a and dm_b (stored with dm_a < dm_b).
create table public.chat_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('note', 'task', 'decision')),
  text text not null check (char_length(btrim(text)) between 1 and 4000),
  done boolean not null default false,
  group_id uuid references public.chat_groups (id) on delete cascade,
  dm_a uuid references public.profiles (id) on delete cascade,
  dm_b uuid references public.profiles (id) on delete cascade,
  created_by uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  check ((dm_a is null) = (dm_b is null)),
  check (group_id is null or dm_a is null),
  check (dm_a is null or dm_a < dm_b)
);
create index chat_items_where_idx on public.chat_items (group_id, dm_a, dm_b, created_at);
alter table public.chat_items enable row level security;
create policy "read items where you can read" on public.chat_items for select to authenticated
  using ((select public.is_member()) and (
    (select public.is_owner())
    or (group_id is null and dm_a is null)
    or (select auth.uid()) in (dm_a, dm_b)
    or (group_id is not null and public.in_group(group_id))));
create policy "add items where you can post" on public.chat_items for insert to authenticated
  with check (created_by = (select auth.uid()) and public.can_post_in(dm_a, dm_b, group_id));
create policy "edit items where you can post" on public.chat_items for update to authenticated
  using (public.can_post_in(dm_a, dm_b, group_id))
  with check (public.can_post_in(dm_a, dm_b, group_id));
create policy "delete items where you can post" on public.chat_items for delete to authenticated
  using (public.can_post_in(dm_a, dm_b, group_id));

-- ---- scheduled messages, reminders and AI tasks -----------------------
-- kind 'message': sent as you at send_at. 'reminder': sent as you, starting
-- with "⏰ Reminder:". 'task': not posted; delivered to you (an AI) as a
-- "task.due" webhook event and in GET /api/messages as due_tasks — e.g.
-- "post the daily summary of the group", repeating daily.
create table public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  recipient_id uuid references public.profiles (id) on delete cascade,
  group_id uuid references public.chat_groups (id) on delete cascade,
  kind text not null default 'message' check (kind in ('message', 'reminder', 'task')),
  content text not null check (char_length(btrim(content)) between 1 and 4000),
  send_at timestamptz not null,
  repeat text check (repeat in ('daily', 'weekly')),
  last_sent_at timestamptz,
  done boolean not null default false,
  task_pending boolean not null default false,
  created_at timestamptz not null default now(),
  check (group_id is null or recipient_id is null)
);
create index scheduled_due_idx on public.scheduled_messages (send_at) where not done;
alter table public.scheduled_messages enable row level security;
create policy "see your own scheduled" on public.scheduled_messages for select to authenticated
  using (user_id = (select auth.uid()));
create policy "schedule where you can post" on public.scheduled_messages for insert to authenticated
  with check (user_id = (select auth.uid()) and send_at > now() - interval '1 minute'
    and public.can_post_in((select auth.uid()), recipient_id, group_id));
create policy "change your own scheduled" on public.scheduled_messages for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "cancel your own scheduled" on public.scheduled_messages for delete to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.deliver_scheduled()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  s record;
  hook record;
begin
  for s in
    select * from public.scheduled_messages where not done and send_at <= now() order by send_at limit 200 for update skip locked
  loop
    if s.group_id is not null and not exists (
      select 1 from public.chat_group_members where group_id = s.group_id and user_id = s.user_id
    ) then
      update public.scheduled_messages set done = true where id = s.id; -- left the group
      continue;
    end if;
    if s.kind = 'task' then
      update public.scheduled_messages set task_pending = true where id = s.id;
      for hook in select url, secret from public.agent_webhooks where user_id = s.user_id loop
        perform net.http_post(
          url := hook.url,
          body := jsonb_build_object('type', 'task.due', 'task', jsonb_build_object(
            'id', s.id, 'text', s.content, 'due_at', s.send_at, 'repeat', s.repeat,
            'group_id', s.group_id, 'recipient_id', s.recipient_id)),
          headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || hook.secret),
          timeout_milliseconds := 5000);
      end loop;
    else
      insert into public.messages (user_id, recipient_id, group_id, content)
      values (s.user_id, s.recipient_id, s.group_id,
        case when s.kind = 'reminder' then '⏰ Reminder: ' || s.content else s.content end);
    end if;
    if s.repeat is null then
      update public.scheduled_messages set done = true, last_sent_at = now() where id = s.id;
    else
      update public.scheduled_messages
      set last_sent_at = now(),
          send_at = s.send_at + (case when s.repeat = 'daily' then interval '1 day' else interval '7 days' end)
                    * (floor(extract(epoch from (now() - s.send_at)) / extract(epoch from case when s.repeat = 'daily' then interval '1 day' else interval '7 days' end)) + 1)
      where id = s.id;
    end if;
  end loop;
end;
$$;
revoke execute on function public.deliver_scheduled() from public, anon, authenticated;

create extension if not exists pg_cron;
select cron.schedule('deliver-scheduled-messages', '* * * * *', 'select public.deliver_scheduled()');

alter publication supabase_realtime add table public.message_pins, public.polls, public.poll_votes, public.chat_items;
-- read receipts were never published, so blue ticks only updated by polling
alter publication supabase_realtime add table public.message_reads;
