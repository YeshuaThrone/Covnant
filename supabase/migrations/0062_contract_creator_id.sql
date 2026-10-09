-- =============================================================================
-- 0062 — Contract ownership: nullable contracts.creator_id (audit F6/F7)
--
-- The security audit (remediation spec D7, findings F6/F7) found that the
-- contracts store had NO ownership concept at all: the workspace contract
-- list and detail pages and the export route rendered every stored
-- agreement's full text to whichever principal passed the (route-level)
-- gate — any registered creator could export any other creator's contract,
-- and foreign ids answered 200, indistinguishable from a successful read.
--
-- Fix: a nullable creator_id on contracts, stamped by saveContract from the
-- creating session's registered-creator identity (the session-bound payee
-- id resolveSessionCreator derives — the same tenant key every holder-
-- scoped surface uses). Reads scope by it:
--
--   - a registered creator sees and exports only the contracts they (or
--     their session) created;
--   - operators/admins see all rows;
--   - NULL-creator rows (everything saved before this migration, plus
--     unattributed operator saves) stay visible to operators/admins only.
--
-- Unknown _or_ foreign ids are answered 404 — never 403 — per the
-- workspace's cross-tenant rule: a miss must be indistinguishable from a
-- nonexistent id.
--
-- Deliberately NOT touched here:
--   • No backfill of creator_id onto existing rows — rows predating this
--     migration keep NULL and stay operator-visible only (same decision as
--     0059's split_run_id and 0060's idempotency_key).
--   • No foreign keys — 0002 created this table with none; ids are the
--     join keys by design, and the creator identity is a registry payee
--     key (rh_*), not a row in a referenced table.
--   • No RLS changes — 0002's table-level deny-all policies cover the new
--     column automatically (same posture as 0056's added columns).
--
-- Idempotency (CI applies every migration twice): add column if not
-- exists and create index if not exists both re-run as no-ops.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The ownership column (nullable — see header).
-- ---------------------------------------------------------------------------
alter table public.contracts add column if not exists creator_id text;

-- Creator-scoped reads (list + per-id lookups) filter on this column; the
-- non-unique index keeps the creator's own-list scan cheap.
create index if not exists idx_contracts_creator_id
  on public.contracts (creator_id);
