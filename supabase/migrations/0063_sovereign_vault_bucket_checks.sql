-- =============================================================================
-- 0063 — DB-level non-negative floors on the sovereign_vaults buckets (F11)
--
-- The sovereign_vaults balance buckets (available/pending/reserve) carried
-- no CHECK constraint: the non-negative invariant lived only inside
-- apply_vault_delta (0009), enforced by the WHERE floor of the caller's
-- min_balances. Any direct SQL, ad-hoc remediation, or future code path
-- that bypassed the RPC could persist a negative balance silently — money
-- that does not exist, spendable on the next read (audit finding F11).
--
-- This migration mirrors the floors at the DDL: a CHECK that refuses any
-- row where a bucket is negative. apply_vault_delta is untouched — its
-- WHERE floors already refuse delta results below the caller's minimums
-- before any write, so the CHECK is a strict-subset backstop (defense in
-- depth), not a behavior change. If production ever holds a negative
-- bucket, this migration fails loudly at deploy rather than papering over
-- the corruption — that is the intended posture.
--
-- Idempotent: the schema CI job applies every migration twice, and the
-- second apply is a no-op through the pg_constraint guard (the 0011
-- pattern). Validated by call-level probes in ci.yml: a deliberate
-- negative UPDATE must fail at the DB (SQLSTATE 23514) on every bucket,
-- while legitimate non-negative deltas still apply.
-- =============================================================================

do $$
begin
  if not exists (
    select from pg_constraint
    where conrelid = 'public.sovereign_vaults'::regclass
      and conname = 'sovereign_vaults_buckets_nonnegative'
  ) then
    alter table public.sovereign_vaults
      add constraint sovereign_vaults_buckets_nonnegative
      check (available_balance >= 0 and pending_balance >= 0 and reserve_balance >= 0);
  end if;
end $$;
