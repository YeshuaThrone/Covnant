-- =============================================================================
-- 0045 — The culinary audit escrow: fail-closed kitchen payout-gate states,
--        the founder-banded escrow, position-locked drawdowns, the verified
--        reconciliation of record, and the viral-menu pop-up decommissioning
--        facts (PR 41)
--
-- The founder culinary directive, per the brief. Six tables:
--
--   culinary_audit_escrow_policies  <- upsertCulinaryAuditEscrowPolicy /
--                                      getCulinaryAuditEscrowPolicy
--     (one scope's escrow policy of record: the founder-banded 5–10% share
--      of the scope's culinary IP payouts that locks into the
--      CULINARY_AUDIT_ESCROW bucket at routing. UNIQUE per scope_key: an
--      upsert converges — the newest rate governs the next routing.
--      ABSENT policy = a counted fail-closed refusal — the router never
--      guesses a rate.)
--
--   culinary_audit_escrow_drawdowns <- insertCulinaryAuditEscrowDrawdown /
--                                      listCulinaryAuditEscrowDrawdowns
--     (the append-only escrow spend of record: customer refund
--      allowances, food spoilage chargebacks, and quarterly ingredient
--      supplier quality audits spending the bucket. UNIQUE per
--      (reserve_ledger_id, source_event_id) is the replay guard; UNIQUE
--      per (reserve_ledger_id, drawn_before_cents) is the position lock
--      the balance derives from; the drawn/remaining arithmetic is pinned
--      in a CHECK.)
--
--   culinary_audit_escrow_reconciliations
--                                   <- insertCulinaryAuditEscrowReconciliation /
--                                      getCulinaryAuditEscrowReconciliation
--     (the verified reconciliation of record per escrow bucket — the
--      release gate's key. UNIQUE per reserve_ledger_id is insert-as-lock:
--      the FIRST reconciliation wins, and the release reads it fail-closed
--      — no reconciliation of record, no release.)
--
--   culinary_payout_gate_states     <- upsertCulinaryPayoutGateState /
--                                      getCulinaryPayoutGateState
--     (the two durable states the culinary payout gate reads per
--      (payee, ghost kitchen): health_inspection_state and
--      territorial_exclusivity_state. The vocabulary is 'unknown' /
--      'cleared' and 'unknown' / 'verified' — an ABSENT row resolves null
--      and 'unknown' resolves false at the gate: fail-closed both ways.
--      UNIQUE per (payee_id, ghost_kitchen_location_code): an upsert
--      converges — a verification heals 'unknown'.)
--
--   culinary_popup_experiences      <- insertCulinaryPopupExperience /
--                                      getCulinaryPopupExperience
--     (one viral-menu pop-up campaign's window of record — the 30-day
--      limited time offer, the seasonal residency. UNIQUE per popup_ref is
--      insert-as-lock: the FIRST registration wins. The window of record
--      runs forward, pinned in a CHECK.)
--
--   culinary_popup_writeoffs        <- insertCulinaryPopupWriteoff /
--                                      listCulinaryPopupWriteoffs
--     (the append-only post-campaign packaging inventory write-off of
--      record per campaign: the decommissioning fact a pop-up scope's
--      escrow release reads — no write-off of record, no release. UNIQUE
--      per (popup_experience_id, source_event_id) is the replay guard;
--      the write-off's arithmetic (unsold × unit cost, integer cents) is
--      pinned in a CHECK.)
--
-- The 0032 lesson, applied: every CHECK is an explicitly named TABLE-level
-- constraint (ck_*) — column-level checks collide with table-level ones of
-- the same shape. No foreign keys by design — the tables key on the
-- senders' chef/payee/popup identifiers, content-derived event ids, and
-- ledger transaction ids (the 0036–0044 discipline; no fk_* constraints
-- exist to name).
--
-- The PR 129 lesson, applied: the drawdown-class and gate-state
-- vocabularies in these CHECKs are byte-identical to the TS-side arrays
-- (CULINARY_AUDIT_ESCROW_DRAWDOWN_CLASSES and the 'unknown'/'cleared',
-- 'unknown'/'verified' union types) — verified before CI.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- culinary_audit_escrow_policies: one scope's escrow rate of record — the
-- founder band, enforced here and again at use.
-- ---------------------------------------------------------------------------
create table if not exists public.culinary_audit_escrow_policies (
  id                uuid primary key default gen_random_uuid(),
  scope_key         text not null,
  reserve_rate_bps  bigint not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (scope_key),
  constraint ck_culinary_audit_escrow_policies_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_culinary_audit_escrow_policies_rate_founder_band
    check (reserve_rate_bps >= 500 AND reserve_rate_bps <= 1000)
);

comment on table public.culinary_audit_escrow_policies is
  'One scope''s culinary audit-escrow policy of record (migration 0045): the founder-banded 500–1000 bps share of the scope''s culinary IP payouts that locks into the CULINARY_AUDIT_ESCROW bucket at routing. UNIQUE (scope_key): an upsert converges — the newest rate governs the next routing. ABSENT policy = a counted fail-closed refusal (the router never guesses a rate).';

-- ---------------------------------------------------------------------------
-- culinary_audit_escrow_drawdowns: the append-only escrow spend of record —
-- refund allowances, spoilage chargebacks, supplier quality audits.
-- ---------------------------------------------------------------------------
create table if not exists public.culinary_audit_escrow_drawdowns (
  id                    uuid primary key default gen_random_uuid(),
  reserve_ledger_id     text not null,
  scope_key             text not null,
  drawdown_class        text not null,
  source_event_id       text not null,
  drawn_before_cents    bigint not null,
  drawn_cents           bigint not null,
  remaining_cents       bigint not null,
  created_at            timestamptz not null default now(),
  unique (reserve_ledger_id, source_event_id),
  unique (reserve_ledger_id, drawn_before_cents),
  constraint ck_culinary_audit_escrow_drawdowns_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_culinary_audit_escrow_drawdowns_class_vocabulary
    check (drawdown_class IN ('refund_allowance', 'spoilage_chargeback', 'supplier_quality_audit')),
  constraint ck_culinary_audit_escrow_drawdowns_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_culinary_audit_escrow_drawdowns_amount_positive
    check (drawn_cents > 0),
  constraint ck_culinary_audit_escrow_drawdowns_position_non_negative
    check (drawn_before_cents >= 0),
  constraint ck_culinary_audit_escrow_drawdowns_remaining_non_negative
    check (remaining_cents >= 0),
  constraint ck_culinary_audit_escrow_drawdowns_conservation
    check (remaining_cents = drawn_before_cents - drawn_cents)
);

comment on table public.culinary_audit_escrow_drawdowns is
  'The append-only culinary audit-escrow spend of record (migration 0045): customer refund allowances, food spoilage chargebacks, and quarterly ingredient supplier quality audits. UNIQUE (reserve_ledger_id, source_event_id) is the replay guard; UNIQUE (reserve_ledger_id, drawn_before_cents) is the position lock the balance derives from; the drawn/remaining arithmetic is pinned in a CHECK.';

-- ---------------------------------------------------------------------------
-- culinary_audit_escrow_reconciliations: the verified reconciliation of
-- record — the release gate's key, insert-as-lock per bucket.
-- ---------------------------------------------------------------------------
create table if not exists public.culinary_audit_escrow_reconciliations (
  id                    uuid primary key default gen_random_uuid(),
  reserve_ledger_id     text not null,
  evidence_ref          text not null,
  reconciled_by         text not null,
  created_at            timestamptz not null default now(),
  unique (reserve_ledger_id),
  constraint ck_culinary_audit_escrow_reconciliations_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_culinary_audit_escrow_reconciliations_reconciler_present
    check (char_length(reconciled_by) > 0)
);

comment on table public.culinary_audit_escrow_reconciliations is
  'The verified reconciliation of record per culinary escrow bucket (migration 0045) — the release gate''s key. UNIQUE (reserve_ledger_id) is insert-as-lock: the FIRST reconciliation wins, and the release reads it fail-closed — no reconciliation of record, no release.';

-- ---------------------------------------------------------------------------
-- culinary_payout_gate_states: the two durable states the culinary payout
-- gate reads, fail-closed — 'unknown' and absent both refuse.
-- ---------------------------------------------------------------------------
create table if not exists public.culinary_payout_gate_states (
  id                            uuid primary key default gen_random_uuid(),
  payee_id                      text not null,
  ghost_kitchen_location_code   text not null,
  health_inspection_state       text not null,
  territorial_exclusivity_state text not null,
  evidence_ref                  text not null,
  verified_by                   text not null,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  unique (payee_id, ghost_kitchen_location_code),
  constraint ck_culinary_payout_gate_states_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_culinary_payout_gate_states_location_present
    check (char_length(ghost_kitchen_location_code) > 0),
  constraint ck_culinary_payout_gate_states_health_vocabulary
    check (health_inspection_state IN ('unknown', 'cleared')),
  constraint ck_culinary_payout_gate_states_territorial_vocabulary
    check (territorial_exclusivity_state IN ('unknown', 'verified')),
  constraint ck_culinary_payout_gate_states_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_culinary_payout_gate_states_verifier_present
    check (char_length(verified_by) > 0)
);

comment on table public.culinary_payout_gate_states is
  'The culinary payout gate''s durable states of record per (payee, ghost kitchen) (migration 0045): health_inspection_state and territorial_exclusivity_state. Vocabulary is ''unknown''/''cleared'' and ''unknown''/''verified'' — an ABSENT row resolves null and ''unknown'' resolves false at the gate: fail-closed both ways. UNIQUE (payee_id, ghost_kitchen_location_code): an upsert converges — a verification heals ''unknown''.';

-- ---------------------------------------------------------------------------
-- culinary_popup_experiences: one viral-menu pop-up campaign's window of
-- record — insert-as-lock on popup_ref.
-- ---------------------------------------------------------------------------
create table if not exists public.culinary_popup_experiences (
  id                          uuid primary key default gen_random_uuid(),
  popup_ref                   text not null,
  chef_id                     text not null,
  ghost_kitchen_location_code text not null,
  menu_theme                  text not null,
  window_start_date           text not null,
  window_end_date             text not null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (popup_ref),
  constraint ck_culinary_popup_experiences_ref_present
    check (char_length(popup_ref) > 0),
  constraint ck_culinary_popup_experiences_chef_present
    check (char_length(chef_id) > 0),
  constraint ck_culinary_popup_experiences_location_present
    check (char_length(ghost_kitchen_location_code) > 0),
  constraint ck_culinary_popup_experiences_theme_present
    check (char_length(menu_theme) > 0),
  constraint ck_culinary_popup_experiences_window_forward
    check (window_end_date >= window_start_date)
);

comment on table public.culinary_popup_experiences is
  'One viral-menu pop-up campaign''s window of record (migration 0045) — the 30-day limited time offer, the seasonal residency. UNIQUE (popup_ref) is insert-as-lock: the FIRST registration wins; a re-shipped sheet or a lost race surfaces as the named conflict. The window of record runs forward, pinned in a CHECK.';

-- ---------------------------------------------------------------------------
-- culinary_popup_writeoffs: the append-only post-campaign packaging
-- inventory write-off of record — the decommissioning fact a pop-up
-- scope's escrow release reads, fail-closed.
-- ---------------------------------------------------------------------------
create table if not exists public.culinary_popup_writeoffs (
  id                    uuid primary key default gen_random_uuid(),
  popup_experience_id   text not null,
  source_event_id       text not null,
  unsold_packages       bigint not null,
  unit_cost_cents       bigint not null,
  writeoff_cents        bigint not null,
  evidence_ref          text not null,
  calculated_by         text not null,
  created_at            timestamptz not null default now(),
  unique (popup_experience_id, source_event_id),
  constraint ck_culinary_popup_writeoffs_popup_present
    check (char_length(popup_experience_id) > 0),
  constraint ck_culinary_popup_writeoffs_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_culinary_popup_writeoffs_count_non_negative
    check (unsold_packages >= 0),
  constraint ck_culinary_popup_writeoffs_unit_cost_non_negative
    check (unit_cost_cents >= 0),
  constraint ck_culinary_popup_writeoffs_amount_non_negative
    check (writeoff_cents >= 0),
  constraint ck_culinary_popup_writeoffs_arithmetic
    check (writeoff_cents = unsold_packages * unit_cost_cents),
  constraint ck_culinary_popup_writeoffs_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_culinary_popup_writeoffs_calculator_present
    check (char_length(calculated_by) > 0)
);

comment on table public.culinary_popup_writeoffs is
  'The append-only post-campaign packaging inventory write-off of record per pop-up campaign (migration 0045) — the virtual-brand decommissioning fact a pop-up scope''s escrow release reads, fail-closed: no write-off of record, no release. UNIQUE (popup_experience_id, source_event_id) is the replay guard; the write-off arithmetic (unsold × unit cost, integer cents) is pinned in a CHECK.';

-- The RLS deny-all posture — every culinary table is service-lane only
-- (the 0043/0044 discipline; the probes verify deny for authenticated).

alter table public.culinary_audit_escrow_policies enable row level security;
drop policy if exists culinary_audit_escrow_policies_service_role_all
  on public.culinary_audit_escrow_policies;
create policy culinary_audit_escrow_policies_service_role_all
  on public.culinary_audit_escrow_policies
  for all
  using (false)
  with check (false);

alter table public.culinary_audit_escrow_drawdowns enable row level security;
drop policy if exists culinary_audit_escrow_drawdowns_service_role_all
  on public.culinary_audit_escrow_drawdowns;
create policy culinary_audit_escrow_drawdowns_service_role_all
  on public.culinary_audit_escrow_drawdowns
  for all
  using (false)
  with check (false);

alter table public.culinary_audit_escrow_reconciliations enable row level security;
drop policy if exists culinary_audit_escrow_reconciliations_service_role_all
  on public.culinary_audit_escrow_reconciliations;
create policy culinary_audit_escrow_reconciliations_service_role_all
  on public.culinary_audit_escrow_reconciliations
  for all
  using (false)
  with check (false);

alter table public.culinary_payout_gate_states enable row level security;
drop policy if exists culinary_payout_gate_states_service_role_all
  on public.culinary_payout_gate_states;
create policy culinary_payout_gate_states_service_role_all
  on public.culinary_payout_gate_states
  for all
  using (false)
  with check (false);

alter table public.culinary_popup_experiences enable row level security;
drop policy if exists culinary_popup_experiences_service_role_all
  on public.culinary_popup_experiences;
create policy culinary_popup_experiences_service_role_all
  on public.culinary_popup_experiences
  for all
  using (false)
  with check (false);

alter table public.culinary_popup_writeoffs enable row level security;
drop policy if exists culinary_popup_writeoffs_service_role_all
  on public.culinary_popup_writeoffs;
create policy culinary_popup_writeoffs_service_role_all
  on public.culinary_popup_writeoffs
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.culinary_audit_escrow_policies to service_role;
grant select, insert, update, delete on public.culinary_audit_escrow_drawdowns to service_role;
grant select, insert, update, delete on public.culinary_audit_escrow_reconciliations to service_role;
grant select, insert, update, delete on public.culinary_payout_gate_states to service_role;
grant select, insert, update, delete on public.culinary_popup_experiences to service_role;
grant select, insert, update, delete on public.culinary_popup_writeoffs to service_role;
