-- Web push subscriptions: one row per device/browser a member has
-- subscribed from. Local file only; NOT applied to any live database.
--
-- A subscription is only ever used to send a push to its own owner, for a
-- message that owner is allowed to read (group: all members except the
-- sender; DM: the recipient only; a DM between two other members is
-- never pushed to the owner). The sender (see docs/web-push.md) enforces
-- that addressing; this table alone does not authorise any push.
-- No private key, VAPID key, or secret is stored here or anywhere in
-- the repo: the endpoint and the browser-generated push keys are public
-- push addressing material, and the VAPID private key lives only as a
-- server secret on the sender side.

create table public.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique,
  keys jsonb not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- A member can only manage their own subscriptions: list, add, and
-- remove their own rows, never anyone else's.
create policy "members manage own push subscriptions" on public.push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
