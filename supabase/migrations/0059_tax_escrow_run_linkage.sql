-- =============================================================================
-- 0059 — Run linkage on tax_escrow_ledger (reversal unwind key)
--
-- The tax audit (note_c5ksDgVw #7) found that split-run reversal claws the
-- vault back but never unwinds the withholding trail: creator_ytd_earnings
-- and tax_escrow_ledger keep the phantom gross, so reversed runs keep
-- counting toward 1099s. Unwinding requires attributing escrow rows to the
-- run that created them — tax_escrow_ledger (0006) has no such column.
--
-- Fix: a nullable split_run_id on tax_escrow_ledger, stamped by
-- applyWithholding when the caller supplies one (udrSplits does; the 24
-- other callers are unchanged). The reversal (and a failed split saga's
-- compensation path) lists the run's escrow rows through it and posts
-- compensating negative rows plus negative YTD deltas through the SAME
-- atomic accumulate migration 0057 introduced — never an absolute-total
-- write. Rows predating this migration carry NULL and cannot be attributed;
-- no backfill here (separate approved-plan task, same as 0057 declined).
--
-- Idempotency (CI applies every migration twice): add column if not exists
-- and create index if not exists both re-run as no-ops.
-- =============================================================================

alter table public.tax_escrow_ledger
  add column if not exists split_run_id text;

create index if not exists idx_tax_escrow_run
  on public.tax_escrow_ledger (split_run_id);
