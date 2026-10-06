-- =============================================================================
-- 0060 — Withholding idempotency key on tax_escrow_ledger (audit #12)
--
-- The tax audit (note_c5ksDgVw, verified at 556924e) found that
-- applyWithholding (src/modules/compliance/engine.ts) has no idempotency
-- guard: a replayed apply — a retried saga, a redelivered operator call —
-- books a SECOND escrow row and accumulates the YTD a second time, so the
-- creator is double-withheld. The split-run saga already solved this class
-- of bug for its own writes (migration 0009's split_runs.idempotency_key
-- + UNIQUE index, probed by udrSplits before the saga and re-read after a
-- lost insert race): this migration gives tax escrow rows the same key.
--
-- Fix: a nullable idempotency_key on tax_escrow_ledger, stamped by
-- applyWithholding when the caller supplies one. A replay with the same
-- key returns the STORED escrow row — one effect, faithfully reconstructed
-- from the row's own gross/withheld/net/flags — instead of a second one.
-- Callers without a key (the 22+ vertical settlement engines) are
-- unchanged: their rows carry NULL, and a unique index in Postgres treats
-- NULLs as distinct, so unkeyed rows never collide. The unique index also
-- arbitrates the concurrent-replay race: two applies with one key race the
-- insert, the index picks a winner, and the loser re-reads and returns the
-- winner's row — the YTD delta posts only on the winner, never twice.
--
-- Deliberately NOT touched here:
--   • No backfill of idempotency keys onto existing rows — rows predating
--     this migration keep NULL and stay non-attributable (same decision
--     as 0059's split_run_id).
--
-- Idempotency (CI applies every migration twice): add column if not
-- exists and create index if not exists both re-run as no-ops.
-- =============================================================================

alter table public.tax_escrow_ledger
  add column if not exists idempotency_key text;

create unique index if not exists tax_escrow_idempotency_key_unique
  on public.tax_escrow_ledger (idempotency_key);
