-- Named group chats, besides the one everyone is in.
-- The owner (mubarak) creates them, names them, and chooses who is in them;
-- any member can leave one. A message belongs to at most one of: the main
-- group chat (group_id and recipient_id both null), a private chat
-- (recipient_id), or a named group (group_id). Only a named group's members
-- can read or post in it; the owner can read every group, like every private
-- chat (0004).

create table public.chat_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  created_by uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.chat_group_members (
  group_id uuid not null references public.chat_groups (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index chat_group_members_user_idx on public.chat_group_members (user_id);

alter table public.messages
  add column group_id uuid references public.chat_groups (id) on delete cascade,
  add constraint messages_one_conversation check (group_id is null or recipient_id is null);
create index messages_group_id_idx on public.messages (group_id, id) where group_id is not null;

-- True when the caller is in the named group.
create or replace function public.in_group(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.chat_group_members
    where group_id = p_group and user_id = (select auth.uid())
  );
$$;
revoke execute on function public.in_group(uuid) from public, anon;
grant execute on function public.in_group(uuid) to authenticated;

-- Can the caller read this message? One rule, used by every read policy.
create or replace function public.can_read_message(p_user uuid, p_recipient uuid, p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_owner()
    or (p_group is null and p_recipient is null)
    or (p_group is null and (p_user = (select auth.uid()) or p_recipient = (select auth.uid())))
    or (p_group is not null and public.in_group(p_group));
$$;
revoke execute on function public.can_read_message(uuid, uuid, uuid) from public, anon;
grant execute on function public.can_read_message(uuid, uuid, uuid) to authenticated;

alter table public.chat_groups enable row level security;
alter table public.chat_group_members enable row level security;

create policy "members see their groups" on public.chat_groups
  for select to authenticated
  using ((select public.is_member()) and ((select public.is_owner()) or public.in_group(id)));
create policy "owner creates groups" on public.chat_groups
  for insert to authenticated
  with check ((select public.is_owner()) and created_by = (select auth.uid()));
create policy "owner renames groups" on public.chat_groups
  for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));
create policy "owner deletes groups" on public.chat_groups
  for delete to authenticated
  using ((select public.is_owner()));

create policy "members see group members" on public.chat_group_members
  for select to authenticated
  using ((select public.is_member()) and ((select public.is_owner()) or public.in_group(group_id)));
create policy "owner adds group members" on public.chat_group_members
  for insert to authenticated
  with check ((select public.is_owner()));
create policy "owner removes members, anyone leaves" on public.chat_group_members
  for delete to authenticated
  using ((select public.is_owner()) or user_id = (select auth.uid()));

-- Messages: read with the shared rule; post only where you belong.
drop policy if exists "members read messages" on public.messages;
create policy "members read messages" on public.messages
  for select to authenticated
  using ((select public.is_member()) and public.can_read_message(user_id, recipient_id, group_id));

drop policy if exists "members post messages" on public.messages;
create policy "members post messages" on public.messages
  for insert to authenticated
  with check (
    (select public.is_member())
    and user_id = (select auth.uid())
    and (
      (group_id is null and recipient_id is null)
      or (group_id is null and exists (select 1 from public.profiles where id = recipient_id))
      or (group_id is not null and public.in_group(group_id))
    )
  );

drop policy if exists "members read reactions" on public.reactions;
create policy "members read reactions" on public.reactions
  for select to authenticated
  using (
    (select public.is_member())
    and exists (
      select 1 from public.messages m
      where m.id = public.reactions.message_id
        and public.can_read_message(m.user_id, m.recipient_id, m.group_id)
    )
  );

drop policy if exists "members read reads for readable messages" on public.message_reads;
create policy "members read reads for readable messages" on public.message_reads
  for select to authenticated
  using (
    (select public.is_member())
    and exists (
      select 1 from public.messages m
      where m.id = public.message_reads.message_id
        and public.can_read_message(m.user_id, m.recipient_id, m.group_id)
    )
  );

-- Live updates for the app's chat list.
alter publication supabase_realtime add table public.chat_groups, public.chat_group_members;

-- AI webhooks: a named group's messages go only to its members.
create or replace function public.notify_agent_webhooks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  hook record;
  payload jsonb;
begin
  payload := jsonb_build_object(
    'type', 'message.created',
    'message', jsonb_build_object(
      'id', new.id,
      'conversation', case when new.recipient_id is not null then 'direct' else 'group' end,
      'group_id', new.group_id,
      'group_name', (select name from public.chat_groups where id = new.group_id),
      'user_id', new.user_id,
      'username', (select username from public.profiles where id = new.user_id),
      'recipient_id', new.recipient_id,
      'reply_to_id', new.reply_to_id,
      'content', new.content,
      'attachment_path', new.attachment_path,
      'attachment_name', new.attachment_name,
      'attachment_type', new.attachment_type,
      'attachment_size', new.attachment_size,
      'attachment_duration', new.attachment_duration,
      'call_duration', new.call_duration,
      'kind', case
        when new.call_duration is not null then 'call'
        when new.attachment_type like 'audio/%' then 'voice'
        when new.attachment_type like 'image/%' then 'photo'
        when new.attachment_type like 'video/%' then 'video'
        when new.attachment_path is not null then 'file'
        else 'text'
      end,
      'created_at', new.created_at
    )
  );

  for hook in
    select w.url, w.secret from public.agent_webhooks w
    where w.user_id <> new.user_id
      and (
        (new.group_id is null and (new.recipient_id is null or w.user_id = new.recipient_id))
        or (new.group_id is not null and exists (
          select 1 from public.chat_group_members gm where gm.group_id = new.group_id and gm.user_id = w.user_id
        ))
      )
  loop
    perform net.http_post(
      url := hook.url,
      body := payload,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || hook.secret
      ),
      timeout_milliseconds := 5000
    );
  end loop;
  return new;
end;
$$;

-- Push: tell the sender which group, so it notifies only that group's members.
create or replace function public.notify_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg record;
begin
  select url, secret into cfg from public.push_config where id;
  if cfg.url is null then
    return new;
  end if;
  perform net.http_post(
    url := cfg.url,
    body := jsonb_build_object(
      'type', 'message.created',
      'message', jsonb_build_object(
        'id', new.id,
        'user_id', new.user_id,
        'recipient_id', new.recipient_id,
        'group_id', new.group_id,
        'content', new.content,
        'attachment_name', new.attachment_name,
        'attachment_type', new.attachment_type
      )
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cfg.secret
    ),
    timeout_milliseconds := 5000
  );
  return new;
end;
$$;
