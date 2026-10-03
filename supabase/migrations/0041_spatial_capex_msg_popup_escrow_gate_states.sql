-- =============================================================================
-- 0041 — The spatial commitments' durable facts of record (PR 37)
--
-- The founder spatial directive's second wave, per the brief:
--
--   spatial_capex_commitments        <- upsertSpatialCapexCommitment /
--                                       getSpatialCapexCommitment /
--                                       listSpatialCapexCommitments
--     (the allowable CapEx commitment of record per (scope_key, capex_ref):
--      the ride construction and venue build-out costs that recoup against
--      the scope's early-stage IP royalty payouts before the IP owner is
--      paid. UNIQUE per (scope_key, capex_ref): an upsert converges — the
--      newest registered cost governs the next offset walk. The cumulative
--      recouped position rides the append-only applications ledger; the
--      CHECK pins recouped <= capex so an over-recouped commitment cannot
--      persist.)
--
--   spatial_capex_applications       <- insertSpatialCapexApplication /
--                                       listSpatialCapexApplications
--     (the append-only CapEx recoupment application of record per source
--      event: the royalty amount, the offset leg taken (the remaining
--      allowable balance at walk time), and the position before/after.
--      UNIQUE per (commitment_id, source_event_id) is the replay guard; a
--      re-walked royalty throws, never a double offset. UNIQUE per
--      (commitment_id, offset_before_cents) is the lost-race position
--      lock: two concurrent walks of the same commitment cannot both
--      commit from the same position — the loser re-derives from the
--      append-only truth. The before/after arithmetic is pinned in a
--      CHECK.)
--
--   spatial_msg_commitments          <- upsertSpatialMsgCommitment /
--                                       getSpatialMsgCommitment
--     (the Minimum Spatial Guarantee terms of record per scope_key: the
--      reserved venue footprint (sqft) and the quarterly guarantee rate
--      (micro-dollars per reserved sqft) priced from the founder
--      directive's reserved-footprint basis. UNIQUE per scope_key: an
--      upsert converges — the newest priced terms govern the next
--      quarterly close.)
--
--   spatial_msg_term_closes          <- upsertSpatialMsgTermClose /
--                                       getSpatialMsgTermClose
--     (the quarterly MSG close of record per (commitment_id, quarter):
--      the guarantee due, the scope's spatial royalty earnings of record
--      at close, and the shortfall (MAX due − earned, pinned in a CHECK)
--      that debits msg_shortfall_due against the operator of record.
--      UNIQUE per (commitment_id, quarter) is the once-only close — a
--      replay converges on the recorded shortfall and invoice. The
--      shortfall may be zero (the guarantee was met); only a positive
--      shortfall carries an invoice ledger id — pinned in a CHECK.)
--
--   spatial_popup_experiences        <- insertSpatialPopupExperience /
--                                       getSpatialPopupExperience
--     (the temporary pop-up experience of record per popup_ref — the
--      90-day Halloween and seasonal IP experiences. UNIQUE per
--      popup_ref: insert-as-lock — the FIRST registration wins; a
--      re-shipped sheet or a lost race throws. The event window is
--      pinned end >= start in a CHECK.)
--
--   spatial_popup_writeoffs          <- insertSpatialPopupWriteoff /
--                                       listSpatialPopupWriteoffs
--     (the post-event inventory write-off calculation of record per
--      source event: unsold units × unit cost = the write-off the
--      operator bears before final escrow disbursement. UNIQUE per
--      (popup_experience_id, source_event_id) is the replay guard — a
--      replayed calculation throws, never a double-priced write-off. The
--      arithmetic is pinned in a CHECK.)
--
--   spatial_popup_restoration_reserves
--                                    <- insertSpatialPopupRestorationReserve /
--                                       getSpatialPopupRestorationReserve
--     (the site restoration reserve of record per pop-up experience —
--      the funded restoration amount held against site damage before
--      final escrow disbursement. UNIQUE per popup_experience_id:
--      insert-as-lock — the FIRST reserve wins; a concurrent second
--      insert throws.)
--
--   spatial_audit_escrow_policies    <- upsertSpatialAuditEscrowPolicy /
--                                       getSpatialAuditEscrowPolicy
--     (the SPATIAL_AUDIT_ESCROW policy of record per scope_key: the
--      founder-banded reserve rate — 5% to 12% of the scope's park
--      earnings, pinned in a CHECK. UNIQUE per scope_key: an upsert
--      converges — the newest rate governs the next routing. ABSENT
--      policy = no escrow routing — routing is never guessed.)
--
--   spatial_audit_escrow_drawdowns   <- insertSpatialAuditEscrowDrawdown /
--                                       listSpatialAuditEscrowDrawdowns
--     (the append-only escrow drawdown of record per source event: the
--      drawdown class ('entertainment_sales_tax' — local entertainment
--      sales taxes; 'safety_compliance_holdback' — safety compliance
--      holdbacks; 'concession_reconciliation' — quarterly park
--      concession reconciliations), the amount drawn, and the escrow
--      position before/after. UNIQUE per (reserve_ledger_id,
--      source_event_id) is the replay guard; UNIQUE per
--      (reserve_ledger_id, drawn_before_cents) is the lost-race position
--      lock — a re-routed tax or a lost race throws, never a double
--      drawdown. The before/after arithmetic is pinned in a CHECK.)
--
--   spatial_audit_escrow_reconciliations
--                                    <- insertSpatialAuditEscrowReconciliation /
--                                       getSpatialAuditEscrowReconciliation
--     (the verified escrow reconciliation of record per reserve ledger —
--      the evidence that opens the release of the remaining escrow
--      (fail-closed: no reconciliation of record, no release). UNIQUE
--      per reserve_ledger_id: insert-as-lock — the FIRST reconciliation
--      of record wins; a concurrent second insert throws.)
--
--   spatial_payout_gate_states       <- upsertSpatialPayoutGateState /
--                                       getSpatialPayoutGateState
--     (the durable spatial payout-gate state of record per (payee_id,
--      venue_id): territorial_zoning_cleared and spatial_audit_verified
--      — the states the spatial payout gate reads, fail-closed when the
--      record is ABSENT or either state is 'unknown'. UNIQUE per
--      (payee_id, venue_id): an upsert converges — a verification heals
--      'unknown'; states never regress through this table.)
--
-- The 0032 lesson, applied: every CHECK is an explicitly named TABLE-level
-- constraint (ck_*) — column-level checks collide with table-level ones of
-- the same shape.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- spatial_capex_commitments: the allowable CapEx commitment of record per
-- (scope, capex_ref) — the recoupment pool the offset walk drains.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_capex_commitments (
  id                 uuid primary key default gen_random_uuid(),
  scope_key          text not null,
  capex_ref          text not null,
  operator_id        text not null,
  capex_category     text not null,
  capex_amount_cents bigint not null,
  recouped_cents     bigint not null default 0,
  currency           text not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (scope_key, capex_ref),
  constraint ck_spatial_capex_commitments_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_spatial_capex_commitments_ref_present
    check (char_length(capex_ref) > 0),
  constraint ck_spatial_capex_commitments_operator_present
    check (char_length(operator_id) > 0),
  constraint ck_spatial_capex_commitments_category
    check (capex_category in ('ride_construction', 'venue_buildout')),
  constraint ck_spatial_capex_commitments_amount_positive
    check (capex_amount_cents > 0),
  constraint ck_spatial_capex_commitments_recouped_nonneg
    check (recouped_cents >= 0),
  constraint ck_spatial_capex_commitments_recouped_capped
    check (recouped_cents <= capex_amount_cents),
  constraint ck_spatial_capex_commitments_currency_present
    check (char_length(currency) > 0)
);

comment on table public.spatial_capex_commitments is
  'The allowable CapEx commitment of record (migration 0041) per (scope_key, capex_ref): the ride construction and venue build-out costs that recoup against the scope''s early-stage IP royalty payouts before the IP owner is paid. UNIQUE (scope_key, capex_ref): an upsert converges — the newest registered cost governs the next offset walk. The cumulative recouped position rides the append-only applications ledger; recouped <= capex is pinned in a CHECK.';

-- ---------------------------------------------------------------------------
-- spatial_capex_applications: the append-only CapEx recoupment application
-- of record per source event — replay-guarded and position-locked.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_capex_applications (
  id                 uuid primary key default gen_random_uuid(),
  commitment_id      uuid not null,
  scope_key          text not null,
  capex_category     text not null,
  source_event_id    text not null,
  royalty_stream     text not null,
  royalty_cents      bigint not null,
  offset_before_cents bigint not null,
  offset_cents       bigint not null,
  offset_after_cents bigint not null,
  created_at         timestamptz not null default now(),
  unique (commitment_id, source_event_id),
  unique (commitment_id, offset_before_cents),
  constraint ck_spatial_capex_applications_category
    check (capex_category in ('ride_construction', 'venue_buildout')),
  constraint ck_spatial_capex_applications_stream
    check (royalty_stream in ('occupancy', 'zone', 'micro')),
  constraint ck_spatial_capex_applications_royalty_nonneg
    check (royalty_cents >= 0),
  constraint ck_spatial_capex_applications_before_nonneg
    check (offset_before_cents >= 0),
  constraint ck_spatial_capex_applications_offset_positive
    check (offset_cents > 0),
  constraint ck_spatial_capex_applications_after_nonneg
    check (offset_after_cents >= 0),
  constraint ck_spatial_capex_applications_position_arithmetic
    check (offset_after_cents = offset_before_cents + offset_cents)
);

comment on table public.spatial_capex_applications is
  'The append-only CapEx recoupment application of record (migration 0041) per source event: the royalty amount, the offset leg taken (the remaining allowable balance at walk time), and the position before/after. UNIQUE (commitment_id, source_event_id) is the replay guard; UNIQUE (commitment_id, offset_before_cents) is the lost-race position lock — a re-walked royalty or a lost race throws, never a double offset. The before/after arithmetic is pinned in a CHECK.';

-- ---------------------------------------------------------------------------
-- spatial_msg_commitments: the Minimum Spatial Guarantee terms of record per
-- scope — reserved-footprint priced.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_msg_commitments (
  id                             uuid primary key default gen_random_uuid(),
  scope_key                      text not null,
  operator_id                    text not null,
  operator_name                  text not null,
  venue_id                       text not null,
  reserved_footprint_sqft        bigint not null,
  quarterly_rate_micros_per_sqft bigint not null,
  currency                       text not null,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  unique (scope_key),
  constraint ck_spatial_msg_commitments_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_spatial_msg_commitments_operator_present
    check (char_length(operator_id) > 0),
  constraint ck_spatial_msg_commitments_operator_name_present
    check (char_length(operator_name) > 0),
  constraint ck_spatial_msg_commitments_venue_present
    check (char_length(venue_id) > 0),
  constraint ck_spatial_msg_commitments_footprint_positive
    check (reserved_footprint_sqft > 0),
  constraint ck_spatial_msg_commitments_rate_positive
    check (quarterly_rate_micros_per_sqft > 0),
  constraint ck_spatial_msg_commitments_currency_present
    check (char_length(currency) > 0)
);

comment on table public.spatial_msg_commitments is
  'The Minimum Spatial Guarantee terms of record (migration 0041) per scope_key: the reserved venue footprint (sqft) and the quarterly guarantee rate (micro-dollars per reserved sqft) priced from the founder directive''s reserved-footprint basis. UNIQUE (scope_key): an upsert converges — the newest priced terms govern the next quarterly close.';

-- ---------------------------------------------------------------------------
-- spatial_msg_term_closes: the quarterly MSG close of record per
-- (commitment, quarter) — once-only, shortfall never guessed.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_msg_term_closes (
  id                    uuid primary key default gen_random_uuid(),
  commitment_id         uuid not null,
  scope_key             text not null,
  quarter               text not null,
  msg_due_cents         bigint not null,
  earned_at_close_cents bigint not null,
  shortfall_cents       bigint not null,
  invoice_ledger_id     uuid,
  closed_by             text not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (commitment_id, quarter),
  constraint ck_spatial_msg_term_closes_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_spatial_msg_term_closes_quarter_format
    check (quarter ~ '^[0-9]{4}-Q[1-4]$'),
  constraint ck_spatial_msg_term_closes_due_nonneg
    check (msg_due_cents >= 0),
  constraint ck_spatial_msg_term_closes_earned_nonneg
    check (earned_at_close_cents >= 0),
  constraint ck_spatial_msg_term_closes_shortfall_nonneg
    check (shortfall_cents >= 0),
  constraint ck_spatial_msg_term_closes_shortfall_arithmetic
    check (shortfall_cents = greatest(msg_due_cents - earned_at_close_cents, 0)),
  constraint ck_spatial_msg_term_closes_invoice_only_on_shortfall
    check (shortfall_cents > 0 or invoice_ledger_id is null)
);

comment on table public.spatial_msg_term_closes is
  'The quarterly MSG close of record (migration 0041) per (commitment_id, quarter): the guarantee due, the scope''s spatial royalty earnings of record at close, and the shortfall (greatest(due − earned, 0), pinned in a CHECK) that debits msg_shortfall_due against the operator of record. UNIQUE (commitment_id, quarter) is the once-only close — a replay converges on the recorded shortfall and invoice. Only a positive shortfall carries an invoice ledger id — pinned in a CHECK.';

-- ---------------------------------------------------------------------------
-- spatial_popup_experiences: the temporary pop-up experience of record —
-- insert-as-locked per popup_ref.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_popup_experiences (
  id                uuid primary key default gen_random_uuid(),
  popup_ref         text not null,
  venue_id          text not null,
  zone_code         text not null,
  operator_id       text not null,
  experience_kind   text not null,
  window_start_date text not null,
  window_end_date   text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (popup_ref),
  constraint ck_spatial_popup_experiences_ref_present
    check (char_length(popup_ref) > 0),
  constraint ck_spatial_popup_experiences_venue_present
    check (char_length(venue_id) > 0),
  constraint ck_spatial_popup_experiences_zone_present
    check (char_length(zone_code) > 0),
  constraint ck_spatial_popup_experiences_operator_present
    check (char_length(operator_id) > 0),
  constraint ck_spatial_popup_experiences_kind_present
    check (char_length(experience_kind) > 0),
  constraint ck_spatial_popup_experiences_window_order
    check (window_end_date >= window_start_date)
);

comment on table public.spatial_popup_experiences is
  'The temporary pop-up experience of record (migration 0041) per popup_ref — the 90-day Halloween and seasonal IP experiences. UNIQUE (popup_ref): insert-as-lock — the FIRST registration wins; a re-shipped sheet or a lost race throws. The event window end >= start is pinned in a CHECK.';

-- ---------------------------------------------------------------------------
-- spatial_popup_writeoffs: the post-event inventory write-off calculation
-- of record per source event.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_popup_writeoffs (
  id                  uuid primary key default gen_random_uuid(),
  popup_experience_id uuid not null,
  popup_ref           text not null,
  source_event_id     text not null,
  unsold_units        bigint not null,
  unit_cost_cents     bigint not null,
  writeoff_cents      bigint not null,
  evidence_ref        text not null,
  calculated_by       text not null,
  created_at          timestamptz not null default now(),
  unique (popup_experience_id, source_event_id),
  constraint ck_spatial_popup_writeoffs_ref_present
    check (char_length(popup_ref) > 0),
  constraint ck_spatial_popup_writeoffs_units_nonneg
    check (unsold_units >= 0),
  constraint ck_spatial_popup_writeoffs_unit_cost_nonneg
    check (unit_cost_cents >= 0),
  constraint ck_spatial_popup_writeoffs_amount_nonneg
    check (writeoff_cents >= 0),
  constraint ck_spatial_popup_writeoffs_arithmetic
    check (writeoff_cents = unsold_units * unit_cost_cents),
  constraint ck_spatial_popup_writeoffs_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_spatial_popup_writeoffs_calculator_present
    check (char_length(calculated_by) > 0)
);

comment on table public.spatial_popup_writeoffs is
  'The post-event inventory write-off calculation of record (migration 0041) per source event: unsold units × unit cost = the write-off the operator bears before final escrow disbursement. UNIQUE (popup_experience_id, source_event_id) is the replay guard — a replayed calculation throws, never a double-priced write-off. The arithmetic is pinned in a CHECK.';

-- ---------------------------------------------------------------------------
-- spatial_popup_restoration_reserves: the site restoration reserve of record
-- per pop-up experience — insert-as-locked.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_popup_restoration_reserves (
  id                  uuid primary key default gen_random_uuid(),
  popup_experience_id uuid not null,
  popup_ref           text not null,
  reserve_cents       bigint not null,
  evidence_ref        text not null,
  funded_by           text not null,
  created_at          timestamptz not null default now(),
  unique (popup_experience_id),
  constraint ck_spatial_popup_restoration_reserves_ref_present
    check (char_length(popup_ref) > 0),
  constraint ck_spatial_popup_restoration_reserves_amount_nonneg
    check (reserve_cents >= 0),
  constraint ck_spatial_popup_restoration_reserves_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_spatial_popup_restoration_reserves_funder_present
    check (char_length(funded_by) > 0)
);

comment on table public.spatial_popup_restoration_reserves is
  'The site restoration reserve of record (migration 0041) per pop-up experience — the funded restoration amount held against site damage before final escrow disbursement. UNIQUE (popup_experience_id): insert-as-lock — the FIRST reserve wins; a concurrent second insert throws.';

-- ---------------------------------------------------------------------------
-- spatial_audit_escrow_policies: the SPATIAL_AUDIT_ESCROW policy of record
-- per scope — the founder-banded 5–12% reserve rate.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_audit_escrow_policies (
  id               uuid primary key default gen_random_uuid(),
  scope_key        text not null,
  reserve_rate_bps integer not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (scope_key),
  constraint ck_spatial_audit_escrow_policies_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_spatial_audit_escrow_policies_rate_band
    check (reserve_rate_bps >= 500 and reserve_rate_bps <= 1200)
);

comment on table public.spatial_audit_escrow_policies is
  'The SPATIAL_AUDIT_ESCROW policy of record (migration 0041) per scope_key: the founder-banded reserve rate — 5% (500 bps) to 12% (1200 bps) of the scope''s park earnings, pinned in a CHECK. UNIQUE (scope_key): an upsert converges — the newest rate governs the next routing. ABSENT policy = no escrow routing — routing is never guessed.';

-- ---------------------------------------------------------------------------
-- spatial_audit_escrow_drawdowns: the append-only escrow drawdown of record
-- per source event — replay-guarded and position-locked.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_audit_escrow_drawdowns (
  id                 uuid primary key default gen_random_uuid(),
  reserve_ledger_id  uuid not null,
  scope_key          text not null,
  drawdown_class     text not null,
  source_event_id    text not null,
  drawn_before_cents bigint not null,
  drawn_cents        bigint not null,
  remaining_cents    bigint not null,
  created_at         timestamptz not null default now(),
  unique (reserve_ledger_id, source_event_id),
  unique (reserve_ledger_id, drawn_before_cents),
  constraint ck_spatial_audit_escrow_drawdowns_class
    check (drawdown_class in (
      'entertainment_sales_tax', 'safety_compliance_holdback', 'concession_reconciliation')),
  constraint ck_spatial_audit_escrow_drawdowns_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_spatial_audit_escrow_drawdowns_before_nonneg
    check (drawn_before_cents >= 0),
  constraint ck_spatial_audit_escrow_drawdowns_amount_positive
    check (drawn_cents > 0),
  constraint ck_spatial_audit_escrow_drawdowns_remaining_nonneg
    check (remaining_cents >= 0),
  constraint ck_spatial_audit_escrow_drawdowns_position_arithmetic
    check (remaining_cents = drawn_before_cents - drawn_cents)
);

comment on table public.spatial_audit_escrow_drawdowns is
  'The append-only escrow drawdown of record (migration 0041) per source event: the drawdown class (local entertainment sales taxes, safety compliance holdbacks, quarterly park concession reconciliations), the amount drawn, and the escrow position before/after. UNIQUE (reserve_ledger_id, source_event_id) is the replay guard; UNIQUE (reserve_ledger_id, drawn_before_cents) is the lost-race position lock — a re-routed tax or a lost race throws, never a double drawdown. The before/after arithmetic is pinned in a CHECK.';

-- ---------------------------------------------------------------------------
-- spatial_audit_escrow_reconciliations: the verified reconciliation of
-- record per reserve ledger — the release gate's evidence.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_audit_escrow_reconciliations (
  id                uuid primary key default gen_random_uuid(),
  reserve_ledger_id uuid not null,
  evidence_ref      text not null,
  reconciled_by     text not null,
  created_at        timestamptz not null default now(),
  unique (reserve_ledger_id),
  constraint ck_spatial_audit_escrow_reconciliations_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_spatial_audit_escrow_reconciliations_verifier_present
    check (char_length(reconciled_by) > 0)
);

comment on table public.spatial_audit_escrow_reconciliations is
  'The verified escrow reconciliation of record (migration 0041) per reserve ledger — the evidence that opens the release of the remaining escrow (fail-closed: no reconciliation of record, no release). UNIQUE (reserve_ledger_id): insert-as-lock — the FIRST reconciliation of record wins; a concurrent second insert throws.';

-- ---------------------------------------------------------------------------
-- spatial_payout_gate_states: the durable spatial payout-gate state of
-- record per (payee, venue) — fail-closed when absent or unknown.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_payout_gate_states (
  id                        uuid primary key default gen_random_uuid(),
  payee_id                  text not null,
  venue_id                  text not null,
  territorial_zoning_state  text not null,
  spatial_audit_state       text not null,
  evidence_ref              text not null,
  verified_by               text not null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (payee_id, venue_id),
  constraint ck_spatial_payout_gate_states_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_spatial_payout_gate_states_venue_present
    check (char_length(venue_id) > 0),
  constraint ck_spatial_payout_gate_states_zoning_state
    check (territorial_zoning_state in ('unknown', 'cleared')),
  constraint ck_spatial_payout_gate_states_audit_state
    check (spatial_audit_state in ('unknown', 'verified')),
  constraint ck_spatial_payout_gate_states_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_spatial_payout_gate_states_verifier_present
    check (char_length(verified_by) > 0)
);

comment on table public.spatial_payout_gate_states is
  'The durable spatial payout-gate state of record (migration 0041) per (payee_id, venue_id): territorial_zoning_cleared and spatial_audit_verified — the states the spatial payout gate reads, fail-closed when the record is ABSENT or either state is ''unknown''. UNIQUE (payee_id, venue_id): an upsert converges — a verification heals ''unknown''; states never regress through this table.';

-- ---------------------------------------------------------------------------
-- Row Level Security — deny-all with the 0033 service-role grant set (the
-- 0017–0040 precedent): client roles read nothing; workers use the service
-- role.
-- ---------------------------------------------------------------------------

alter table public.spatial_capex_commitments enable row level security;
alter table public.spatial_capex_applications enable row level security;
alter table public.spatial_msg_commitments enable row level security;
alter table public.spatial_msg_term_closes enable row level security;
alter table public.spatial_popup_experiences enable row level security;
alter table public.spatial_popup_writeoffs enable row level security;
alter table public.spatial_popup_restoration_reserves enable row level security;
alter table public.spatial_audit_escrow_policies enable row level security;
alter table public.spatial_audit_escrow_drawdowns enable row level security;
alter table public.spatial_audit_escrow_reconciliations enable row level security;
alter table public.spatial_payout_gate_states enable row level security;

drop policy if exists spatial_capex_commitments_service_role_all
  on public.spatial_capex_commitments;
create policy spatial_capex_commitments_service_role_all
  on public.spatial_capex_commitments
  for all
  using (false)
  with check (false);

drop policy if exists spatial_capex_applications_service_role_all
  on public.spatial_capex_applications;
create policy spatial_capex_applications_service_role_all
  on public.spatial_capex_applications
  for all
  using (false)
  with check (false);

drop policy if exists spatial_msg_commitments_service_role_all
  on public.spatial_msg_commitments;
create policy spatial_msg_commitments_service_role_all
  on public.spatial_msg_commitments
  for all
  using (false)
  with check (false);

drop policy if exists spatial_msg_term_closes_service_role_all
  on public.spatial_msg_term_closes;
create policy spatial_msg_term_closes_service_role_all
  on public.spatial_msg_term_closes
  for all
  using (false)
  with check (false);

drop policy if exists spatial_popup_experiences_service_role_all
  on public.spatial_popup_experiences;
create policy spatial_popup_experiences_service_role_all
  on public.spatial_popup_experiences
  for all
  using (false)
  with check (false);

drop policy if exists spatial_popup_writeoffs_service_role_all
  on public.spatial_popup_writeoffs;
create policy spatial_popup_writeoffs_service_role_all
  on public.spatial_popup_writeoffs
  for all
  using (false)
  with check (false);

drop policy if exists spatial_popup_restoration_reserves_service_role_all
  on public.spatial_popup_restoration_reserves;
create policy spatial_popup_restoration_reserves_service_role_all
  on public.spatial_popup_restoration_reserves
  for all
  using (false)
  with check (false);

drop policy if exists spatial_audit_escrow_policies_service_role_all
  on public.spatial_audit_escrow_policies;
create policy spatial_audit_escrow_policies_service_role_all
  on public.spatial_audit_escrow_policies
  for all
  using (false)
  with check (false);

drop policy if exists spatial_audit_escrow_drawdowns_service_role_all
  on public.spatial_audit_escrow_drawdowns;
create policy spatial_audit_escrow_drawdowns_service_role_all
  on public.spatial_audit_escrow_drawdowns
  for all
  using (false)
  with check (false);

drop policy if exists spatial_audit_escrow_reconciliations_service_role_all
  on public.spatial_audit_escrow_reconciliations;
create policy spatial_audit_escrow_reconciliations_service_role_all
  on public.spatial_audit_escrow_reconciliations
  for all
  using (false)
  with check (false);

drop policy if exists spatial_payout_gate_states_service_role_all
  on public.spatial_payout_gate_states;
create policy spatial_payout_gate_states_service_role_all
  on public.spatial_payout_gate_states
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.spatial_capex_commitments to service_role;
grant select, insert, update, delete on public.spatial_capex_applications to service_role;
grant select, insert, update, delete on public.spatial_msg_commitments to service_role;
grant select, insert, update, delete on public.spatial_msg_term_closes to service_role;
grant select, insert, update, delete on public.spatial_popup_experiences to service_role;
grant select, insert, update, delete on public.spatial_popup_writeoffs to service_role;
grant select, insert, update, delete on public.spatial_popup_restoration_reserves to service_role;
grant select, insert, update, delete on public.spatial_audit_escrow_policies to service_role;
grant select, insert, update, delete on public.spatial_audit_escrow_drawdowns to service_role;
grant select, insert, update, delete on public.spatial_audit_escrow_reconciliations to service_role;
grant select, insert, update, delete on public.spatial_payout_gate_states to service_role;
