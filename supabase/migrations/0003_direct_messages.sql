-- Private 1-to-1 direct messages.
-- A group message has recipient_id null; a DM has recipient_id set to the
-- other participant's profile id. Group behaviour is unchanged for null.

alter table public.messages
  add column recipient_id uuid references public.profiles (id) on delete cascade;

create index messages_recipient_id_idx on public.messages (recipient_id);

-- A member can read a message only if it is a group message (recipient null)
-- or they are its sender or its recipient.
drop policy if exists "members read messages" on public.messages;
create policy "members read messages" on public.messages
  for select to authenticated
  using (
    (select public.is_member())
    and (
      recipient_id is null
      or user_id = (select auth.uid())
      or recipient_id = (select auth.uid())
    )
  );

-- A member can post only as themselves, to the group (null) or to an
-- existing profile.
drop policy if exists "members post messages" on public.messages;
create policy "members post messages" on public.messages
  for insert to authenticated
  with check (
    (select public.is_member())
    and user_id = (select auth.uid())
    and (
      recipient_id is null
      or exists (select 1 from public.profiles where id = recipient_id)
    )
  );

-- Reactions on a DM are only readable by that DM's participants (checked
-- via the parent message). Group reactions stay readable by all members.
drop policy if exists "members read reactions" on public.reactions;
create policy "members read reactions" on public.reactions
  for select to authenticated
  using (
    (select public.is_member())
    and exists (
      select 1 from public.messages
      where public.messages.id = public.reactions.message_id
        and (
          public.messages.recipient_id is null
          or public.messages.user_id = (select auth.uid())
          or public.messages.recipient_id = (select auth.uid())
        )
    )
  );
