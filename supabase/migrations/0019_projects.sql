-- DRAFT ONLY. DO NOT APPLY. NOT RUN ANYWHERE.
-- Phase 1 Project pages currently store projects in browser localStorage
-- only. This file is the future server shape the UI will eventually read
-- from, once it is reviewed, approved, and applied as a separate step.
-- It does not create any live table, and it must not be run as part of
-- the local Project page build.

-- Projects: one container per trade ingestion setup, e.g. Mercancia Trade Capture.
-- A project is not one trade.
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id),
  name text not null check (char_length(trim(name)) > 0),
  created_at timestamptz not null default now()
);

-- Queue: one row per inbox thread entering a project, in order.
-- Status maps to the dashboard stages: queued, extracted, finished,
-- matched, new, failed, needs_review.
create table if not exists public.trade_queue (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  message_id text not null,
  sender text,
  subject text,
  body text,
  status text not null default 'queued'
    check (status in ('queued', 'extracted', 'finished', 'matched', 'new', 'failed', 'needs_review')),
  attempts int not null default 0,
  last_error text,
  credit_used numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (project_id, message_id)
);

-- Trades: the own-database record, saved before any external sync.
create table if not exists public.trades (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  queue_id bigint references public.trade_queue (id),
  contract_ref text,
  buyer text,
  seller text,
  commodity text,
  quantity numeric,
  disport text,
  lifecycle_stage text,
  sub_stage text,
  action_owner text,
  deadline date,
  fingerprint text,
  stage text not null default 'extracted'
    check (stage in ('extracted', 'finished', 'matched', 'new')),
  created_at timestamptz not null default now()
);

-- Reference bridge, replacing the Sheets Shadow Reference Bridge as lookup.
create table if not exists public.trade_references (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  shadow_ref text,
  live_refs text,
  external_refs text,
  fingerprint text,
  updated_at timestamptz not null default now()
);

-- Notes log, linked to a trade.
create table if not exists public.trade_notes (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  trade_id bigint references public.trades (id) on delete set null,
  subject text,
  summary text,
  priority text,
  action_required text,
  message_id text,
  created_at timestamptz not null default now()
);

-- One-way sync log: a Sheets failure never deletes or blocks a saved trade.
create table if not exists public.trade_sync_log (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  trade_id bigint references public.trades (id) on delete set null,
  target text not null default 'google_sheet',
  success boolean not null default false,
  failure_reason text,
  created_at timestamptz not null default now()
);

-- Indexes for project-scoped lookups.
create index if not exists trade_queue_project_idx on public.trade_queue (project_id, id);
create index if not exists trades_project_idx on public.trades (project_id, id);
create index if not exists trade_references_project_idx on public.trade_references (project_id, id);
create index if not exists trade_notes_project_idx on public.trade_notes (project_id, id);
create index if not exists trade_sync_log_project_idx on public.trade_sync_log (project_id, id);

-- RLS, added in review 2026-10-30, still DRAFT ONLY, NOT APPLIED.
-- Rule: a caller can access a project only if they are a chat member and
-- they are the project owner, or the group owner (username 'mubarak', via
-- is_owner() from 0004), or an AI member ('adam' or 'ali'). Other team
-- members, for example 'mudassir', get no rows, not an error.
-- This matches the plan rule: trade data is restricted to mubarak, adam,
-- and ali only, when the owner is mubarak. AI members can read and write
-- trade rows so Adam extraction and Ali finishing can work, but only the
-- project owner can update or delete the project itself, and only the
-- owner can delete trade rows.
create or replace function public.can_access_project(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select public.is_member()) and exists (
    select 1 from public.projects p
    join public.profiles me on me.id = (select auth.uid())
    where p.id = p_project
      and (
        p.owner_id = (select auth.uid())
        or (select public.is_owner())
        or me.username in ('adam', 'ali')
      )
  );
$$;
revoke execute on function public.can_access_project(uuid) from public, anon;
grant execute on function public.can_access_project(uuid) to authenticated;

alter table public.projects enable row level security;
alter table public.trade_queue enable row level security;
alter table public.trades enable row level security;
alter table public.trade_references enable row level security;
alter table public.trade_notes enable row level security;
alter table public.trade_sync_log enable row level security;

create policy "project members read projects" on public.projects
  for select to authenticated using (public.can_access_project(id));
create policy "owner creates projects" on public.projects
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "owner updates projects" on public.projects
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "owner deletes projects" on public.projects
  for delete to authenticated using (owner_id = (select auth.uid()));

create policy "project members read queue" on public.trade_queue
  for select to authenticated using (public.can_access_project(project_id));
create policy "project members write queue" on public.trade_queue
  for insert to authenticated with check (public.can_access_project(project_id));
create policy "project members update queue" on public.trade_queue
  for update to authenticated using (public.can_access_project(project_id)) with check (public.can_access_project(project_id));
create policy "owner deletes queue" on public.trade_queue
  for delete to authenticated using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));

create policy "project members read trades" on public.trades
  for select to authenticated using (public.can_access_project(project_id));
create policy "project members write trades" on public.trades
  for insert to authenticated with check (public.can_access_project(project_id));
create policy "project members update trades" on public.trades
  for update to authenticated using (public.can_access_project(project_id)) with check (public.can_access_project(project_id));
create policy "owner deletes trades" on public.trades
  for delete to authenticated using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));

create policy "project members read references" on public.trade_references
  for select to authenticated using (public.can_access_project(project_id));
create policy "project members write references" on public.trade_references
  for insert to authenticated with check (public.can_access_project(project_id));
create policy "project members update references" on public.trade_references
  for update to authenticated using (public.can_access_project(project_id)) with check (public.can_access_project(project_id));
create policy "owner deletes references" on public.trade_references
  for delete to authenticated using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));

create policy "project members read notes" on public.trade_notes
  for select to authenticated using (public.can_access_project(project_id));
create policy "project members write notes" on public.trade_notes
  for insert to authenticated with check (public.can_access_project(project_id));
create policy "project members update notes" on public.trade_notes
  for update to authenticated using (public.can_access_project(project_id)) with check (public.can_access_project(project_id));
create policy "owner deletes notes" on public.trade_notes
  for delete to authenticated using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));

create policy "project members read sync log" on public.trade_sync_log
  for select to authenticated using (public.can_access_project(project_id));
create policy "project members write sync log" on public.trade_sync_log
  for insert to authenticated with check (public.can_access_project(project_id));
create policy "project members update sync log" on public.trade_sync_log
  for update to authenticated using (public.can_access_project(project_id)) with check (public.can_access_project(project_id));
create policy "owner deletes sync log" on public.trade_sync_log
  for delete to authenticated using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = (select auth.uid())));

-- REVIEW NOTE, not a live change: this migration is still a draft file
-- only. It must not be run until you approve the push and migration step
-- separately. After it is run, verify with a test project: mubarak, adam,
-- and ali can read it, mudassir gets no rows.
