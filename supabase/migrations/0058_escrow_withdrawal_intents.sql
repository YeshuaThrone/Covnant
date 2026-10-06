-- =============================================================================
-- 0058 — Intent-first withdrawal holds on the escrow (audit note_c5ksDgVw #4/#5)
--
-- The tax audit found the withdraw path (src/app/api/payouts/withdraw)
-- reading the escrow balance, then calling Plaid, with nothing between the
-- read and the dispatch:
--
--   #4 (TOCTOU double-spend): two concurrent withdrawals read the same
--       SUM-derived balance, both pass the same check, and both transfer —
--       the same funds leave escrow twice.
--   #5 (money before the ledger): the DISBURSEMENT row was written only
--       AFTER the Plaid transfer succeeded, so a failed insert left the
--       balance intact and opened a repeat-withdrawal window on funds that
--       had already left.
--
-- Fix: the vault engine's available→pending discipline (migration 0009 H1,
-- src/modules/vaults/engine.ts) ported to the SUM-derived escrow surface.
-- A pending-debit INTENT row gates the Plaid call; the shared balance math
-- (escrowBalanceForHolder / fetchEscrowBalance) subtracts pending intents
-- like any other escrow debit; an authoritative rail failure releases the
-- intent (compensating release); the DISBURSEMENT settle flips it.
--
-- The reserve is ONE RPC — reserve_escrow_withdrawal — because the
-- supabase-js client has no interactive transactions: inside the function
-- a per-holder advisory lock serializes concurrent reserves, gross/tax/
-- payouts are re-derived from the ledger's disbursements JSONB (the same
-- math as escrowBalanceForHolder, with the tax rate supplied by the route
-- from the same engine call), the holder's pending intents are summed
-- fresh, and the intent row inserts only when the available floor holds.
-- The loser of a race sees the winner's pending row and refuses.
--
-- Money columns: amount_units is TEXT holding an integer string in the
-- 1e-8 ledger-unit scale — the same exact-string convention the ledger's
-- disbursements entries use (PostgREST hands numeric to supabase-js as a
-- potentially lossy JSON number). The CHECK pins the shape at the database.
--
-- Deliberately NOT touched here:
--   • No Plaid webhook endpoint — reconciliation of an intent stuck pending
--     (settle from the recorded plaid ids, or release) is a state flip on
--     this table for the follow-up webhook task. The route derives the
--     DISBURSEMENT transaction_id deterministically as
--     ESCROW-PAYOUT-<intent_id>, so a reconciliation settle re-writing that
--     row idempotently converges on the ledger's UNIQUE(transaction_id).
--   • No backfill — every existing DISBURSEMENT row predates intents and
--     the SUM math already counts it.
--
-- Idempotency (CI applies every migration twice): create table if not
-- exists, create or replace function, the alter/grant/revoke set, and the
-- comments all re-run as no-ops.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The pending-debit intent of record: one row per in-flight withdrawal
-- attempt, funds held from reserve until settled or released.
-- ---------------------------------------------------------------------------
create table if not exists public.escrow_withdrawal_intents (
  id                text primary key,
  rights_holder_id  text not null,
  amount_units      text not null check (amount_units ~ '^[0-9]+$' and amount_units::numeric > 0),
  status            text not null default 'pending' check (status in ('pending', 'settled', 'released')),
  plaid_transfer_id text,
  created_at        timestamptz not null default now(),
  settled_at        timestamptz,
  released_at       timestamptz,
  -- The lifecycle timestamps are pinned to the status they name: a settled
  -- row carries settled_at and nothing else, so reconciliation can trust
  -- the terminal state at rest.
  check ((status = 'settled') = (settled_at is not null)),
  check ((status = 'released') = (released_at is not null))
);

create index if not exists idx_escrow_withdrawal_intents_holder_status
  on public.escrow_withdrawal_intents (rights_holder_id, status);

comment on table public.escrow_withdrawal_intents is
  'The pending-debit withdrawal intents on the escrow (migration 0058) — one row per in-flight Plaid withdrawal attempt, recorded BEFORE dispatch so a concurrent second withdrawal of the same funds refuses (audit #4) and a failed DISBURSEMENT ledger insert leaves the hold standing instead of a repeat-withdrawal window (audit #5). The balance math subtracts pending rows like any other escrow debit; a released row restores them.';
comment on column public.escrow_withdrawal_intents.amount_units is
  'The held amount in smallest ledger units (1e-8 scale) as an exact integer string — the ledger disbursements convention. CHECK-pinned to bare digits.';

-- ---------------------------------------------------------------------------
-- The atomic reserve: the conditional pending-debit write that gates Plaid.
-- ---------------------------------------------------------------------------
create or replace function public.reserve_escrow_withdrawal(
  p_intent_id        text,
  p_rights_holder_id text,
  p_amount_units     numeric,
  p_tax_rate         numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gross_units   numeric;
  v_tax_units     numeric;
  v_payout_units  numeric;
  v_pending_units numeric;
  v_available     numeric;
begin
  -- The TOCTOU guard (#4): one reserve at a time per holder. The xact lock
  -- releases with the RPC's transaction; a concurrent second withdrawal for
  -- the same holder waits here, then sees the winner's pending row in
  -- v_pending_units and refuses at the floor below.
  perform pg_advisory_xact_lock(
    hashtextextended('escrow_withdrawal:' || p_rights_holder_id, 0)
  );

  -- The balance components re-derived at reserve time, in 1e-8 units — the
  -- same math as escrowBalanceForHolder: settlement entries carry a numeric
  -- grossShare and no type field; payout entries carry type 'DISBURSEMENT'
  -- and an integer-string payoutAmount. The tax rate is supplied by the
  -- route from the same engine call the shared balance helper uses.
  select
    coalesce(sum(
      case
        when e->>'rightsHolderId' = p_rights_holder_id
             and not (e ? 'type')
             and jsonb_typeof(e->'grossShare') = 'number'
          then (e->>'grossShare')::numeric * 100000000
        else 0
      end
    ), 0),
    coalesce(sum(
      case
        when e->>'rightsHolderId' = p_rights_holder_id
             and e->>'type' = 'DISBURSEMENT'
             and jsonb_typeof(e->'payoutAmount') = 'string'
          then (e->>'payoutAmount')::numeric
        else 0
      end
    ), 0)
  into v_gross_units, v_payout_units
  from public.universal_royalty_ledger l,
       jsonb_array_elements(coalesce(l.disbursements, '[]'::jsonb)) e;

  v_tax_units := floor(v_gross_units * p_tax_rate);

  select coalesce(sum(i.amount_units::numeric), 0)
    into v_pending_units
    from public.escrow_withdrawal_intents i
    where i.rights_holder_id = p_rights_holder_id
      and i.status = 'pending';

  v_available := v_gross_units - v_tax_units - v_payout_units - v_pending_units;

  if p_amount_units > v_available then
    return jsonb_build_object('reserved', false, 'available_units', v_available::text);
  end if;

  insert into public.escrow_withdrawal_intents (id, rights_holder_id, amount_units, status)
  values (p_intent_id, p_rights_holder_id, p_amount_units::text, 'pending');

  return jsonb_build_object('reserved', true, 'available_units', v_available::text);
end;
$$;

-- Service-role-only: the withdraw route runs on the service-role client.
-- The default PUBLIC execute grant is revoked — an unauthenticated caller
-- must never be able to mint holds (or lock up a holder's escrow) by
-- calling the reserve directly.
alter table public.escrow_withdrawal_intents enable row level security;
grant select, insert, update on public.escrow_withdrawal_intents to service_role;
revoke execute on function public.reserve_escrow_withdrawal(text, text, numeric, numeric) from public;
grant execute on function public.reserve_escrow_withdrawal(text, text, numeric, numeric) to service_role;

comment on function public.reserve_escrow_withdrawal(text, text, numeric, numeric) is
  'The atomic withdrawal reserve (migration 0058) — per-holder advisory lock, balance re-derived from the ledger, intent inserted only when available − pending ≥ amount. Returns { reserved, available_units } as jsonb; money moves only after this returns reserved=true.';
