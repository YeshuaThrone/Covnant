-- =============================================================================
-- 0057 — Atomic YTD accumulation for creator_ytd_earnings
--
-- The tax audit (note_c5ksDgVw, verified at 556924e) found creator
-- year-to-date gross written as an absolute-total read-modify-write: the
-- engine reads the stored YTD row, adds the settlement in TypeScript, and
-- upserts the new absolute total (src/modules/compliance/engine.ts,
-- applyWithholding). Two settlements of the same creator in flight at once
-- both read the same starting total, both write, and the loser's money
-- vanishes from the YTD — the creator can silently sit below the $600 1099
-- threshold they actually crossed.
--
-- Fix: the same shape of guard 0009 (H1) gave sovereign vault balances —
-- one SQL statement owns the accumulation. increment_creator_ytd adds the
-- deltas inside the database (INSERT ... ON CONFLICT DO UPDATE with
-- column-referencing arithmetic), so N concurrent calls accumulate exactly
-- and no contribution is ever lost. The engine's TypeScript read stays for
-- the per-payment math (backup-withholding rate, per-escrow threshold
-- flags); only the persisted total moves to the atomic write.
--
-- Deliberately NOT touched here:
--   • No backfill/re-fold of existing YTD rows from tax_escrow_ledger —
--     that is a separate approved-plan task.
--   • No change to the table itself — 0006 created it with
--     primary key (creator_id, tax_year), which the on-conflict arm needs.
--
-- Idempotency (CI applies every migration twice): create or replace
-- function re-runs as a no-op, and grant execute is additive.
-- =============================================================================

-- One atomic accumulate. Deltas are signed so a future correcting entry can
-- subtract, but settlements in practice add positive cents. Returns the
-- post-increment row as jsonb (the apply_vault_delta envelope convention),
-- with bigint cents serialized as JSON numbers — well below 2^53.
create or replace function public.increment_creator_ytd(
  p_creator_id     text,
  p_tax_year       integer,
  p_gross_delta    bigint,
  p_withheld_delta bigint,
  p_updated_at     timestamptz
) returns jsonb
language plpgsql
set search_path = public
as $$
begin
  return (
    with upserted as (
      insert into public.creator_ytd_earnings as y (
        creator_id, tax_year, gross_cents, withheld_cents, updated_at
      ) values (
        p_creator_id, p_tax_year, p_gross_delta, p_withheld_delta, p_updated_at
      )
      on conflict (creator_id, tax_year) do update set
        gross_cents    = y.gross_cents + excluded.gross_cents,
        withheld_cents = y.withheld_cents + excluded.withheld_cents,
        updated_at     = excluded.updated_at
      returning creator_id, tax_year, gross_cents, withheld_cents, updated_at
    )
    select to_jsonb(upserted) from upserted
  );
end;
$$;

grant execute on function public.increment_creator_ytd(
  text, integer, bigint, bigint, timestamptz
) to service_role;
