-- Read receipts (ticks): one row per message per reader.
-- Local file only; NOT applied to any live database.
--
-- A read row means "this member loaded this message while viewing the
-- conversation it belongs to". Rows are only ever written by the app for
-- the signed-in member themselves, never for anyone else, and never from
-- the read-only owner view, so the owner viewing a private chat between
-- two other members creates no read row and never changes a sender's
-- ticks. Messages sent before this feature have no read rows, so their
-- ticks correctly stay grey (sent, not read).
--
-- Tick rule (client-side, see src/Chat.jsx): a sender's own message shows
-- grey double ticks until read, blue double ticks once read. In a DM,
-- read means the other participant has a row. In the group chat, read
-- means every other member has a row. Ticks are never shown on other
-- people's messages, and never in owner view.

create table public.message_reads (
  message_id bigint not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index message_reads_message_id_idx on public.message_reads (message_id);

alter table public.message_reads enable row level security;

-- A member may record only their own reads.
create policy "members record own reads" on public.message_reads
  for insert to authenticated
  with check (
    (select public.is_member())
    and user_id = (select auth.uid())
  );

-- A member may read a read row only if they may read its message:
-- a group message, a message they sent or received, or, for the owner,
-- any message (the owner allowance mirrors the 0004 messages policy).
-- This is what lets a sender see who has read their own message, while
-- keeping another member's DM read rows invisible to outsiders.
create policy "members read reads for readable messages" on public.message_reads
  for select to authenticated
  using (
    (select public.is_member())
    and exists (
      select 1 from public.messages
      where public.messages.id = public.message_reads.message_id
        and (
          (select public.is_owner())
          or public.messages.recipient_id is null
          or public.messages.user_id = (select auth.uid())
          or public.messages.recipient_id = (select auth.uid())
        )
    )
  );

-- Deliberately no delete policy: a read row is removed only when its
-- message is deleted (on delete cascade) or its reader's profile is
-- deleted (on delete cascade). Reads are never un-read through the app.
