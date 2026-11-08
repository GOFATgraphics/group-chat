-- Additional-token grants: the second tier of the two-tier usage model
-- (Ahmad, 8 Nov 2026). Each week a user gets 20 free credits; any usage
-- above that draws from their additional-tokens balance. The balance
-- never expires and starts at 0 for everyone — it only grows when the
-- admin grants credits, one row per grant, via POST /api/usage/grant.
-- File only; apply it in the Supabase SQL editor before the app change
-- goes live. Until it is applied, the usage endpoints treat the granted
-- total as 0 (fail soft) instead of erroring.

create table if not exists public.credit_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  credits numeric not null check (credits > 0),
  granted_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  note text
);

alter table public.credit_grants enable row level security;

-- No policies for authenticated users, by design: grants are
-- service-role only. The admin grants through POST /api/usage/grant
-- (server-side, owner-only) and the usage endpoints read the totals
-- with the service-role client. A client-side read or insert must keep
-- failing — that is what stops a user from granting credits to
-- themselves or reading anyone else's balance.
