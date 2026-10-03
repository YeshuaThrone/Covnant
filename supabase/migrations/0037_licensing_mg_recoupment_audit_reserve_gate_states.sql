-- =============================================================================
-- 0037 — Brand licensing II: MG recoupment ledger, automatic shortfall
-- invoices, the AUDIT_RESERVE_ESCROW bucket, and the fail-closed licensing
-- payout gate states (PR 33)
--
-- The founder's directive's durable facts of record, per the brief:
--
--   licensing_mg_commitments        <- upsertLicensingMgCommitment /
--                                      getLicensingMgCommitment /
--                                      listLicensingMgCommitments
--     (the advance / minimum-guarantee commitment of record per (scope_key,
--      commitment_ref): the upfront MG amount, the licensee of record, the
--      contract's category, and the COLLATERALIZATION MODE —
--      'category_isolated' advances recoup only from their own category's
--      royalties (the directive's example: a $250,000 upfront MG for
--      footwear versus a separate apparel MG), 'cross_collateralized'
--      advances recoup from any category the scope earns.
--      UNIQUE per (scope_key, commitment_ref): an upsert converges — the
--      newest terms govern; recouped_cents is a bookkeeping counter HEALED
--      from the append-only applications, never their arbiter.)
--
--   licensing_mg_recoupment_applications <- insertLicensingMgRecoupmentApplication /
--                                           listLicensingMgRecoupmentApplications
--     (the append-only per-event recoupment application — the advance
--      offset's commit. UNIQUE per (commitment_id, source_event_id) is the
--      replay guard (a re-walked event recoups once, never twice); UNIQUE
--      per (commitment_id, recouped_before_cents) is the POSITION LOCK
--      (the 0036 application discipline at commitment scope — the advance's
--      running position arbitrates the race, one writer wins, the loser
--      retries at the advanced position). The recouped position derives
--      from this append-only truth — SUM(recouped_cents) — never the
--      counter.)
--
--   licensing_mg_term_closes        <- upsertLicensingMgTermClose /
--                                      getLicensingMgTermClose
--     (the contract term's close of record per (commitment_id, term): the
--      MG due, the recouped position at close, and the SHORTFALL —
--      max(0, mg_due − recouped). UNIQUE per the pair: the once-only
--      close. A positive shortfall DEBITS THE INVOICE OF RECORD
--      automatically (the ledger row's kind AND status
--      'mg_shortfall_due' — the payee is the LICENSEE of record, the
--      close key stamped in line_item_id) plus the balanced GL journal;
--      the invoice_ledger_id is the row's reference. A zero shortfall
--      records the fully-recouped close and moves nothing. The close
--      never re-prices: a replayed close converges on the recorded one.)
--
--   licensing_audit_reserve_policies <- upsertLicensingAuditReservePolicy /
--                                       getLicensingAuditReservePolicy
--     (the audit-reserve escrow's policy of record per license scope: the
--      founder-banded 500–1000 bps share (5–10%) of the scope's licensing
--      royalty credits that locks into AUDIT_RESERVE_ESCROW automatically
--      at routing. UNIQUE per scope_key: a re-registration converges — the
--      newest rate governs the next routing.)
--
--   licensing_audit_reserve_drawdowns <- insertLicensingAuditReserveDrawdown /
--                                        listLicensingAuditReserveDrawdowns
--     (the append-only drawdown lines spending a reserve — the quarterly
--      retail audit reconciliations ('quarterly_audit_reconciliation') and
--      inventory write-offs ('inventory_write_off'). UNIQUE per
--      (reserve_ledger_id, source_event_id) is the replay guard; UNIQUE
--      per (reserve_ledger_id, drawn_before_cents) is the POSITION LOCK —
--      the reserve's remaining balance derives from
--      SUM(drawn_cents), never a counter.)
--
--   licensing_audit_reserve_reconciliations <- insertLicensingAuditReserveReconciliation /
--                                              getLicensingAuditReserveReconciliation
--     (the VERIFIED reconciliation of record per reserve — the release
--      gate's key. UNIQUE per reserve_ledger_id: insert-as-lock, the FIRST
--      reconciliation wins. The release reads this row FAIL-CLOSED — no
--      reconciliation of record, no release.)
--
--   licensing_payout_gate_states    <- upsertLicensingPayoutGateState /
--                                      getLicensingPayoutGateState
--     (the durable licensing payout gate states of record per (payee_id,
--      scope_key): territory_state ('unknown' | 'cleared') and
--      category_exclusivity_state ('unknown' | 'verified'), with their
--      evidence and verifier provenance when set. The payout gate reads
--      BOTH states fail-closed: an ABSENT row resolves null and an
--      'unknown' state refuses — only territory_cleared AND
--      category_exclusivity_verified pass. An upsert converges: a
--      verification heals 'unknown' to its cleared/verified state; states
--      never regress through this table.)
--
-- No foreign keys by design: the seven tables key on ledger transaction
-- ids, reconciliation scope keys, and the addendum 12 identifier space —
-- the same discipline 0036 applied (ledger_transaction.id and match_queue
-- carry no FK either).
--
-- The constraint discipline (the 0032 production lesson, applied): every
-- CHECK is a TABLE-level constraint with an explicit, table-namespaced name
-- (ck_ prefix); no column-level constraint ever shares a name with a
-- table-level one. UNIQUE constraints stay inline and unnamed (the 0032
-- pattern) — Postgres auto-names them off the table and columns, which
-- cannot collide with the explicit ck_ names.
--
-- The money discipline: the reserve band is pinned in a CHECK (500–1000
-- bps); amounts and positions are non-negative bigints; a commitment,
-- drawdown, or policy outside its band cannot persist.
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with the 0033 service-role grant set (the 0017–0036
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- licensing_mg_commitments: the advance / MG commitment of record per
-- (scope, ref) — amount, licensee, category, collateralization mode.
-- ---------------------------------------------------------------------------
create table if not exists public.licensing_mg_commitments (
  id                uuid primary key default gen_random_uuid(),
  scope_key         text not null,
  commitment_ref    text not null,
  category_code     text not null,
  collateralization text not null,
  mg_amount_cents   bigint not null,
  currency          text not null,
  licensee_id       text not null,
  licensee_name     text not null,
  recouped_cents    bigint not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (scope_key, commitment_ref),
  constraint ck_licensing_mg_commitments_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_licensing_mg_commitments_ref_present
    check (char_length(commitment_ref) > 0),
  constraint ck_licensing_mg_commitments_category_present
    check (char_length(category_code) > 0),
  constraint ck_licensing_mg_commitments_collateralization
    check (collateralization in ('cross_collateralized', 'category_isolated')),
  constraint ck_licensing_mg_commitments_amount_positive
    check (mg_amount_cents > 0),
  constraint ck_licensing_mg_commitments_currency_shape
    check (currency ~ '^[A-Z]{3}$'),
  constraint ck_licensing_mg_commitments_licensee_present
    check (char_length(licensee_id) > 0 and char_length(licensee_name) > 0),
  constraint ck_licensing_mg_commitments_recouped_nonneg
    check (recouped_cents >= 0)
);

comment on table public.licensing_mg_commitments is
  'The advance / minimum-guarantee commitment of record (migration 0037): the upfront MG per (scope, ref) with the contract''s category and COLLATERALIZATION mode — category_isolated recoups only its own category''s royalties (e.g. a $250,000 footwear MG separate from the apparel MG), cross_collateralized recoups from any category the scope earns. UNIQUE (scope_key, commitment_ref): an upsert converges. recouped_cents is a healed bookkeeping counter; the append-only applications are the truth.';

-- ---------------------------------------------------------------------------
-- licensing_mg_recoupment_applications: the append-only per-event advance
-- offset — replay guard + position lock at commitment scope.
-- ---------------------------------------------------------------------------
create table if not exists public.licensing_mg_recoupment_applications (
  id                    uuid primary key default gen_random_uuid(),
  commitment_id         uuid not null,
  scope_key             text not null,
  category_code         text not null,
  source_event_id       text not null,
  earned_royalty_cents  bigint not null,
  recouped_before_cents bigint not null,
  recouped_cents        bigint not null,
  recouped_after_cents  bigint not null,
  created_at            timestamptz not null default now(),
  unique (commitment_id, source_event_id),
  unique (commitment_id, recouped_before_cents),
  constraint ck_licensing_mg_recoup_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_licensing_mg_recoup_category_present
    check (char_length(category_code) > 0),
  constraint ck_licensing_mg_recoup_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_licensing_mg_recoup_amounts_nonneg
    check (
      earned_royalty_cents >= 0
      and recouped_before_cents >= 0
      and recouped_cents > 0
      and recouped_after_cents >= 0
    ),
  constraint ck_licensing_mg_recoup_position_conserves
    check (recouped_after_cents = recouped_before_cents + recouped_cents)
);

comment on table public.licensing_mg_recoupment_applications is
  'The append-only per-event recoupment application (migration 0037): the advance offset''s commit. UNIQUE (commitment_id, source_event_id) is the replay guard — a re-walked event recoups once; UNIQUE (commitment_id, recouped_before_cents) is the POSITION LOCK — the advance''s running position arbitrates the race, one writer wins, the loser retries at the advanced position (the 0036 application discipline). The recouped position of record is SUM(recouped_cents) over this table, never the commitments'' healed counter.';

-- ---------------------------------------------------------------------------
-- licensing_mg_term_closes: the annual term's close of record — MG due,
-- recouped at close, shortfall; the invoice of record's reference.
-- ---------------------------------------------------------------------------
create table if not exists public.licensing_mg_term_closes (
  id                      uuid primary key default gen_random_uuid(),
  commitment_id           uuid not null,
  scope_key               text not null,
  term                    text not null,
  mg_due_cents            bigint not null,
  recouped_at_close_cents bigint not null,
  shortfall_cents         bigint not null,
  invoice_ledger_id       text,
  closed_by               text not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (commitment_id, term),
  constraint ck_licensing_mg_term_closes_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_licensing_mg_term_closes_term_shape
    check (term ~ '^[0-9]{4}$'),
  constraint ck_licensing_mg_term_closes_amounts_nonneg
    check (mg_due_cents > 0 and recouped_at_close_cents >= 0 and shortfall_cents >= 0),
  constraint ck_licensing_mg_term_closes_shortfall_conserves
    check (shortfall_cents = greatest(mg_due_cents - recouped_at_close_cents, 0)),
  constraint ck_licensing_mg_term_closes_closer_present
    check (char_length(closed_by) > 0)
);

comment on table public.licensing_mg_term_closes is
  'The contract term''s close of record (migration 0037): the annual MG due, the recouped position at close (derived from the append-only applications), and the shortfall — max(0, mg_due − recouped). UNIQUE (commitment_id, term): the once-only close; a replayed close converges on the recorded one and never re-prices. A positive shortfall debits the invoice of record automatically — the ledger row''s kind AND status ''mg_shortfall_due'' against the licensee of record, this close''s key stamped in the row''s line_item_id; invoice_ledger_id is the reference.';

-- ---------------------------------------------------------------------------
-- licensing_audit_reserve_policies: the founder-banded reserve rate of
-- record per license scope.
-- ---------------------------------------------------------------------------
create table if not exists public.licensing_audit_reserve_policies (
  id               uuid primary key default gen_random_uuid(),
  scope_key        text not null,
  reserve_rate_bps integer not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (scope_key),
  constraint ck_licensing_audit_policies_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_licensing_audit_policies_rate_band
    check (reserve_rate_bps >= 500 and reserve_rate_bps <= 1000)
);

comment on table public.licensing_audit_reserve_policies is
  'The audit-reserve escrow''s policy of record (migration 0037): the founder-banded 500–1000 bps share (5–10%) of the scope''s licensing royalty credits that locks into AUDIT_RESERVE_ESCROW automatically at routing. UNIQUE (scope_key): a re-registration converges — the newest rate governs the next routing. A rate outside the band cannot persist.';

-- ---------------------------------------------------------------------------
-- licensing_audit_reserve_drawdowns: the append-only drawdown lines —
-- quarterly audit reconciliations and inventory write-offs.
-- ---------------------------------------------------------------------------
create table if not exists public.licensing_audit_reserve_drawdowns (
  id                  uuid primary key default gen_random_uuid(),
  reserve_ledger_id   text not null,
  scope_key           text not null,
  drawdown_class      text not null,
  source_event_id     text not null,
  drawn_before_cents  bigint not null,
  drawn_cents         bigint not null,
  remaining_cents     bigint not null,
  created_at          timestamptz not null default now(),
  unique (reserve_ledger_id, source_event_id),
  unique (reserve_ledger_id, drawn_before_cents),
  constraint ck_licensing_audit_drawdowns_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_licensing_audit_drawdowns_class
    check (drawdown_class in ('quarterly_audit_reconciliation', 'inventory_write_off')),
  constraint ck_licensing_audit_drawdowns_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_licensing_audit_drawdowns_amounts_nonneg
    check (drawn_before_cents >= 0 and drawn_cents > 0 and remaining_cents >= 0),
  constraint ck_licensing_audit_drawdowns_position_conserves
    check (remaining_cents = drawn_before_cents - drawn_cents)
);

comment on table public.licensing_audit_reserve_drawdowns is
  'The append-only drawdown lines (migration 0037): quarterly retail audit reconciliations and inventory write-offs spending a reserve''s balance. UNIQUE (reserve_ledger_id, source_event_id) is the replay guard; UNIQUE (reserve_ledger_id, drawn_before_cents) is the POSITION LOCK — one writer wins, the loser retries at the advanced position. The reserve''s remaining balance derives from SUM(drawn_cents) over this table, never a counter.';

-- ---------------------------------------------------------------------------
-- licensing_audit_reserve_reconciliations: the VERIFIED reconciliation of
-- record — the release gate's key, insert-as-lock per reserve.
-- ---------------------------------------------------------------------------
create table if not exists public.licensing_audit_reserve_reconciliations (
  id                uuid primary key default gen_random_uuid(),
  reserve_ledger_id text not null,
  evidence_ref      text not null,
  reconciled_by     text not null,
  created_at        timestamptz not null default now(),
  unique (reserve_ledger_id),
  constraint ck_licensing_audit_reconciliations_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_licensing_audit_reconciliations_reconciler_present
    check (char_length(reconciled_by) > 0)
);

comment on table public.licensing_audit_reserve_reconciliations is
  'The verified reconciliation of record per reserve (migration 0037) — the release gate''s key. UNIQUE (reserve_ledger_id): insert-as-lock, the FIRST reconciliation wins; a concurrent second surfaces the conflict. The release reads this row FAIL-CLOSED — no reconciliation of record, no release.';

-- ---------------------------------------------------------------------------
-- licensing_payout_gate_states: the durable licensing payout gate states of
-- record — territory_cleared + category_exclusivity_verified, fail-closed.
-- ---------------------------------------------------------------------------
create table if not exists public.licensing_payout_gate_states (
  id                               uuid primary key default gen_random_uuid(),
  payee_id                         text not null,
  scope_key                        text not null,
  territory_state                  text not null,
  category_exclusivity_state       text not null,
  territory_evidence_ref           text,
  category_exclusivity_evidence_ref text,
  verified_by                      text,
  created_at                       timestamptz not null default now(),
  updated_at                       timestamptz not null default now(),
  unique (payee_id, scope_key),
  constraint ck_licensing_gate_states_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_licensing_gate_states_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_licensing_gate_states_territory_state
    check (territory_state in ('unknown', 'cleared')),
  constraint ck_licensing_gate_states_exclusivity_state
    check (category_exclusivity_state in ('unknown', 'verified')),
  constraint ck_licensing_gate_states_cleared_shape
    check (
      (territory_state = 'cleared' or territory_evidence_ref is null)
      and (category_exclusivity_state = 'verified' or category_exclusivity_evidence_ref is null)
    )
);

comment on table public.licensing_payout_gate_states is
  'The durable licensing payout gate states of record (migration 0037) per (payee, scope): territory_state (''unknown'' | ''cleared'') and category_exclusivity_state (''unknown'' | ''verified''), with evidence and verifier provenance when set. The payout gate reads BOTH states fail-closed: an ABSENT row resolves null and an ''unknown'' state refuses — only territory_cleared AND category_exclusivity_verified pass. An upsert converges: a verification heals ''unknown''; states never regress through this table.';

-- ---------------------------------------------------------------------------
-- RLS: deny-all for client roles (the 0017–0036 precedent) — explicit
-- policies so the denial is auditable, not an accident of missing grants.
-- ---------------------------------------------------------------------------
alter table public.licensing_mg_commitments enable row level security;
alter table public.licensing_mg_recoupment_applications enable row level security;
alter table public.licensing_mg_term_closes enable row level security;
alter table public.licensing_audit_reserve_policies enable row level security;
alter table public.licensing_audit_reserve_drawdowns enable row level security;
alter table public.licensing_audit_reserve_reconciliations enable row level security;
alter table public.licensing_payout_gate_states enable row level security;

drop policy if exists licensing_mg_commitments_service_role_all
  on public.licensing_mg_commitments;
create policy licensing_mg_commitments_service_role_all
  on public.licensing_mg_commitments
  for all
  using (false)
  with check (false);

drop policy if exists licensing_mg_recoupment_applications_service_role_all
  on public.licensing_mg_recoupment_applications;
create policy licensing_mg_recoupment_applications_service_role_all
  on public.licensing_mg_recoupment_applications
  for all
  using (false)
  with check (false);

drop policy if exists licensing_mg_term_closes_service_role_all
  on public.licensing_mg_term_closes;
create policy licensing_mg_term_closes_service_role_all
  on public.licensing_mg_term_closes
  for all
  using (false)
  with check (false);

drop policy if exists licensing_audit_reserve_policies_service_role_all
  on public.licensing_audit_reserve_policies;
create policy licensing_audit_reserve_policies_service_role_all
  on public.licensing_audit_reserve_policies
  for all
  using (false)
  with check (false);

drop policy if exists licensing_audit_reserve_drawdowns_service_role_all
  on public.licensing_audit_reserve_drawdowns;
create policy licensing_audit_reserve_drawdowns_service_role_all
  on public.licensing_audit_reserve_drawdowns
  for all
  using (false)
  with check (false);

drop policy if exists licensing_audit_reserve_reconciliations_service_role_all
  on public.licensing_audit_reserve_reconciliations;
create policy licensing_audit_reserve_reconciliations_service_role_all
  on public.licensing_audit_reserve_reconciliations
  for all
  using (false)
  with check (false);

drop policy if exists licensing_payout_gate_states_service_role_all
  on public.licensing_payout_gate_states;
create policy licensing_payout_gate_states_service_role_all
  on public.licensing_payout_gate_states
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.licensing_mg_commitments to service_role;
grant select, insert, update, delete on public.licensing_mg_recoupment_applications to service_role;
grant select, insert, update, delete on public.licensing_mg_term_closes to service_role;
grant select, insert, update, delete on public.licensing_audit_reserve_policies to service_role;
grant select, insert, update, delete on public.licensing_audit_reserve_drawdowns to service_role;
grant select, insert, update, delete on public.licensing_audit_reserve_reconciliations to service_role;
grant select, insert, update, delete on public.licensing_payout_gate_states to service_role;
