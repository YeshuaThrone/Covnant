-- =============================================================================
-- 0043 — The fitness audit escrow, payout gate states, and live-event bonuses
--        (PR 39)
--
-- The founder fitness directive, per the brief. Six tables:
--
--   fitness_audit_escrow_policies    <- upsertFitnessAuditEscrowPolicy /
--                                       getFitnessAuditEscrowPolicy
--     (one (trainer, studio franchise) scope's escrow rate of record: the
--      founder-banded 500–1000 bps share of the scope's fitness IP payouts
--      that locks into the FITNESS_AUDIT_ESCROW bucket at routing —
--      `trainer:{trainerId}:studio:{studioFranchiseCode}` as scope_key.
--      UNIQUE per scope_key: an upsert converges — the newest rate governs
--      the next routing. ABSENT policy = nothing routes — fail-closed.)
--
--   fitness_audit_escrow_drawdowns   <- insertFitnessAuditEscrowDrawdown /
--                                       listFitnessAuditEscrowDrawdowns
--     (the append-only position-locked drawdowns against one escrow
--      bucket's ledger_transactions row: member chargeback reserves,
--      class return allowances, and quarterly sync music licensing audits.
--      UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard;
--      UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position
--      lock the balance derives from — a replayed event or a lost race
--      throws, never a double spend. The conservation identity
--      (remaining = drawn_before − drawn) is pinned in a CHECK.)
--
--   fitness_audit_escrow_reconciliations
--                                    <- insertFitnessAuditEscrowReconciliation /
--                                       getFitnessAuditEscrowReconciliation
--     (the verified reconciliation of record for one escrow bucket —
--      insert-as-lock, UNIQUE per reserve_ledger_id: the FIRST
--      reconciliation wins, and the release reads it fail-closed. No
--      reconciliation of record, no release.)
--
--   fitness_payout_gate_states       <- upsertFitnessPayoutGateState /
--                                       getFitnessPayoutGateState
--     (the fitness payout gate's states of record for one payee in one
--      studio franchise: `hipaa_gdpr_privacy_state` ('unknown' | 'cleared')
--      and `territorial_exclusivity_state` ('unknown' | 'verified'). The
--      gate reads: hipaa_gdpr_privacy_cleared is true only when the privacy
--      state is 'cleared', territorial_studio_exclusivity_verified is true
--      only when the exclusivity state is 'verified' — an ABSENT record
--      resolves null and 'unknown' resolves false. Fail-closed. UNIQUE per
--      (payee_id, studio_franchise_code): an upsert converges — a
--      verification heals 'unknown'; states never regress through this
--      table.)
--
--   fitness_live_event_bonus_policies
--                                    <- upsertFitnessLiveEventBonusPolicy /
--                                       getFitnessLiveEventBonusPolicy
--     (one program's instant live-event bonus rate of record: the bps
--      share of the concluded event's revenue that posts to the lead
--      trainer at event conclusion. UNIQUE per program_id: an upsert
--      converges. ABSENT policy = a counted fail-closed skip — the walk
--      never guesses a rate.)
--
--   fitness_live_event_bonuses       <- insertFitnessLiveEventBonus /
--                                       getFitnessLiveEventBonus
--     (the append-only instant performance bonus of record per concluded
--      synchronous broadcast row: the lead trainer (the row's trainer_id),
--      the event's peak simultaneous viewers and revenue, the policy rate
--      pinned alongside the priced amount. UNIQUE per source_event_id is
--      the replay guard — a re-shipped broadcast throws, never a second
--      bonus. The floor-pricing identity is pinned in a CHECK.)
--
-- The 0032 lesson, applied: every CHECK is an explicitly named TABLE-level
-- constraint (ck_*) — column-level checks collide with table-level ones of
-- the same shape. No foreign keys by design — the tables key on ledger
-- transaction ids, content-derived event ids, the senders'
-- trainer/program/franchise identifiers, and reporting periods (the
-- 0036–0042 discipline; no fk_* constraints exist to name).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- fitness_audit_escrow_policies: one scope's founder-banded escrow rate of
-- record — the FITNESS_AUDIT_ESCROW bucket's money terms.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_audit_escrow_policies (
  id                    uuid primary key default gen_random_uuid(),
  scope_key             text not null,
  reserve_rate_bps      bigint not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (scope_key),
  constraint ck_fitness_audit_escrow_policies_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_fitness_audit_escrow_policies_rate_band
    check (reserve_rate_bps >= 500 AND reserve_rate_bps <= 1000)
);

comment on table public.fitness_audit_escrow_policies is
  'One (trainer, studio franchise) scope''s escrow rate of record (migration 0043): the founder-banded 500–1000 bps share of the scope''s fitness IP payouts that locks into the FITNESS_AUDIT_ESCROW bucket at routing. UNIQUE (scope_key): an upsert converges — the newest rate governs the next routing. ABSENT policy = nothing routes (fail-closed).';

-- ---------------------------------------------------------------------------
-- fitness_audit_escrow_drawdowns: the append-only position-locked spend of
-- one escrow bucket — chargeback reserves, class return allowances, and
-- quarterly sync music licensing audits.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_audit_escrow_drawdowns (
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
  constraint ck_fitness_audit_escrow_drawdowns_reserve_present
    check (char_length(reserve_ledger_id) > 0),
  constraint ck_fitness_audit_escrow_drawdowns_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_fitness_audit_escrow_drawdowns_class_vocabulary
    check (drawdown_class IN ('chargeback_reserve', 'class_return_allowance', 'sync_music_licensing_audit')),
  constraint ck_fitness_audit_escrow_drawdowns_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_fitness_audit_escrow_drawdowns_drawn_positive
    check (drawn_cents > 0),
  constraint ck_fitness_audit_escrow_drawdowns_conservation
    check (remaining_cents = drawn_before_cents - drawn_cents)
);

comment on table public.fitness_audit_escrow_drawdowns is
  'The append-only position-locked drawdowns (migration 0043) against one FITNESS_AUDIT_ESCROW bucket''s ledger_transactions row: member chargeback reserves, class return allowances, and quarterly sync music licensing audits. UNIQUE (reserve_ledger_id, source_event_id) is the replay guard; UNIQUE (reserve_ledger_id, drawn_before_cents) is the position lock the balance derives from — a replayed event or a lost race throws, never a double spend. The conservation identity is pinned in a CHECK.';

-- ---------------------------------------------------------------------------
-- fitness_audit_escrow_reconciliations: the verified reconciliation of
-- record per escrow bucket — the release gate's key.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_audit_escrow_reconciliations (
  id                    uuid primary key default gen_random_uuid(),
  reserve_ledger_id     text not null,
  evidence_ref          text not null,
  reconciled_by         text not null,
  created_at            timestamptz not null default now(),
  unique (reserve_ledger_id),
  constraint ck_fitness_audit_escrow_reconciliations_reserve_present
    check (char_length(reserve_ledger_id) > 0),
  constraint ck_fitness_audit_escrow_reconciliations_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_fitness_audit_escrow_reconciliations_verifier_present
    check (char_length(reconciled_by) > 0)
);

comment on table public.fitness_audit_escrow_reconciliations is
  'The verified reconciliation of record (migration 0043) for one FITNESS_AUDIT_ESCROW bucket — insert-as-lock, UNIQUE (reserve_ledger_id): the FIRST reconciliation wins, and the release reads it fail-closed. No reconciliation of record, no release.';

-- ---------------------------------------------------------------------------
-- fitness_payout_gate_states: the fitness payout gate's two states of
-- record per (payee, studio franchise) — fail-closed when absent or unknown.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_payout_gate_states (
  id                             uuid primary key default gen_random_uuid(),
  payee_id                       text not null,
  studio_franchise_code          text not null,
  hipaa_gdpr_privacy_state       text not null,
  territorial_exclusivity_state  text not null,
  evidence_ref                   text not null,
  verified_by                    text not null,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  unique (payee_id, studio_franchise_code),
  constraint ck_fitness_payout_gate_states_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_fitness_payout_gate_states_franchise_present
    check (char_length(studio_franchise_code) > 0),
  constraint ck_fitness_payout_gate_states_privacy_vocabulary
    check (hipaa_gdpr_privacy_state IN ('unknown', 'cleared')),
  constraint ck_fitness_payout_gate_states_exclusivity_vocabulary
    check (territorial_exclusivity_state IN ('unknown', 'verified')),
  constraint ck_fitness_payout_gate_states_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_fitness_payout_gate_states_verifier_present
    check (char_length(verified_by) > 0)
);

comment on table public.fitness_payout_gate_states is
  'The fitness payout gate''s states of record (migration 0043) per (payee_id, studio_franchise_code): hipaa_gdpr_privacy_state (''unknown'' | ''cleared'') and territorial_exclusivity_state (''unknown'' | ''verified''). The gate reads fail-closed — hipaa_gdpr_privacy_cleared is true only when the privacy state is ''cleared'', territorial_studio_exclusivity_verified only when the exclusivity state is ''verified''; an absent record resolves null and ''unknown'' resolves false. UNIQUE (payee_id, studio_franchise_code): an upsert converges — a verification heals ''unknown''; states never regress through this table.';

-- ---------------------------------------------------------------------------
-- fitness_live_event_bonus_policies: one program's instant live-event bonus
-- rate of record.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_live_event_bonus_policies (
  id                    uuid primary key default gen_random_uuid(),
  program_id            text not null,
  bonus_bps             bigint not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (program_id),
  constraint ck_fitness_live_event_bonus_policies_program_present
    check (char_length(program_id) > 0),
  constraint ck_fitness_live_event_bonus_policies_rate_band
    check (bonus_bps >= 1 AND bonus_bps <= 10000)
);

comment on table public.fitness_live_event_bonus_policies is
  'One program''s instant live-event bonus rate of record (migration 0043): the bps share of a concluded synchronous broadcast''s revenue that posts to the lead trainer at event conclusion. UNIQUE (program_id): an upsert converges — the newest rate governs the next concluded event''s posting. ABSENT policy = a counted fail-closed skip — the walk never guesses a rate.';

-- ---------------------------------------------------------------------------
-- fitness_live_event_bonuses: the append-only instant performance bonus of
-- record per concluded synchronous broadcast row.
-- ---------------------------------------------------------------------------
create table if not exists public.fitness_live_event_bonuses (
  id                             uuid primary key default gen_random_uuid(),
  source_event_id                text not null,
  trainer_id                     text not null,
  program_id                     text not null,
  studio_franchise_code          text not null,
  period                         text not null,
  currency                       text not null,
  peak_simultaneous_viewers      bigint not null,
  live_event_revenue_cents       bigint not null,
  bonus_bps                      bigint not null,
  bonus_cents                    bigint not null,
  created_at                     timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_fitness_live_event_bonuses_source_present
    check (char_length(source_event_id) > 0),
  constraint ck_fitness_live_event_bonuses_trainer_present
    check (char_length(trainer_id) > 0),
  constraint ck_fitness_live_event_bonuses_program_present
    check (char_length(program_id) > 0),
  constraint ck_fitness_live_event_bonuses_franchise_present
    check (char_length(studio_franchise_code) > 0),
  constraint ck_fitness_live_event_bonuses_period_format
    check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint ck_fitness_live_event_bonuses_currency_present
    check (char_length(currency) > 0),
  constraint ck_fitness_live_event_bonuses_viewers_nonneg
    check (peak_simultaneous_viewers >= 0),
  constraint ck_fitness_live_event_bonuses_revenue_nonneg
    check (live_event_revenue_cents >= 0),
  constraint ck_fitness_live_event_bonuses_rate_band
    check (bonus_bps >= 1 AND bonus_bps <= 10000),
  constraint ck_fitness_live_event_bonuses_floor_pricing
    check (bonus_cents = floor(live_event_revenue_cents * bonus_bps / 10000))
);

comment on table public.fitness_live_event_bonuses is
  'The append-only instant performance bonus of record (migration 0043) per concluded synchronous broadcast row: the lead trainer (the row''s trainer_id of record), the event''s peak simultaneous viewers and revenue, and the program''s bonus policy rate pinned alongside the priced amount. UNIQUE (source_event_id) is the replay guard — a re-shipped broadcast throws, never a second bonus. The floor-pricing identity is pinned in a CHECK.';

-- ---------------------------------------------------------------------------
-- Row-level security: deny-all for every role — the service role reaches
-- these tables through grants and the service client's bypassRLS, the same
-- platform-wide boundary every migration since 0007 enforces. Every policy
-- is an explicitly named table-level policy.
-- ---------------------------------------------------------------------------
alter table public.fitness_audit_escrow_policies enable row level security;
alter table public.fitness_audit_escrow_drawdowns enable row level security;
alter table public.fitness_audit_escrow_reconciliations enable row level security;
alter table public.fitness_payout_gate_states enable row level security;
alter table public.fitness_live_event_bonus_policies enable row level security;
alter table public.fitness_live_event_bonuses enable row level security;

drop policy if exists fitness_audit_escrow_policies_service_role_all
  on public.fitness_audit_escrow_policies;
create policy fitness_audit_escrow_policies_service_role_all
  on public.fitness_audit_escrow_policies
  for all
  using (false)
  with check (false);

drop policy if exists fitness_audit_escrow_drawdowns_service_role_all
  on public.fitness_audit_escrow_drawdowns;
create policy fitness_audit_escrow_drawdowns_service_role_all
  on public.fitness_audit_escrow_drawdowns
  for all
  using (false)
  with check (false);

drop policy if exists fitness_audit_escrow_reconciliations_service_role_all
  on public.fitness_audit_escrow_reconciliations;
create policy fitness_audit_escrow_reconciliations_service_role_all
  on public.fitness_audit_escrow_reconciliations
  for all
  using (false)
  with check (false);

drop policy if exists fitness_payout_gate_states_service_role_all
  on public.fitness_payout_gate_states;
create policy fitness_payout_gate_states_service_role_all
  on public.fitness_payout_gate_states
  for all
  using (false)
  with check (false);

drop policy if exists fitness_live_event_bonus_policies_service_role_all
  on public.fitness_live_event_bonus_policies;
create policy fitness_live_event_bonus_policies_service_role_all
  on public.fitness_live_event_bonus_policies
  for all
  using (false)
  with check (false);

drop policy if exists fitness_live_event_bonuses_service_role_all
  on public.fitness_live_event_bonuses;
create policy fitness_live_event_bonuses_service_role_all
  on public.fitness_live_event_bonuses
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.fitness_audit_escrow_policies to service_role;
grant select, insert, update, delete on public.fitness_audit_escrow_drawdowns to service_role;
grant select, insert, update, delete on public.fitness_audit_escrow_reconciliations to service_role;
grant select, insert, update, delete on public.fitness_payout_gate_states to service_role;
grant select, insert, update, delete on public.fitness_live_event_bonus_policies to service_role;
grant select, insert, update, delete on public.fitness_live_event_bonuses to service_role;
