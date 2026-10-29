-- Group-owner view: the owner (username 'mubarak') can read any private
-- chat between any two members, without joining it or impersonating anyone.
-- Local file only; apply it to Supabase separately before the app change
-- goes live, otherwise the owner query is still blocked by the 0003 policies.
--
-- READ-ONLY for the owner at the database level in the sense that matters
-- for someone else's DM: the insert and delete policies are deliberately
-- NOT changed here. Messages insert still requires user_id = auth.uid(),
-- so the owner can only ever post as themselves (a DM with the owner as a
-- participant, never into a pair they are not part of). Messages delete
-- still allows authors to delete only their own messages. The app also
-- hides the composer, reactions, and delete controls in owner view, so the
-- owner cannot send, react, or delete there through the app.
--
-- Known gap, left as-is per the brief (insert policies unchanged): the
-- pre-existing reactions insert policy checks only that the reactor is a
-- member posting as themselves; it does not check that the reactor is a
-- participant in the parent message. That predates this migration and is
-- not widened by it, but a direct API call, as opposed to the app, is not
-- blocked by it either. See the report for the follow-up if that matters.

-- True when the caller is the group owner, by username, not by UUID, so
-- the owner stays the owner even if their auth id ever changes.
create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and username = 'mubarak'
  );
$$;

revoke execute on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated;

-- Messages read: members keep the 0003 rule, and the owner may read any
-- message, group or DM, including pairs they are not part of.
drop policy if exists "members read messages" on public.messages;
create policy "members read messages" on public.messages
  for select to authenticated
  using (
    (select public.is_member())
    and (
      (select public.is_owner())
      or recipient_id is null
      or user_id = (select auth.uid())
      or recipient_id = (select auth.uid())
    )
  );

-- Reactions read: same owner allowance, checked via the parent message,
-- so the owner can see reactions on a DM they are only viewing.
drop policy if exists "members read reactions" on public.reactions;
create policy "members read reactions" on public.reactions
  for select to authenticated
  using (
    (select public.is_member())
    and (
      (select public.is_owner())
      or exists (
        select 1 from public.messages
        where public.messages.id = public.reactions.message_id
          and (
            public.messages.recipient_id is null
            or public.messages.user_id = (select auth.uid())
            or public.messages.recipient_id = (select auth.uid())
          )
      )
    )
  );

-- Deliberately untouched: "members post messages" (insert) and
-- "authors delete own messages" (delete) on messages, and "members add
-- reactions" / "members remove own reactions" on reactions.
