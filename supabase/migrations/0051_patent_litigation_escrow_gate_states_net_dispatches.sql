-- =============================================================================
-- 0051 — The patent litigation escrow: FRAND litigation protection for the
--        hardware patent lane, the durable payout-gate states, and the
--        cross-license net-dispatch execution (PR 47, the founder hardware
--        directive)
--
-- Five tables:
--
--   hardware_payout_gate_states       <- upsertHardwarePayoutGateState /
--                                        getHardwarePayoutGateState
--     (the durable FRAND + essentiality payout-gate states of record per
--      (payee_id, sep_pool_code). UNIQUE per that pair: an upsert
--      converges. The gate reads these FAIL-CLOSED: an absent record and
--      an 'unknown' state both refuse the payout.)
--
--   hardware_patent_litigation_escrow_policies
--                                     <- upsertPatentLitigationEscrowPolicy /
--                                        getPatentLitigationEscrowPolicy
--     (the escrow rate of record per scope_key — the founder band 1000 to
--      1500 bps, the ELEVATED 10–15% reserve. UNIQUE per scope_key: an
--      upsert converges.)
--
--   hardware_patent_litigation_escrow_drawdowns
--                                     <- insertPatentLitigationEscrowDrawdown /
--                                        listPatentLitigationEscrowDrawdowns
--     (the append-only drawdown truth — the position-locked executions of
--      record. UNIQUE per (reserve_ledger_id, source_event_id): the replay
--      guard AND the concurrency arbiter in one write. The conservation
--      CHECK pins remaining = before − drawn ≥ 0 per row.)
--
--   hardware_patent_litigation_escrow_reconciliations
--                                     <- insertPatentLitigationEscrowReconciliation /
--                                        getPatentLitigationEscrowReconciliation
--     (the verified reconciliation of record per escrow — the release
--      gate's key. UNIQUE per reserve_ledger_id: the FIRST reconciliation
--      wins, insert-as-lock.)
--
--   hardware_cross_license_net_dispatches
--                                     <- insertHardwareCrossLicenseNetDispatch /
--                                        listHardwareCrossLicenseNetDispatches
--     (the append-only net-dispatch execution of record per (agreement_ref,
--      period) — the clearing executions against the 0050 settlement of
--      record. UNIQUE per (agreement_ref, period, net_before_cents,
--      net_after_cents): two executions of the same settlement state
--      cannot both clear; net_before is in the tuple so a re-net that
--      revisits an earlier net cannot collide with the row that first
--      reached it.)
--
-- CONSTRAINT NAMING (the 0032 production lesson): every CHECK is a
-- TABLE-LEVEL constraint with an explicit ck_<table>_<what> name — column-
-- level CHECKs collide with table-level names on regeneration. No foreign
-- keys: the tables key on ledger transaction ids and text payee ids, the
-- hardware lane's own identifier space (the 0037–0050 discipline).
--
-- VOCABULARY (the PR 129/130 lesson — byte-identity with the TS unions
-- BEFORE CI): the SQL CHECK token lists below are byte-identical to
--   PATENT_LITIGATION_ESCROW_DRAWDOWN_CLASSES (src/modules/hardware/records.ts)
--   HardwarePayoutGateStateRecord's frand_determination_state and
--     essentiality_audit_state unions
--   HARDWARE_NET_DIRECTIONS (the 0050 direction vocabulary, reused)
-- and the parity floors match the CHECK floors exactly.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- hardware_payout_gate_states: the durable payout-gate states of record —
-- the two states the hardware patent payout gate reads, fail-closed.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_payout_gate_states (
  id                         uuid primary key default gen_random_uuid(),
  payee_id                   text not null,
  sep_pool_code              text not null,
  frand_determination_state  text not null,
  essentiality_audit_state   text not null,
  evidence_ref               text not null,
  verified_by                text not null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (payee_id, sep_pool_code),
  constraint ck_hardware_payout_gate_states_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_hardware_payout_gate_states_pool_present
    check (char_length(sep_pool_code) > 0),
  constraint ck_hardware_payout_gate_states_frand_state_vocabulary
    check (frand_determination_state IN ('unknown', 'cleared')),
  constraint ck_hardware_payout_gate_states_essentiality_state_vocabulary
    check (essentiality_audit_state IN ('unknown', 'verified')),
  constraint ck_hardware_payout_gate_states_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_hardware_payout_gate_states_verifier_present
    check (char_length(verified_by) > 0)
);

comment on table public.hardware_payout_gate_states is
  'The durable hardware payout-gate states of record per (payee_id, sep_pool_code) (migration 0051) — the FRAND rate court determination and the SEP essentiality audit the hardware patent payout gate reads FAIL-CLOSED: an absent row resolves null (refused) and an unknown state refuses the specific condition. UNIQUE (payee_id, sep_pool_code): an upsert converges.';

-- ---------------------------------------------------------------------------
-- hardware_patent_litigation_escrow_policies: the escrow rate of record —
-- the founder band, 1000–1500 bps (10–15%), per scope.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_patent_litigation_escrow_policies (
  id                uuid primary key default gen_random_uuid(),
  scope_key         text not null,
  reserve_rate_bps  bigint not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (scope_key),
  constraint ck_hardware_patent_litigation_escrow_policies_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_hardware_patent_litigation_escrow_policies_rate_in_founder_band
    check (reserve_rate_bps >= 1000 AND reserve_rate_bps <= 1500)
);

comment on table public.hardware_patent_litigation_escrow_policies is
  'The patent litigation escrow rate of record per scope_key (migration 0051) — licensor:{licensorPayeeId}:pool:{sepPoolCode} — the founder-banded ELEVATED 1000–1500 bps (10–15%) share of the scope''s hardware patent payouts that locks into the PATENT_LITIGATION_ESCROW bucket at routing, double the standard 5–10% verticals because patent litigation prices higher. The CHECK pins the band at the database too.';

-- ---------------------------------------------------------------------------
-- hardware_patent_litigation_escrow_drawdowns: the append-only drawdown
-- truth — global court rate redeterminations, anti-suit injunction
-- penalties, and cross-border patent validity challenges spending the
-- escrow, position-locked.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_patent_litigation_escrow_drawdowns (
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
  constraint ck_hardware_patent_litigation_escrow_drawdowns_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_hardware_patent_litigation_escrow_drawdowns_class_vocabulary
    check (drawdown_class IN ('global_court_rate_redetermination', 'anti_suit_injunction_penalty', 'cross_border_patent_validity_challenge')),
  constraint ck_hardware_patent_litigation_escrow_drawdowns_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_hardware_patent_litigation_escrow_drawdowns_amount_positive
    check (drawn_cents > 0),
  constraint ck_hardware_patent_litigation_escrow_drawdowns_before_non_negative
    check (drawn_before_cents >= 0),
  constraint ck_hardware_patent_litigation_escrow_drawdowns_position_conserves
    check (remaining_cents = drawn_before_cents - drawn_cents AND remaining_cents >= 0)
);

comment on table public.hardware_patent_litigation_escrow_drawdowns is
  'The append-only patent litigation escrow drawdown truth (migration 0051) — one row per litigation exposure executed against one escrow''s balance: a global court rate redetermination, an anti-suit injunction penalty, or a cross-border patent validity challenge. UNIQUE (reserve_ledger_id, source_event_id): the replay guard AND the concurrency arbiter — the position-locked insert before the money moves. The conservation CHECK pins remaining = before − drawn ≥ 0 per row; the balance derives from this append-only truth, never a mutable counter.';

-- ---------------------------------------------------------------------------
-- hardware_patent_litigation_escrow_reconciliations: the verified
-- reconciliation of record — the release gate's key, insert-as-lock.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_patent_litigation_escrow_reconciliations (
  id                 uuid primary key default gen_random_uuid(),
  reserve_ledger_id  uuid not null,
  evidence_ref       text not null,
  reconciled_by      text not null,
  created_at         timestamptz not null default now(),
  unique (reserve_ledger_id),
  constraint ck_hardware_patent_litigation_escrow_reconciliations_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_hardware_patent_litigation_escrow_reconciliations_reconciler_present
    check (char_length(reconciled_by) > 0)
);

comment on table public.hardware_patent_litigation_escrow_reconciliations is
  'The verified reconciliation of record per patent litigation escrow (migration 0051) — the release gate''s key. UNIQUE (reserve_ledger_id): insert-as-lock, the FIRST reconciliation wins; the release reads it fail-closed — no reconciliation of record, no release.';

-- ---------------------------------------------------------------------------
-- hardware_cross_license_net_dispatches: the append-only net-dispatch
-- execution of record — the clearing executions against the 0050
-- settlement of record.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_cross_license_net_dispatches (
  id                       uuid primary key default gen_random_uuid(),
  agreement_ref            text not null,
  company_a_id             text not null,
  company_b_id             text not null,
  period                   text not null,
  currency                 text not null,
  net_before_cents         bigint not null,
  net_after_cents          bigint not null,
  dispatched_delta_cents   bigint not null,
  a_gross_cleared_cents    bigint not null,
  b_gross_cleared_cents    bigint not null,
  direction                text not null,
  journal_id               uuid,
  created_at               timestamptz not null default now(),
  unique (agreement_ref, period, net_before_cents, net_after_cents),
  constraint ck_hardware_cross_license_net_dispatches_companies_present
    check (char_length(company_a_id) > 0 AND char_length(company_b_id) > 0),
  constraint ck_hardware_cross_license_net_dispatches_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_hardware_cross_license_net_dispatches_agreement_present
    check (char_length(agreement_ref) > 0),
  constraint ck_hardware_cross_license_net_dispatches_cleared_non_negative
    check (a_gross_cleared_cents >= 0 AND b_gross_cleared_cents >= 0),
  constraint ck_hardware_cross_license_net_dispatches_direction_vocabulary
    check (direction IN ('a_to_b', 'b_to_a', 'balanced')),
  constraint ck_hardware_cross_license_net_dispatches_direction_consistent
    check (
      (dispatched_delta_cents > 0 AND direction = 'a_to_b')
      OR (dispatched_delta_cents < 0 AND direction = 'b_to_a')
      OR (dispatched_delta_cents = 0 AND direction = 'balanced')
    ),
  constraint ck_hardware_cross_license_net_dispatches_position_conserves
    check (net_after_cents = net_before_cents + dispatched_delta_cents)
);

comment on table public.hardware_cross_license_net_dispatches is
  'The append-only cross-license net-dispatch execution of record per (agreement_ref, period) (migration 0051) — the clearing executions against the 0050 settlement of record: the delta the execution moved against the period''s netting position, with the cumulative gross liabilities cleared after this dispatch. UNIQUE (agreement_ref, period, net_before_cents, net_after_cents): the replay guard AND the concurrency arbiter — two executions of the same settlement state cannot both clear; net_before is in the tuple so a re-net that revisits an earlier net cannot collide with the row that first reached it. Late re-netting to a higher total dispatches the increment; late re-netting to a lower total routes the refund back — the dispatch ledger always reconciles to the settlement of record''s CURRENT sums.';

-- The RLS deny-all posture — every hardware lane table is hardware-lane
-- only (the 0043–0050 discipline; the probes verify deny for
-- authenticated).

alter table public.hardware_payout_gate_states enable row level security;
drop policy if exists hardware_payout_gate_states_service_role_all
  on public.hardware_payout_gate_states;
create policy hardware_payout_gate_states_service_role_all
  on public.hardware_payout_gate_states
  for all
  using (false)
  with check (false);

alter table public.hardware_patent_litigation_escrow_policies enable row level security;
drop policy if exists hardware_patent_litigation_escrow_policies_service_role_all
  on public.hardware_patent_litigation_escrow_policies;
create policy hardware_patent_litigation_escrow_policies_service_role_all
  on public.hardware_patent_litigation_escrow_policies
  for all
  using (false)
  with check (false);

alter table public.hardware_patent_litigation_escrow_drawdowns enable row level security;
drop policy if exists hardware_patent_litigation_escrow_drawdowns_service_role_all
  on public.hardware_patent_litigation_escrow_drawdowns;
create policy hardware_patent_litigation_escrow_drawdowns_service_role_all
  on public.hardware_patent_litigation_escrow_drawdowns
  for all
  using (false)
  with check (false);

alter table public.hardware_patent_litigation_escrow_reconciliations enable row level security;
drop policy if exists hardware_patent_litigation_escrow_reconciliations_service_role_all
  on public.hardware_patent_litigation_escrow_reconciliations;
create policy hardware_patent_litigation_escrow_reconciliations_service_role_all
  on public.hardware_patent_litigation_escrow_reconciliations
  for all
  using (false)
  with check (false);

alter table public.hardware_cross_license_net_dispatches enable row level security;
drop policy if exists hardware_cross_license_net_dispatches_service_role_all
  on public.hardware_cross_license_net_dispatches;
create policy hardware_cross_license_net_dispatches_service_role_all
  on public.hardware_cross_license_net_dispatches
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.hardware_payout_gate_states to service_role;
grant select, insert, update, delete on public.hardware_patent_litigation_escrow_policies to service_role;
grant select, insert, update, delete on public.hardware_patent_litigation_escrow_drawdowns to service_role;
grant select, insert, update, delete on public.hardware_patent_litigation_escrow_reconciliations to service_role;
grant select, insert, update, delete on public.hardware_cross_license_net_dispatches to service_role;
