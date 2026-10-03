-- =============================================================================
-- 0053 — The resource lane: the resource audit escrow and the resource
--        payout gate states (PR 49, the founder resource directive)
--
-- Four tables:
--
--   energy_resource_audit_escrow_policies
--                                      <- upsertResourceAuditEscrowPolicy /
--                                         getResourceAuditEscrowPolicy
--     (the escrow rate of record per (owner payee, parcel) scope — the
--      founder band, 500–1500 bps (5–15%), per scope. UNIQUE per
--      scope_key: an upsert converges — the newest rate governs the
--      next routing.)
--
--   energy_resource_audit_escrow_drawdowns
--                                      <- insertResourceAuditEscrowDrawdown /
--                                         listResourceAuditEscrowDrawdowns
--     (the append-only drawdown truth: a monthly commodity price
--      reconciliation, a pipeline variance audit, or an environmental
--      regulatory compliance check spending one escrow's balance.
--      UNIQUE per (reserve_ledger_id, source_event_id): the replay
--      guard. UNIQUE per (reserve_ledger_id, drawn_before_cents): the
--      position lock — two draws cannot both spend the same balance.
--      The conservation CHECK pins remaining = before − drawn ≥ 0 per
--      row; the escrow's balance derives from this append-only truth,
--      never a mutable counter.)
--
--   energy_resource_audit_escrow_reconciliations
--                                      <- insertResourceAuditEscrowReconciliation /
--                                         getResourceAuditEscrowReconciliation
--     (the verified reconciliation of record per escrow — the release
--      gate's key. UNIQUE per reserve_ledger_id: the FIRST
--      reconciliation wins, insert-as-lock; the release reads it
--      fail-closed — no reconciliation of record, no release.)
--
--   energy_resource_payout_gate_states
--                                      <- upsertResourcePayoutGateState /
--                                         getResourcePayoutGateState
--     (the durable resource payout-gate states of record per
--      (payee_id, parcel_id) — the environmental regulatory compliance
--      clearance and the title ownership verification the resource
--      payout gate reads FAIL-CLOSED: an absent row resolves null
--      (refused) and an unknown state refuses the specific condition.
--      UNIQUE per (payee_id, parcel_id): an upsert converges — a
--      verification heals 'unknown'; states never regress through this
--      table.)
--
-- CONSTRAINT NAMING (the 0032 production lesson): every CHECK is a
-- TABLE-LEVEL constraint with an explicit ck_<table>_<what> name —
-- column-level CHECKs collide with table-level names on regeneration.
-- No foreign keys: the tables key on parcel ids and text payee ids —
-- the energy lane's own identifier space (the 0037–0052 discipline).
--
-- VOCABULARY (the PR 129/130 lesson — byte-identity with the TS unions
-- BEFORE CI): the SQL CHECK token lists below are byte-identical to
--   RESOURCE_AUDIT_ESCROW_DRAWDOWN_CLASSES (src/modules/energy/records.ts)
--   RESOURCE_GATE_ENVIRONMENTAL_STATES    (src/modules/energy/records.ts)
--   RESOURCE_GATE_TITLE_STATES            (src/modules/energy/records.ts)
-- and the parity floors match the CHECK floors exactly. Verified
-- byte-identical before CI dispatch (the PR 133/134/137/138 discipline).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- energy_resource_audit_escrow_policies: the escrow rate of record —
-- the founder band, 500–1500 bps (5–15%), per scope.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_resource_audit_escrow_policies (
  id                uuid primary key default gen_random_uuid(),
  scope_key         text not null,
  reserve_rate_bps  bigint not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (scope_key),
  constraint ck_energy_resource_audit_escrow_policies_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_energy_resource_audit_escrow_policies_rate_in_founder_band
    check (reserve_rate_bps >= 500 AND reserve_rate_bps <= 1500)
);

comment on table public.energy_resource_audit_escrow_policies is
  'The resource audit escrow rate of record per scope_key (migration 0053) — owner:{ownerPayeeId}:parcel:{parcelId} — the founder-banded 500–1500 bps (5–15%) share of the scope''s resource payouts that locks into the RESOURCE_AUDIT_ESCROW bucket at routing, drawn down against monthly commodity price reconciliations, pipeline variance audits, and environmental regulatory compliance checks. The CHECK pins the band at the database too.';

-- ---------------------------------------------------------------------------
-- energy_resource_audit_escrow_drawdowns: the append-only drawdown
-- truth — commodity price reconciliations, pipeline variance audits,
-- and environmental compliance checks spending one escrow's balance.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_resource_audit_escrow_drawdowns (
  id                   uuid primary key default gen_random_uuid(),
  reserve_ledger_id    uuid not null,
  scope_key            text not null,
  drawdown_class       text not null,
  source_event_id      text not null,
  drawn_before_cents   bigint not null,
  drawn_cents          bigint not null,
  remaining_cents      bigint not null,
  created_at           timestamptz not null default now(),
  unique (reserve_ledger_id, source_event_id),
  unique (reserve_ledger_id, drawn_before_cents),
  constraint ck_energy_resource_audit_escrow_drawdowns_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_energy_resource_audit_escrow_drawdowns_class_vocabulary
    check (drawdown_class IN ('commodity_price_reconciliation', 'pipeline_variance_audit', 'environmental_compliance_check')),
  constraint ck_energy_resource_audit_escrow_drawdowns_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_energy_resource_audit_escrow_drawdowns_amount_positive
    check (drawn_cents > 0),
  constraint ck_energy_resource_audit_escrow_drawdowns_before_non_negative
    check (drawn_before_cents >= 0),
  constraint ck_energy_resource_audit_escrow_drawdowns_position_conserves
    check (remaining_cents = drawn_before_cents - drawn_cents AND remaining_cents >= 0)
);
create index if not exists idx_energy_resource_audit_escrow_drawdowns_reserve
  on public.energy_resource_audit_escrow_drawdowns (reserve_ledger_id);

comment on table public.energy_resource_audit_escrow_drawdowns is
  'The append-only resource audit escrow drawdown truth (migration 0053) — one row per audit exposure executed against one escrow''s balance: a monthly commodity price reconciliation, a pipeline variance audit, or an environmental regulatory compliance check. UNIQUE (reserve_ledger_id, source_event_id): the replay guard. UNIQUE (reserve_ledger_id, drawn_before_cents): the position lock — the position-locked insert before the money moves. The conservation CHECK pins remaining = before − drawn ≥ 0 per row; the balance derives from this append-only truth, never a mutable counter.';

-- ---------------------------------------------------------------------------
-- energy_resource_audit_escrow_reconciliations: the verified
-- reconciliation of record per escrow — the release gate's key.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_resource_audit_escrow_reconciliations (
  id                 uuid primary key default gen_random_uuid(),
  reserve_ledger_id  uuid not null,
  evidence_ref       text not null,
  reconciled_by      text not null,
  created_at         timestamptz not null default now(),
  unique (reserve_ledger_id),
  constraint ck_energy_resource_audit_escrow_reconciliations_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_energy_resource_audit_escrow_reconciliations_reconciler_present
    check (char_length(reconciled_by) > 0)
);

comment on table public.energy_resource_audit_escrow_reconciliations is
  'The verified reconciliation of record per resource audit escrow (migration 0053) — the release gate''s key. UNIQUE (reserve_ledger_id): insert-as-lock, the FIRST reconciliation wins; the release reads it fail-closed — no reconciliation of record, no release.';

-- ---------------------------------------------------------------------------
-- energy_resource_payout_gate_states: the durable resource payout-gate
-- states of record per (payee_id, parcel_id).
-- ---------------------------------------------------------------------------
create table if not exists public.energy_resource_payout_gate_states (
  id                             uuid primary key default gen_random_uuid(),
  payee_id                       text not null,
  parcel_id                      text not null,
  environmental_compliance_state text not null,
  title_ownership_state          text not null,
  evidence_ref                   text not null,
  verified_by                    text not null,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  unique (payee_id, parcel_id),
  constraint ck_energy_resource_payout_gate_states_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_energy_resource_payout_gate_states_parcel_present
    check (char_length(parcel_id) > 0),
  constraint ck_energy_resource_payout_gate_states_environmental_state_vocabulary
    check (environmental_compliance_state IN ('unknown', 'cleared')),
  constraint ck_energy_resource_payout_gate_states_title_state_vocabulary
    check (title_ownership_state IN ('unknown', 'verified')),
  constraint ck_energy_resource_payout_gate_states_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_energy_resource_payout_gate_states_verifier_present
    check (char_length(verified_by) > 0)
);

comment on table public.energy_resource_payout_gate_states is
  'The durable resource payout-gate states of record per (payee_id, parcel_id) (migration 0053) — the environmental regulatory compliance clearance and the title ownership verification the resource payout gate reads FAIL-CLOSED: an absent row resolves null (refused) and an unknown state refuses the specific condition. UNIQUE (payee_id, parcel_id): an upsert converges.';

-- =============================================================================
-- ROW LEVEL SECURITY — deny-all. The service role reaches these tables
-- through the store's service client; no other role reads or writes.
-- =============================================================================

alter table public.energy_resource_audit_escrow_policies enable row level security;
drop policy if exists energy_resource_audit_escrow_policies_service_role_all
  on public.energy_resource_audit_escrow_policies;
create policy energy_resource_audit_escrow_policies_service_role_all
  on public.energy_resource_audit_escrow_policies
  for all
  using (false)
  with check (false);

alter table public.energy_resource_audit_escrow_drawdowns enable row level security;
drop policy if exists energy_resource_audit_escrow_drawdowns_service_role_all
  on public.energy_resource_audit_escrow_drawdowns;
create policy energy_resource_audit_escrow_drawdowns_service_role_all
  on public.energy_resource_audit_escrow_drawdowns
  for all
  using (false)
  with check (false);

alter table public.energy_resource_audit_escrow_reconciliations enable row level security;
drop policy if exists energy_resource_audit_escrow_reconciliations_service_role_all
  on public.energy_resource_audit_escrow_reconciliations;
create policy energy_resource_audit_escrow_reconciliations_service_role_all
  on public.energy_resource_audit_escrow_reconciliations
  for all
  using (false)
  with check (false);

alter table public.energy_resource_payout_gate_states enable row level security;
drop policy if exists energy_resource_payout_gate_states_service_role_all
  on public.energy_resource_payout_gate_states;
create policy energy_resource_payout_gate_states_service_role_all
  on public.energy_resource_payout_gate_states
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.energy_resource_audit_escrow_policies to service_role;
grant select, insert, update, delete on public.energy_resource_audit_escrow_drawdowns to service_role;
grant select, insert, update, delete on public.energy_resource_audit_escrow_reconciliations to service_role;
grant select, insert, update, delete on public.energy_resource_payout_gate_states to service_role;
