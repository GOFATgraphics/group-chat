-- DRAFT ONLY, NOT APPLIED. Do not run this in Supabase until the user
-- approves the live steps (run this migration, then run the backfill
-- script, then push and deploy). Running it adds one nullable column
-- and changes nothing else.
--
-- Purpose: hold the full TradesDB row for each seeded trade, exactly as
-- Stealth stores it (all 117 columns in the copy sheet, in sheet header
-- order), so the Database view can render the full sheet-like table
-- instead of only the 6 simplified fields (contract_ref, buyer, seller,
-- commodity, quantity, disport) plus stage that the seed stored.
--
-- RLS: unchanged, and no new policy is needed. Migration 0019 policies on
-- public.trades are table-level ("project members read trades",
-- "project members write trades", "project members update trades",
-- "owner deletes trades"), so they automatically cover the new column.
-- No service-role bypass is introduced; reads and writes still run as
-- the caller under those policies, gated by project membership.
--
-- Backfill: after this column exists, the draft backfill script
-- (backfill-trades-full-data.py, in the work directory, NOT run) PATCHes
-- each existing trade row's full_data only. It never inserts a trade,
-- never writes to any Sheet, and never touches any other table.

alter table public.trades
  add column if not exists full_data jsonb;

comment on column public.trades.full_data is
  'Full TradesDB row for this trade, as a JSON object in sheet header order. Null until the backfill runs; the Database view must render the 6 simplified fields when this is null.';
