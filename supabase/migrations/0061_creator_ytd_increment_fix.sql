-- =============================================================================
-- 0061 — HOTFIX: increment_creator_ytd was uncallable (0057 shipped broken)
--
-- Migration 0057 defined the YTD accumulator with its data-modifying CTE
-- wrapped inside a parenthesized scalar subquery:
--
--   return (
--     with upserted as ( insert ... returning ... )
--     select to_jsonb(upserted) from upserted
--   );
--
-- PostgreSQL rejects that shape on EVERY call — a WITH clause containing a
-- data-modifying statement must sit at the top level of its statement, and
-- the parentheses bury it in a subquery (SQLSTATE 0A000, "WITH clause
-- containing a data-modifying statement must be at the top level", probed
-- live on production 2026-10-06). CREATE FUNCTION does not catch it: PL/pgSQL
-- parses the body's SQL lazily at first execution, so the schema CI job —
-- which applies each migration twice but never CALLS the RPC — passed while
-- every applyWithholding call on the Supabase store failed at runtime.
--
-- Fix: the same function, IDENTICAL signature and returned jsonb shape, with
-- the upsert moved to a plain top-level INSERT ... ON CONFLICT ... RETURNING
-- ... INTO a %rowtype variable, returned as to_jsonb(row). The suggested
-- `return query with ...` form is impossible here — RETURN QUERY requires a
-- SETOF return type, and a setof jsonb would make PostgREST wrap the
-- response in an array, breaking the SupabaseStore.oneStrict reader — so the
-- fix uses the repo's proven envelope mechanism instead (0009's
-- apply_vault_delta: returning ... into a rowtype variable). There is no CTE
-- left: the data-modifying statement itself sits at the top level. The
-- on-conflict accumulate arithmetic is unchanged in intent:
--   gross = gross + excluded, withheld = withheld + excluded.
--
-- Regression coverage: the CI schema job now CALLS this RPC on the scratch
-- Postgres (accumulation, upsert-on-conflict, in-transaction + autocommit,
-- 0061 re-apply) — the call-level blind spot that let 0057 ship is closed in
-- .github/workflows/ci.yml.
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
declare
  ytd_row public.creator_ytd_earnings%rowtype;
begin
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
  into ytd_row;

  return to_jsonb(ytd_row);
end;
$$;

grant execute on function public.increment_creator_ytd(
  text, integer, bigint, bigint, timestamptz
) to service_role;
