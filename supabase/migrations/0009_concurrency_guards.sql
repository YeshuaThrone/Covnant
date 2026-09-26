-- ============================================================================
-- Covnant — settlement-core concurrency guards (0009)
-- Hardening PR 4 of the approved beta plan (audit art_GG1emERn, HIGH section).
-- Four guards for the multi-instance money paths the Don engine assumed were
-- single-threaded:
--
--   H2  gl_journals.sequence gets UNIQUE — concurrent postJournal calls both
--       read "latest", both compute last+1, and a forked chain destroys the
--       trust the hash chain exists to provide. Post-repair note: applying
--       this constraint to a table that ALREADY carries duplicate sequences
--       fails loudly by design — a forked chain needs manual repair first.
--   H4  payout_reversals.transfer_id gets UNIQUE — the engine treats the
--       reversal row as the lock (inserted BEFORE money moves), so a replayed
--       payout.failed/returned webhook can no longer double-credit a vault.
--       journal_id becomes nullable: the lock row exists before the journal
--       does, and the engine back-fills it after posting.
--   H1  apply_vault_delta() — vault balances stop being read-modify-write
--       with last-write-wins full-row overwrite. Every balance move becomes
--       one conditional SQL statement with per-bucket floors, so the
--       sufficiency check lives in the database, not between two HTTP reads.
--   H3  split_runs.idempotency_key (unique) — the split-calculation saga is a
--       multi-write sequence with no transaction; the idempotency key rides
--       the saga's first write (the split_runs insert) so a retried calculate
--       is rejected before any line item, ledger row, or vault credit exists.
--
-- Conventions, per migrations 0004–0008:
--  - Text UUIDs supplied by the store seam and timestamptz walls written as
--    ISO strings by the store.
--  - Money is bigint integer cents — never floats.
--  - Every statement is `if not exists`-equivalent idempotent, so re-running
--    the file is a no-op.
--  - RLS is enabled with no policies (deny-all); only the service role (the
--    Don Engine store) reads and writes these tables.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- H2 — the hash chain can no longer fork: one journal per sequence.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'gl_journals_sequence_key'
      and conrelid = 'public.gl_journals'::regclass
  ) then
    alter table public.gl_journals
      add constraint gl_journals_sequence_key unique (sequence);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- H4 — one reversal per BaaS transfer: the engine inserts the reversal row
-- as the lock before money moves; the unique index makes a second insert of
-- a replayed webhook impossible.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'payout_reversals_transfer_id_key'
      and conrelid = 'public.payout_reversals'::regclass
  ) then
    alter table public.payout_reversals
      add constraint payout_reversals_transfer_id_key unique (transfer_id);
  end if;
end $$;

-- The reversal lock row is inserted before the GL journal exists; the engine
-- back-fills journal_id (and ledger_transaction_id) after posting.
alter table public.payout_reversals alter column journal_id drop not null;

-- ---------------------------------------------------------------------------
-- H3 — split-run saga idempotency: nullable unique key; NULL (no key) never
-- conflicts, so unkeyed runs keep today's semantics.
-- ---------------------------------------------------------------------------
alter table public.split_runs add column if not exists idempotency_key text;

create unique index if not exists split_runs_idempotency_key_key
  on public.split_runs (idempotency_key);

-- ---------------------------------------------------------------------------
-- H1 — atomic vault mutation. One call applies signed bucket deltas with
-- per-bucket floors; the floor check happens inside the same statement that
-- moves the money, so two concurrent mutations can never last-write-wins
-- over each other and an over-spend is refused by the database.
--
-- Outcome contract (jsonb, mirroring record_checkout_purchase):
--   {"outcome": "applied", "vault": {…}}  — the row after the move
--   {"outcome": "guard_failed"}           — vault exists, a floor rejected
--   {"outcome": "not_found"}              — no vault and minting not allowed
--
-- create_if_missing (the credit path) mints the vault from zero at the delta
-- values. Minting is credits-only: a call that combines create_if_missing
-- with a negative delta, or floors the minted-from-zero balances cannot
-- satisfy, is refused up front. Existing rows always go through the
-- on-conflict arm, whose WHERE is the real floor check for any delta.
-- ---------------------------------------------------------------------------
create or replace function public.apply_vault_delta(
  p_payee_id          text,
  p_payee_name        text,
  p_available_delta   bigint,
  p_pending_delta     bigint,
  p_reserve_delta     bigint,
  p_min_available     bigint,
  p_min_pending       bigint,
  p_min_reserve       bigint,
  p_create_if_missing boolean,
  p_updated_at        timestamptz
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  vault_row public.sovereign_vaults%rowtype;
begin
  if p_create_if_missing then
    if p_available_delta < 0 or p_pending_delta < 0 or p_reserve_delta < 0 then
      return jsonb_build_object('outcome', 'not_found');
    end if;
    if (p_min_available is not null and p_available_delta < p_min_available)
       or (p_min_pending is not null and p_pending_delta < p_min_pending)
       or (p_min_reserve is not null and p_reserve_delta < p_min_reserve) then
      return jsonb_build_object('outcome', 'guard_failed');
    end if;

    insert into public.sovereign_vaults as v (
      payee_id, payee_name, available_balance, pending_balance,
      reserve_balance, updated_at
    ) values (
      p_payee_id, p_payee_name, p_available_delta, p_pending_delta,
      p_reserve_delta, p_updated_at
    )
    on conflict (payee_id) do update
      set available_balance = v.available_balance + excluded.available_balance,
          pending_balance   = v.pending_balance + excluded.pending_balance,
          reserve_balance   = v.reserve_balance + excluded.reserve_balance,
          updated_at        = excluded.updated_at
    where (p_min_available is null
             or v.available_balance + excluded.available_balance >= p_min_available)
      and (p_min_pending is null
             or v.pending_balance + excluded.pending_balance >= p_min_pending)
      and (p_min_reserve is null
             or v.reserve_balance + excluded.reserve_balance >= p_min_reserve)
    returning payee_id, payee_name, available_balance, pending_balance,
              reserve_balance, updated_at
    into vault_row;

    if found then
      return jsonb_build_object('outcome', 'applied', 'vault', to_jsonb(vault_row));
    end if;
    -- The conflict arm's floor rejected the add — the vault exists.
    return jsonb_build_object('outcome', 'guard_failed');
  end if;

  update public.sovereign_vaults
     set available_balance = available_balance + p_available_delta,
         pending_balance   = pending_balance + p_pending_delta,
         reserve_balance   = reserve_balance + p_reserve_delta,
         updated_at        = p_updated_at
   where payee_id = p_payee_id
     and (p_min_available is null
            or available_balance + p_available_delta >= p_min_available)
     and (p_min_pending is null
            or pending_balance + p_pending_delta >= p_min_pending)
     and (p_min_reserve is null
            or reserve_balance + p_reserve_delta >= p_min_reserve)
  returning payee_id, payee_name, available_balance, pending_balance,
            reserve_balance, updated_at
  into vault_row;

  if found then
    return jsonb_build_object('outcome', 'applied', 'vault', to_jsonb(vault_row));
  end if;
  if exists (select 1 from public.sovereign_vaults where payee_id = p_payee_id) then
    return jsonb_build_object('outcome', 'guard_failed');
  end if;
  return jsonb_build_object('outcome', 'not_found');
end;
$$;

grant execute on function public.apply_vault_delta(
  text, text, bigint, bigint, bigint, bigint, bigint, bigint, boolean, timestamptz
) to service_role;
