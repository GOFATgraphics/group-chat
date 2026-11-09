-- Owner flag on profiles (Ahmad, 9 Nov 2026).
--
-- The server reads profiles.is_owner as a COLUMN (usage owner check,
-- widget payload, balance route), but no migration ever added the
-- column — is_owner only exists as a FUNCTION (public.is_owner(),
-- 0004, used in RLS policies). So /api/widget (and the owner usage
-- check) 500 with "column profiles.is_owner does not exist", and the
-- lock-screen widget shows "Unexpected reply" for every user.
-- This adds the column and marks the owner (username 'mubarak', the
-- same definition the function uses). File only; apply it in the
-- Supabase SQL editor before the app change goes live.

alter table public.profiles add column if not exists is_owner boolean not null default false;

update public.profiles set is_owner = true where username = 'mubarak';
