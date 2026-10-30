-- Multiple attachments on one message, up to 5, in order.
-- The legacy messages.attachment_* columns are kept as the first
-- attachment, so old app versions and old API clients keep working.
-- This migration does NOT change the 4000-character content check.

create table public.message_attachments (
  id bigint generated always as identity primary key,
  message_id bigint not null references public.messages (id) on delete cascade,
  position int not null default 0 check (position >= 0 and position < 5),
  attachment_path text not null,
  attachment_name text,
  attachment_type text,
  attachment_size bigint,
  attachment_duration numeric,
  unique (message_id, position)
);
create index message_attachments_message_idx on public.message_attachments (message_id, position);

alter table public.message_attachments enable row level security;

-- Read an attachment only where you can read its message (0014).
create policy "read attachments where you can read the message" on public.message_attachments
  for select to authenticated
  using (exists (
    select 1 from public.messages m
    where m.id = message_id
      and public.can_read_message(m.user_id, m.recipient_id, m.group_id)
  ));

-- Add attachments only to your own message, where you can post (0015).
create policy "add attachments to your own message" on public.message_attachments
  for insert to authenticated
  with check (exists (
    select 1 from public.messages m
    where m.id = message_id
      and m.user_id = (select auth.uid())
      and public.can_post_in(m.user_id, m.recipient_id, m.group_id)
  ));

-- Remove attachments only from your own message.
create policy "remove attachments from your own message" on public.message_attachments
  for delete to authenticated
  using (exists (
    select 1 from public.messages m
    where m.id = message_id
      and m.user_id = (select auth.uid())
  ));

alter publication supabase_realtime add table public.message_attachments;
