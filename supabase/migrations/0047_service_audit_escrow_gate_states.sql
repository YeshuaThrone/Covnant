-- =============================================================================
-- 0047 — The service audit escrow: the founder-banded escrow for franchise
--        service payouts, position-locked drawdowns (client refund
--        allowances, product return chargebacks, quarterly backbar
--        inventory audits), the verified reconciliation of record, and the
--        services payout gate's two durable states (PR 43)
--
-- The founder services directive, per the brief. Four tables (the culinary
-- escrow's six minus the pop-up decommissioning pair — the services brief
-- names no pop-up lane):
--
--   service_audit_escrow_policies   <- upsertServiceAuditEscrowPolicy /
--                                      getServiceAuditEscrowPolicy
--     (one scope's escrow policy of record: the founder-banded 5–10% share
--      of the scope's franchise service payouts that locks into the
--      SERVICE_AUDIT_ESCROW bucket at routing. Scope is the service lane's
--      own identifier space — stylist:{stylistId}:location:{salonLocationId}
--      — the same columns the 0046 service tables key on. UNIQUE per
--      scope_key: an upsert converges — the newest rate governs the next
--      routing. ABSENT policy = a counted fail-closed refusal — the router
--      never guesses a rate.)
--
--   service_audit_escrow_drawdowns  <- insertServiceAuditEscrowDrawdown /
--                                      listServiceAuditEscrowDrawdowns
--     (the append-only escrow spend of record: client refund allowances,
--      product return chargebacks, and quarterly backbar inventory audits
--      spending the bucket. UNIQUE per (reserve_ledger_id, source_event_id)
--      is the replay guard; UNIQUE per (reserve_ledger_id,
--      drawn_before_cents) is the position lock the balance derives from;
--      the drawn/remaining arithmetic is pinned in a CHECK.)
--
--   service_audit_escrow_reconciliations
--                                   <- insertServiceAuditEscrowReconciliation /
--                                      getServiceAuditEscrowReconciliation
--     (the verified reconciliation of record per escrow bucket — the
--      release gate's key. UNIQUE per reserve_ledger_id is insert-as-lock:
--      the FIRST reconciliation wins, and the release reads it fail-closed
--      — no reconciliation of record, no release.)
--
--   services_payout_gate_states     <- upsertServicesPayoutGateState /
--                                      getServicesPayoutGateState
--     (the two durable states the services payout gate reads per
--      (payee, salon location): health_license_state and
--      territorial_exclusivity_state. The vocabulary is 'unknown' /
--      'verified' on both — an ABSENT row resolves null and 'unknown'
--      resolves false at the gate: fail-closed both ways. UNIQUE per
--      (payee_id, salon_location_id): an upsert converges — a verification
--      heals 'unknown'.)
--
-- The 0032 lesson, applied: every CHECK is an explicitly named TABLE-level
-- constraint (ck_*) — column-level checks collide with table-level ones of
-- the same shape. No foreign keys by design — the tables key on the
-- senders' stylist/payee/salon-location identifiers, content-derived event
-- ids, and ledger transaction ids (the 0036–0046 discipline; no fk_*
-- constraints exist to name).
--
-- The PR 129 lesson, applied: the drawdown-class and gate-state
-- vocabularies in these CHECKs are byte-identical to the TS-side arrays
-- (SERVICE_AUDIT_ESCROW_DRAWDOWN_CLASSES in modules/service/records.ts and
-- the 'unknown'/'verified' union types) — verified before CI.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- service_audit_escrow_policies: one scope's escrow rate of record — the
-- founder band, enforced here and again at use.
-- ---------------------------------------------------------------------------
create table if not exists public.service_audit_escrow_policies (
  id                uuid primary key default gen_random_uuid(),
  scope_key         text not null,
  reserve_rate_bps  bigint not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (scope_key),
  constraint ck_service_audit_escrow_policies_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_service_audit_escrow_policies_rate_founder_band
    check (reserve_rate_bps >= 500 AND reserve_rate_bps <= 1000)
);

comment on table public.service_audit_escrow_policies is
  'One scope''s service audit-escrow policy of record (migration 0047): the founder-banded 500–1000 bps share of the scope''s franchise service payouts that locks into the SERVICE_AUDIT_ESCROW bucket at routing. Scope key is the service lane''s own identifier space — stylist:{stylistId}:location:{salonLocationId}. UNIQUE (scope_key): an upsert converges — the newest rate governs the next routing. ABSENT policy = a counted fail-closed refusal (the router never guesses a rate).';

-- ---------------------------------------------------------------------------
-- service_audit_escrow_drawdowns: the append-only escrow spend of record —
-- client refund allowances, product return chargebacks, quarterly backbar
-- inventory audits.
-- ---------------------------------------------------------------------------
create table if not exists public.service_audit_escrow_drawdowns (
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
  constraint ck_service_audit_escrow_drawdowns_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_service_audit_escrow_drawdowns_class_vocabulary
    check (drawdown_class IN ('refund_allowance', 'product_return_chargeback', 'backbar_inventory_audit')),
  constraint ck_service_audit_escrow_drawdowns_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_service_audit_escrow_drawdowns_amount_positive
    check (drawn_cents > 0),
  constraint ck_service_audit_escrow_drawdowns_position_non_negative
    check (drawn_before_cents >= 0),
  constraint ck_service_audit_escrow_drawdowns_remaining_non_negative
    check (remaining_cents >= 0),
  constraint ck_service_audit_escrow_drawdowns_conservation
    check (remaining_cents = drawn_before_cents - drawn_cents)
);

comment on table public.service_audit_escrow_drawdowns is
  'The append-only service audit-escrow spend of record (migration 0047): client refund allowances, product return chargebacks, and quarterly backbar inventory audits. UNIQUE (reserve_ledger_id, source_event_id) is the replay guard; UNIQUE (reserve_ledger_id, drawn_before_cents) is the position lock the balance derives from; the drawn/remaining arithmetic is pinned in a CHECK.';

-- ---------------------------------------------------------------------------
-- service_audit_escrow_reconciliations: the verified reconciliation of
-- record — the release gate's key, insert-as-lock per bucket.
-- ---------------------------------------------------------------------------
create table if not exists public.service_audit_escrow_reconciliations (
  id                    uuid primary key default gen_random_uuid(),
  reserve_ledger_id     text not null,
  evidence_ref          text not null,
  reconciled_by         text not null,
  created_at            timestamptz not null default now(),
  unique (reserve_ledger_id),
  constraint ck_service_audit_escrow_reconciliations_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_service_audit_escrow_reconciliations_reconciler_present
    check (char_length(reconciled_by) > 0)
);

comment on table public.service_audit_escrow_reconciliations is
  'The verified reconciliation of record per service escrow bucket (migration 0047) — the release gate''s key. UNIQUE (reserve_ledger_id) is insert-as-lock: the FIRST reconciliation wins, and the release reads it fail-closed — no reconciliation of record, no release.';

-- ---------------------------------------------------------------------------
-- services_payout_gate_states: the two durable states the services payout
-- gate reads, fail-closed — 'unknown' and absent both refuse.
-- ---------------------------------------------------------------------------
create table if not exists public.services_payout_gate_states (
  id                            uuid primary key default gen_random_uuid(),
  payee_id                      text not null,
  salon_location_id             text not null,
  health_license_state          text not null,
  territorial_exclusivity_state text not null,
  evidence_ref                  text not null,
  verified_by                   text not null,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  unique (payee_id, salon_location_id),
  constraint ck_services_payout_gate_states_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_services_payout_gate_states_location_present
    check (char_length(salon_location_id) > 0),
  constraint ck_services_payout_gate_states_health_vocabulary
    check (health_license_state IN ('unknown', 'verified')),
  constraint ck_services_payout_gate_states_territorial_vocabulary
    check (territorial_exclusivity_state IN ('unknown', 'verified')),
  constraint ck_services_payout_gate_states_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_services_payout_gate_states_verifier_present
    check (char_length(verified_by) > 0)
);

comment on table public.services_payout_gate_states is
  'The services payout gate''s durable states of record per (payee, salon location) (migration 0047): health_license_state and territorial_exclusivity_state. Vocabulary is ''unknown''/''verified'' on both — an ABSENT row resolves null and ''unknown'' resolves false at the gate: fail-closed both ways. UNIQUE (payee_id, salon_location_id): an upsert converges — a verification heals ''unknown''.';

-- The RLS deny-all posture — every service escrow table is service-lane
-- only (the 0043–0046 discipline; the probes verify deny for
-- authenticated).

alter table public.service_audit_escrow_policies enable row level security;
drop policy if exists service_audit_escrow_policies_service_role_all
  on public.service_audit_escrow_policies;
create policy service_audit_escrow_policies_service_role_all
  on public.service_audit_escrow_policies
  for all
  using (false)
  with check (false);

alter table public.service_audit_escrow_drawdowns enable row level security;
drop policy if exists service_audit_escrow_drawdowns_service_role_all
  on public.service_audit_escrow_drawdowns;
create policy service_audit_escrow_drawdowns_service_role_all
  on public.service_audit_escrow_drawdowns
  for all
  using (false)
  with check (false);

alter table public.service_audit_escrow_reconciliations enable row level security;
drop policy if exists service_audit_escrow_reconciliations_service_role_all
  on public.service_audit_escrow_reconciliations;
create policy service_audit_escrow_reconciliations_service_role_all
  on public.service_audit_escrow_reconciliations
  for all
  using (false)
  with check (false);

alter table public.services_payout_gate_states enable row level security;
drop policy if exists services_payout_gate_states_service_role_all
  on public.services_payout_gate_states;
create policy services_payout_gate_states_service_role_all
  on public.services_payout_gate_states
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.service_audit_escrow_policies to service_role;
grant select, insert, update, delete on public.service_audit_escrow_drawdowns to service_role;
grant select, insert, update, delete on public.service_audit_escrow_reconciliations to service_role;
grant select, insert, update, delete on public.services_payout_gate_states to service_role;
