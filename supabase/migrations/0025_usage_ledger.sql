-- Usage ledger: cached per-user, per-agent, per-week usage totals.
--
-- Why: loadUsageForUser re-downloads a user's ENTIRE DM history (fetchAll,
-- all time, including message content) on every balance check, widget
-- refresh and Settings open, and that download grows with history. That is
-- the main remaining egress risk on the Free plan (log ingestion and egress
-- are over quota this cycle). The ledger holds the same totals, aggregated
-- once per message when it is stored, so the balance/bars/usage/widget
-- loaders read one small query instead of the whole history.
--
-- The ledger holds RAW totals only. The two-tier rules (20 free credits/week
-- from the fair-start week 2026-11-09, excess from additional tokens, owner
-- exempt) are applied by the existing server code (balancesFor /
-- weeklyCreditTotals) on top of these totals, exactly as before.
--
-- Tables are service-role only (RLS on, no policies for authenticated),
-- exactly like credit_grants (0023). Rows are written by the server with the
-- service-role client, either through the record_usage_ledger() function
-- (atomic increment, used when a message is stored) or by a backfill
-- (replace upsert, idempotent).

create table if not exists public.usage_ledger (
  user_id uuid not null references public.profiles(id) on delete cascade,
  agent_id uuid not null references public.profiles(id) on delete cascade,
  week_start date not null,
  messages int not null default 0,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  voice_minutes numeric not null default 0,
  voice_notes int not null default 0,
  cost_usd numeric not null default 0,
  credits numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, agent_id, week_start)
);
alter table public.usage_ledger enable row level security;

-- One row per user: whether their history has been backfilled into the
-- ledger, and how far the backfill reached (max message id included).
create table if not exists public.usage_ledger_state (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  backfilled_through_id bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.usage_ledger_state enable row level security;

-- Atomic increment for one (user, agent, week) bucket. Used by the server
-- when a message is stored. The ON CONFLICT increment means concurrent
-- recorders cannot lose a count.
create or replace function public.record_usage_ledger(
  p_user_id uuid,
  p_agent_id uuid,
  p_week_start date,
  p_messages int,
  p_input_tokens int,
  p_output_tokens int,
  p_voice_minutes numeric,
  p_voice_notes int,
  p_cost_usd numeric,
  p_credits numeric
) returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.usage_ledger
    (user_id, agent_id, week_start, messages, input_tokens, output_tokens,
     voice_minutes, voice_notes, cost_usd, credits, updated_at)
  values
    (p_user_id, p_agent_id, p_week_start, p_messages, p_input_tokens,
     p_output_tokens, p_voice_minutes, p_voice_notes, p_cost_usd, p_credits, now())
  on conflict (user_id, agent_id, week_start) do update set
    messages = public.usage_ledger.messages + excluded.messages,
    input_tokens = public.usage_ledger.input_tokens + excluded.input_tokens,
    output_tokens = public.usage_ledger.output_tokens + excluded.output_tokens,
    voice_minutes = public.usage_ledger.voice_minutes + excluded.voice_minutes,
    voice_notes = public.usage_ledger.voice_notes + excluded.voice_notes,
    cost_usd = public.usage_ledger.cost_usd + excluded.cost_usd,
    credits = public.usage_ledger.credits + excluded.credits,
    updated_at = now();
$$;

-- Service-role only: the ledger is server accounting, never a client RPC.
revoke execute on function public.record_usage_ledger(
  uuid, uuid, date, int, int, int, numeric, int, numeric, numeric
) from public, anon;
