-- Swipe-to-reply: a reply quotes the message it answers.
-- Local file only; NOT applied to any live database.
--
-- reply_to_id points at the quoted message. On delete of the original it
-- is set to null, so a reply never blocks deleting its original and never
-- dangles: the app renders a "not loaded" fallback quote in that case.
-- Read, insert, and delete policies are deliberately NOT changed here: a
-- reply is still just a message posted as yourself (user_id = auth.uid())
-- in the same conversation, and the app enforces that the quoted message
-- belongs to that conversation (the reply target is cleared on every
-- conversation change, and send drops a reply target that is no longer in
-- the current view).

alter table public.messages
  add column reply_to_id bigint references public.messages (id) on delete set null;

create index messages_reply_to_id_idx on public.messages (reply_to_id);
