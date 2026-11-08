-- AI agent requests: a member asks Mubarak (the owner) for an AI agent;
-- Mubarak approves and assigns one, or rejects with a reason.
-- Local file only; apply it to Supabase separately before the app change
-- goes live, otherwise the new screens have no table to read.
--
-- Decisions (see the SPEC, workspace/group-chat-ai-agent-request-SPEC.md):
-- * An approved AI chat is a normal 1-to-1 DM (messages.recipient_id);
--   no new conversation type.
-- * Users may hold approved requests for MORE than one AI agent at a time
--   (Ahmad, 8 Nov 2026 — this reverses the SPEC v1/v2 "one active agent
--   per user" rule). What is blocked is a second pending/approved request
--   for the SAME agent: the effective agent is the assigned agent once
--   chosen, else the preferred agent, else "let Mubarak choose".
-- * Approval sends Mubarak's welcome message to the requester as a DM
--   from Mubarak himself (trigger below), naming the assigned agent.
-- * No new server route: reads/writes go through the Supabase client
--   under RLS, as Chat.jsx already does for messages/profiles.
--
-- OPEN: migration 0017 is missing from this repo (0016 -> 0018) and its
-- live status is UNKNOWN. Verify against the live database whether 0017
-- was applied there or never existed, before running this file live.
-- This file does not depend on 0017, but the numbering gap must be
-- recorded, not silently skipped.

create table public.agent_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references public.profiles (id) on delete cascade,
  preferred_agent_id uuid references public.profiles (id) on delete set null,
  assigned_agent_id uuid references public.profiles (id) on delete set null,
  message text check (char_length(message) <= 280),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  rejection_reason text check (char_length(rejection_reason) <= 280),
  decided_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index agent_requests_requested_by_idx on public.agent_requests (requested_by);
create index agent_requests_status_idx on public.agent_requests (status);

-- One active request per (user, effective agent). NULLs are distinct in a
-- unique index, so the "let Mubarak choose" case is coalesced to the zero
-- UUID to make it a single bucket.
create unique index agent_requests_one_active_per_agent
  on public.agent_requests (
    requested_by,
    coalesce(assigned_agent_id, preferred_agent_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status in ('pending', 'approved');

-- Backfill first — BEFORE the validate trigger below is created, because
-- the trigger only allows new rows to start as pending and these rows are
-- already approved. Preserves every existing human <-> AI DM (today
-- Adam/Ali are freely DM-able): without this the gate below would lock
-- existing users out of chats they already have. decided_by is set to
-- the requester here only as a backfill marker — no human approved those
-- rows.
insert into public.agent_requests (requested_by, assigned_agent_id, status, decided_by, decided_at)
select distinct m.user_id, m.recipient_id, 'approved', m.user_id, now()
from public.messages m
join public.profiles p on p.id = m.recipient_id
where p.is_ai = true
  and m.user_id <> m.recipient_id
  and not exists (
    select 1 from public.agent_requests r
    where r.requested_by = m.user_id and r.assigned_agent_id = m.recipient_id
  );

-- Rule checks that need a subquery (Postgres CHECK cannot do one), plus
-- the status machine. Runs as SECURITY DEFINER so it sees profiles
-- regardless of the caller's RLS.
create or replace function public.validate_agent_request_agents()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_effective uuid;
begin
  if new.preferred_agent_id is not null and not exists (
    select 1 from public.profiles where id = new.preferred_agent_id and is_ai
  ) then
    raise exception 'preferred agent must be an AI member';
  end if;
  if new.assigned_agent_id is not null and not exists (
    select 1 from public.profiles where id = new.assigned_agent_id and is_ai
  ) then
    raise exception 'assigned agent must be an AI member';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'a new request starts as pending';
    end if;
    if new.decided_by is not null or new.decided_at is not null then
      raise exception 'a new request cannot already be decided';
    end if;
  else
    if old.status = 'rejected' then
      raise exception 'a rejected request cannot be changed; make a new request';
    end if;
    if old.status = 'pending' and new.status not in ('approved', 'rejected') then
      raise exception 'a pending request can only be approved or rejected';
    end if;
    if old.status = 'approved' and new.status <> 'approved' then
      raise exception 'an approved request cannot be un-approved';
    end if;
    if old.status = 'approved' and new.status = 'approved'
      and new.assigned_agent_id is distinct from old.assigned_agent_id
      and (new.requested_by is distinct from old.requested_by
        or new.preferred_agent_id is distinct from old.preferred_agent_id
        or new.message is distinct from old.message
        or new.rejection_reason is distinct from old.rejection_reason) then
      raise exception 'an approved request can only change its assigned agent';
    end if;
    if new.status <> 'pending' and (new.decided_by is null or new.decided_at is null) then
      raise exception 'a decided request needs decided_by and decided_at';
    end if;
    if new.status = 'pending' and (new.decided_by is not null or new.decided_at is not null) then
      raise exception 'a pending request cannot have decided_by or decided_at';
    end if;
  end if;

  -- No second active request for the same effective agent. This also
  -- covers approving a "let Mubarak choose" request to an agent the user
  -- already has an active request for, which the unique index alone
  -- cannot see (its key changes from "any" to the agent on approval).
  if new.status in ('pending', 'approved') then
    v_effective := coalesce(new.assigned_agent_id, new.preferred_agent_id, '00000000-0000-0000-0000-000000000000'::uuid);
    if exists (
      select 1 from public.agent_requests r
      where r.requested_by = new.requested_by
        and r.id is distinct from new.id
        and r.status in ('pending', 'approved')
        and coalesce(r.assigned_agent_id, r.preferred_agent_id, '00000000-0000-0000-0000-000000000000'::uuid) = v_effective
    ) then
      raise exception 'you already have an active request for this agent';
    end if;
  end if;
  return new;
end; $$;

create trigger agent_requests_validate
  before insert or update on public.agent_requests
  for each row execute function public.validate_agent_request_agents();

-- On approval, Mubarak's welcome message is sent to the requester as a DM
-- from Mubarak himself, naming the assigned agent. Only the
-- pending -> approved transition sends one; a reassign (approved ->
-- approved with a different agent) does not send a second welcome.
-- The message is a plain DM row, so it shows up in the requester's chat
-- list and in Mubarak's owner view like any other DM.
create or replace function public.send_agent_approval_welcome()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent text;
begin
  if old.status = 'pending' and new.status = 'approved' and new.decided_by is not null then
    select username into v_agent from public.profiles where id = new.assigned_agent_id;
    insert into public.messages (user_id, recipient_id, content)
    values (
      new.decided_by,
      new.requested_by,
      'Welcome! I have assigned ' || coalesce(v_agent, 'an AI agent') || ' to chat with you — say hi to them whenever you are ready.'
    );
  end if;
  return new;
end; $$;

create trigger agent_requests_send_welcome
  after update on public.agent_requests
  for each row execute function public.send_agent_approval_welcome();

-- The DM gate: a member may only DM an AI agent that Mubarak assigned to
-- them. Without this, the request/approval flow is cosmetic — any member
-- could DM Adam, Ali, Gauri or Anurag directly and skip Mubarak entirely.
-- The owner may DM any AI; the AI replying (sender is the AI, recipient
-- is a human) is not gated because the recipient is not an AI profile.
-- Group messages (recipient_id null) are unaffected.
create or replace function public.enforce_agent_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.recipient_id is not null and exists (
    select 1 from public.profiles where id = new.recipient_id and is_ai
  ) then
    if (select public.is_owner()) then
      return new;
    end if;
    if not exists (
      select 1 from public.agent_requests
      where requested_by = new.user_id
        and assigned_agent_id = new.recipient_id
        and status = 'approved'
    ) then
      raise exception 'this AI agent has not been assigned to you — ask Mubarak to approve a request first';
    end if;
  end if;
  return new;
end; $$;

create trigger messages_enforce_agent_assignment
  before insert on public.messages
  for each row execute function public.enforce_agent_assignment();

-- Row level security: only the requester can create/read their own
-- request; only Mubarak can read all and decide. The trigger, not the
-- policy, validates the transition and the agent.
alter table public.agent_requests enable row level security;

create policy "requester reads own requests" on public.agent_requests
  for select to authenticated
  using (requested_by = (select auth.uid()));

create policy "requester creates own pending request" on public.agent_requests
  for insert to authenticated
  with check (
    requested_by = (select auth.uid())
    and status = 'pending'
    and decided_by is null
  );

create policy "owner reads all requests" on public.agent_requests
  for select to authenticated
  using ((select public.is_owner()));

create policy "owner decides requests" on public.agent_requests
  for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

-- No delete policy for anyone in v1: rows are history.

-- Realtime: the requester's status card and Mubarak's request list
-- update live, same pattern as messages/reactions in 0001.
alter table public.agent_requests replica identity full;
alter publication supabase_realtime add table public.agent_requests;
