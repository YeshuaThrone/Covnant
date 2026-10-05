-- =============================================================================
-- 0056 — The cbt_assets dual-code columns: cvt_code and holder_uct
--
-- The PR #22 dual-code registration shipped code that reads two columns the
-- migrations never created:
--
--   cvt_code     <- engine registerCBTAsset inserts it whenever a dbClient is
--                   supplied (src/engine/covenant-master-sdk.ts); the vault
--                   addresses every asset by it (src/lib/covnant/vault.ts:
--                   WHERE a.cvt_code = $1 / WHERE cvt_code = $3). The outward-
--                   facing handle: the stored cbt_assets.cvt_code.
--   holder_uct   <- the UCT layer's first UCT-carrying rights holder of each
--                   asset — a nullable forward column for the vault's holder
--                   lookups (the vault currently derives the value from the
--                   rights_holders JSONB; the column persists it going
--                   forward).
--
-- Production (2026-10-05): every demo-door boot failed loudly with PostgREST
-- PGRST204 — "Could not find the cvt_code column of cbt_assets in the schema
-- cache" — because registerCBTAsset's insert named a column this table never
-- had. Both columns are NULLABLE text: existing rows must not break, and the
-- engine's inserts populate cvt_code going forward.
--
-- Deliberately NOT touched here:
--   • No foreign keys — 0001 created this table with none; codes are the
--     join keys by design.
--   • No RLS changes — 0001's table-level deny-all policies cover the new
--     columns automatically.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The dual-code columns (nullable — see header).
-- ---------------------------------------------------------------------------
alter table public.cbt_assets add column if not exists cvt_code text;
alter table public.cbt_assets add column if not exists holder_uct text;

-- The CVT handle is unique wherever it is minted: a partial unique index —
-- NULLs (pre-dual-code rows) never conflict.
create unique index if not exists uq_cbt_assets_cvt_code
  on public.cbt_assets (cvt_code)
  where cvt_code is not null;

-- The holder UCT lookup path.
create index if not exists idx_cbt_assets_holder_uct
  on public.cbt_assets (holder_uct);
