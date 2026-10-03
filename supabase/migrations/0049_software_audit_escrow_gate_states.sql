-- =============================================================================
-- 0049 — The software audit escrow: the founder-banded escrow for developer
--        IP payouts, position-locked drawdowns (uptime outage penalty
--        refunds, API rate-limit breach credits, quarterly security
--        compliance audits), the verified reconciliation of record, and the
--        software payout gate's two durable states (PR 45)
--
-- The founder software directive, per the brief. Four tables (the service
-- escrow's 0047 shapes 1:1, scoped to the software lane's identity):
--
--   software_audit_escrow_policies   <- upsertSoftwareAuditEscrowPolicy /
--                                       getSoftwareAuditEscrowPolicy
--     (one scope's escrow policy of record: the founder-banded 5–10% share
--      of the scope's developer IP payouts that locks into the
--      SOFTWARE_AUDIT_ESCROW bucket at routing. Scope is the software
--      lane's own identifier space —
--      developer:{developerId}:endpoint:{apiEndpointId} — the same
--      developer/API-endpoint identity the developer tables key on.
--      UNIQUE per scope_key: an upsert converges — the newest rate governs
--      the next routing. ABSENT policy = a counted fail-closed refusal —
--      the router never guesses a rate.)
--
--   software_audit_escrow_drawdowns  <- insertSoftwareAuditEscrowDrawdown /
--                                       listSoftwareAuditEscrowDrawdowns
--     (the append-only escrow spend of record: uptime outage penalty
--      refunds, API rate-limit breach credits, and quarterly security
--      compliance audits spending the bucket. UNIQUE per
--      (reserve_ledger_id, source_event_id) is the replay guard; UNIQUE
--      per (reserve_ledger_id, drawn_before_cents) is the position lock
--      the balance derives from; the drawn/remaining arithmetic is pinned
--      in a CHECK.)
--
--   software_audit_escrow_reconciliations
--                                    <- insertSoftwareAuditEscrowReconciliation /
--                                       getSoftwareAuditEscrowReconciliation
--     (the verified reconciliation of record per escrow bucket — the
--      release gate's key. UNIQUE per reserve_ledger_id is insert-as-lock:
--      the FIRST reconciliation wins, and the release reads it fail-closed
--      — no reconciliation of record, no release.)
--
--   software_payout_gate_states      <- upsertSoftwarePayoutGateState /
--                                       getSoftwarePayoutGateState
--     (the two durable states the software payout gate reads per
--      (payee, API endpoint): api_uptime_sla_state and
--      security_audit_state. The vocabulary is 'unknown' / 'verified' on
--      both — an ABSENT row resolves null and 'unknown' resolves false at
--      the gate: fail-closed both ways. UNIQUE per (payee_id,
--      api_endpoint_id): an upsert converges — a verification heals
--      'unknown'.)
--
-- The 0032 lesson, applied: every CHECK is an explicitly named TABLE-level
-- constraint (ck_*) — column-level checks collide with table-level ones of
-- the same shape. No foreign keys by design — the tables key on the
-- senders' developer/payee/API-endpoint identifiers, content-derived event
-- ids, and ledger transaction ids (the 0036–0048 discipline; no fk_*
-- constraints exist to name).
--
-- The PR 129 lesson, applied: the drawdown-class and gate-state
-- vocabularies in these CHECKs are byte-identical to the TS-side arrays
-- (SOFTWARE_AUDIT_ESCROW_DRAWDOWN_CLASSES in modules/software/records.ts
-- and the 'unknown'/'verified' union types) — verified before CI.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- software_audit_escrow_policies: one scope's escrow rate of record — the
-- founder band, enforced here and again at use.
-- ---------------------------------------------------------------------------
create table if not exists public.software_audit_escrow_policies (
  id                uuid primary key default gen_random_uuid(),
  scope_key         text not null,
  reserve_rate_bps  bigint not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (scope_key),
  constraint ck_software_audit_escrow_policies_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_software_audit_escrow_policies_rate_founder_band
    check (reserve_rate_bps >= 500 AND reserve_rate_bps <= 1000)
);

comment on table public.software_audit_escrow_policies is
  'One scope''s software audit-escrow policy of record (migration 0049): the founder-banded 500–1000 bps share of the scope''s developer IP payouts that locks into the SOFTWARE_AUDIT_ESCROW bucket at routing. Scope key is the software lane''s own identifier space — developer:{developerId}:endpoint:{apiEndpointId}. UNIQUE (scope_key): an upsert converges — the newest rate governs the next routing. ABSENT policy = a counted fail-closed refusal (the router never guesses a rate).';

-- ---------------------------------------------------------------------------
-- software_audit_escrow_drawdowns: the append-only escrow spend of record —
-- uptime outage penalty refunds, API rate-limit breach credits, quarterly
-- security compliance audits.
-- ---------------------------------------------------------------------------
create table if not exists public.software_audit_escrow_drawdowns (
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
  constraint ck_software_audit_escrow_drawdowns_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_software_audit_escrow_drawdowns_class_vocabulary
    check (drawdown_class IN ('uptime_outage_penalty_refund', 'api_rate_limit_breach_credit', 'quarterly_security_compliance_audit')),
  constraint ck_software_audit_escrow_drawdowns_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_software_audit_escrow_drawdowns_amount_positive
    check (drawn_cents > 0),
  constraint ck_software_audit_escrow_drawdowns_position_non_negative
    check (drawn_before_cents >= 0),
  constraint ck_software_audit_escrow_drawdowns_remaining_non_negative
    check (remaining_cents >= 0),
  constraint ck_software_audit_escrow_drawdowns_conservation
    check (remaining_cents = drawn_before_cents - drawn_cents)
);

comment on table public.software_audit_escrow_drawdowns is
  'The append-only software audit-escrow spend of record (migration 0049): uptime outage penalty refunds, API rate-limit breach credits, and quarterly security compliance audits. UNIQUE (reserve_ledger_id, source_event_id) is the replay guard; UNIQUE (reserve_ledger_id, drawn_before_cents) is the position lock the balance derives from; the drawn/remaining arithmetic is pinned in a CHECK.';

-- ---------------------------------------------------------------------------
-- software_audit_escrow_reconciliations: the verified reconciliation of
-- record — the release gate's key, insert-as-lock per bucket.
-- ---------------------------------------------------------------------------
create table if not exists public.software_audit_escrow_reconciliations (
  id                    uuid primary key default gen_random_uuid(),
  reserve_ledger_id     text not null,
  evidence_ref          text not null,
  reconciled_by         text not null,
  created_at            timestamptz not null default now(),
  unique (reserve_ledger_id),
  constraint ck_software_audit_escrow_reconciliations_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_software_audit_escrow_reconciliations_reconciler_present
    check (char_length(reconciled_by) > 0)
);

comment on table public.software_audit_escrow_reconciliations is
  'The verified reconciliation of record per software escrow bucket (migration 0049) — the release gate''s key. UNIQUE (reserve_ledger_id) is insert-as-lock: the FIRST reconciliation wins, and the release reads it fail-closed — no reconciliation of record, no release.';

-- ---------------------------------------------------------------------------
-- software_payout_gate_states: the two durable states the software payout
-- gate reads, fail-closed — 'unknown' and absent both refuse.
-- ---------------------------------------------------------------------------
create table if not exists public.software_payout_gate_states (
  id                     uuid primary key default gen_random_uuid(),
  payee_id               text not null,
  api_endpoint_id        text not null,
  api_uptime_sla_state   text not null,
  security_audit_state   text not null,
  evidence_ref           text not null,
  verified_by            text not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (payee_id, api_endpoint_id),
  constraint ck_software_payout_gate_states_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_software_payout_gate_states_endpoint_present
    check (char_length(api_endpoint_id) > 0),
  constraint ck_software_payout_gate_states_uptime_vocabulary
    check (api_uptime_sla_state IN ('unknown', 'verified')),
  constraint ck_software_payout_gate_states_audit_vocabulary
    check (security_audit_state IN ('unknown', 'verified')),
  constraint ck_software_payout_gate_states_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_software_payout_gate_states_verifier_present
    check (char_length(verified_by) > 0)
);

comment on table public.software_payout_gate_states is
  'The software payout gate''s durable states of record per (payee, API endpoint) (migration 0049): api_uptime_sla_state and security_audit_state. Vocabulary is ''unknown''/''verified'' on both — an ABSENT row resolves null and ''unknown'' resolves false at the gate: fail-closed both ways. UNIQUE (payee_id, api_endpoint_id): an upsert converges — a verification heals ''unknown''.';

-- The RLS deny-all posture — every software escrow table is software-lane
-- only (the 0043–0048 discipline; the probes verify deny for
-- authenticated).

alter table public.software_audit_escrow_policies enable row level security;
drop policy if exists software_audit_escrow_policies_service_role_all
  on public.software_audit_escrow_policies;
create policy software_audit_escrow_policies_service_role_all
  on public.software_audit_escrow_policies
  for all
  using (false)
  with check (false);

alter table public.software_audit_escrow_drawdowns enable row level security;
drop policy if exists software_audit_escrow_drawdowns_service_role_all
  on public.software_audit_escrow_drawdowns;
create policy software_audit_escrow_drawdowns_service_role_all
  on public.software_audit_escrow_drawdowns
  for all
  using (false)
  with check (false);

alter table public.software_audit_escrow_reconciliations enable row level security;
drop policy if exists software_audit_escrow_reconciliations_service_role_all
  on public.software_audit_escrow_reconciliations;
create policy software_audit_escrow_reconciliations_service_role_all
  on public.software_audit_escrow_reconciliations
  for all
  using (false)
  with check (false);

alter table public.software_payout_gate_states enable row level security;
drop policy if exists software_payout_gate_states_service_role_all
  on public.software_payout_gate_states;
create policy software_payout_gate_states_service_role_all
  on public.software_payout_gate_states
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.software_audit_escrow_policies to service_role;
grant select, insert, update, delete on public.software_audit_escrow_drawdowns to service_role;
grant select, insert, update, delete on public.software_audit_escrow_reconciliations to service_role;
grant select, insert, update, delete on public.software_payout_gate_states to service_role;
