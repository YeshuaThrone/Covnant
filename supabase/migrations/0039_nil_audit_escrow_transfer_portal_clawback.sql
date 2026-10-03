-- =============================================================================
-- 0039 — The NIL audit escrow + transfer portal clawback lane's durable facts
-- of record (PR 35)
--
-- The founder's escrow directive's tables, per the brief:
--
--   nil_audit_escrow_policies        <- upsertNilAuditEscrowPolicy /
--                                       getNilAuditEscrowPolicy
--     (the escrow policy of record per (payee, school) scope
--      ('payee:<uuid>:school:<uuid>'): the founder-banded reserve rate,
--      500–1000 bps of each athletic department distribution (the
--      directive's 5–10%). UNIQUE per scope_key: an upsert converges —
--      the newest rate governs the next routing. ABSENT policy = no
--      escrow routing (the lane is opt-in per scope).)
--
--   nil_audit_escrow_drawdowns       <- insertNilAuditEscrowDrawdown /
--                                       listNilAuditEscrowDrawdowns
--     (the append-only per-event escrow drawdown — the held bucket's
--      outflow for a mid-season NCAA Transfer Portal reconciliation or a
--      tax withholding. UNIQUE per (reserve_ledger_id, source_event_id)
--      is the replay guard (a re-walked event draws once, never twice);
--      UNIQUE per (reserve_ledger_id, drawn_before_cents) is the
--      position lock — two racing draws at the same balance cannot both
--      persist. drawn_before + drawn = the balance BEFORE the drawn
--      event's sibling posting; remaining is the balance AFTER.)
--
--   nil_audit_escrow_reconciliations <- insertNilAuditEscrowReconciliation /
--                                       getNilAuditEscrowReconciliation
--     (the verified reconciliation of record per reserve ledger — the
--      release gate's key. UNIQUE per reserve_ledger_id: insert-as-lock,
--      the FIRST reconciliation wins; a concurrent second insert
--      surfaces the conflict. The escrow settles (releases) FAIL-CLOSED
--      — no reconciliation of record, the bucket holds.)
--
--   nil_advance_schedules            <- upsertNilAdvanceSchedule /
--                                       getNilAdvanceSchedule
--     (the NIL advance schedule of record per nil_contract_id: the
--      advance amount (integer cents) and the service term (start/end
--      UTC dates) the pro-rated clawback reads. UNIQUE per
--      nil_contract_id: an upsert converges — the newest terms govern
--      the next clawback calculation. The advance is the calculation's
--      INPUT, never a caller-supplied figure.)
--
--   nil_transfer_portal_entries      <- insertNilTransferPortalEntry /
--                                       getNilTransferPortalEntry
--     (the transfer portal entry of record per (nil_contract_id,
--      athlete_id): the entry date, the contract completion date when
--      known, and the derived entered-prior-to-completion flag. UNIQUE
--      per (nil_contract_id, athlete_id): insert-as-lock, the FIRST
--      entry wins; a re-shipped sheet or a lost race surfaces the
--      conflict. A mid-season entry is the clawback's TRIGGER.)
--
--   nil_unearned_clawbacks           <- insertNilUnearnedClawback /
--                                       getNilUnearnedClawback
--     (the pro-rated unearned-advance clawback of record per
--      portal_entry_id: the advance and term it pro-rated, the days
--      served, and the unearned balance that triggered the
--      nil_unearned_clawback debit hold (clawback_ledger_id). UNIQUE per
--      portal_entry_id: insert-as-lock — the calculation and its hold
--      land once. The pro-ration is pinned in a CHECK: unearned =
--      advance − floor(advance × served / total), ALWAYS — the identity
--      the records module's pure helper computes.)
--
-- No foreign keys by design: the tables key on ledger transaction ids
-- (the reserve and clawback holds), the sender's NIL contract ids, and
-- content-derived event ids — the same discipline 0036/0037/0038 applied
-- (the ten NIL tables carry no FK either).
--
-- The constraint discipline (the 0032 production lesson, applied): every
-- CHECK is a TABLE-level constraint with an explicit, table-namespaced name
-- (ck_ prefix); no column-level constraint ever shares a name with a
-- table-level one. UNIQUE constraints stay inline and unnamed (the 0032
-- pattern) — Postgres auto-names them off the table and columns, which
-- cannot collide with the explicit ck_ names.
--
-- The money discipline: escrow amounts are non-negative bigints, the
-- advance is positive, and the clawback's pro-ration identity is pinned
-- in a CHECK — a clawback outside its own arithmetic cannot persist.
-- The 5–10% escrow band lives in the bps CHECK (500–1000); the rate is
-- never read outside it.
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with the 0033 service-role grant set (the 0017–0038
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- nil_audit_escrow_policies: the escrow policy of record per scope — the
-- founder-banded 5–10% reserve rate.
-- ---------------------------------------------------------------------------
create table if not exists public.nil_audit_escrow_policies (
  id               uuid primary key default gen_random_uuid(),
  scope_key        text not null,
  reserve_rate_bps integer not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (scope_key),
  constraint ck_nil_audit_escrow_policies_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_nil_audit_escrow_policies_rate_band
    check (reserve_rate_bps >= 500 and reserve_rate_bps <= 1000)
);

comment on table public.nil_audit_escrow_policies is
  'The escrow policy of record (migration 0039) per (payee, school) scope: the founder-banded reserve rate, 500–1000 bps of each athletic department distribution — the directive''s 5–10% NIL audit escrow. UNIQUE (scope_key): an upsert converges — the newest rate governs the next routing. ABSENT policy = no escrow routing (the lane is opt-in per scope).';

-- ---------------------------------------------------------------------------
-- nil_audit_escrow_drawdowns: the append-only per-event escrow drawdown —
-- portal reconciliations and tax withholdings.
-- ---------------------------------------------------------------------------
create table if not exists public.nil_audit_escrow_drawdowns (
  id                 uuid primary key default gen_random_uuid(),
  reserve_ledger_id  text not null,
  scope_key          text not null,
  drawdown_class     text not null,
  source_event_id    text not null,
  drawn_before_cents bigint not null,
  drawn_cents        bigint not null,
  remaining_cents    bigint not null,
  created_at         timestamptz not null default now(),
  unique (reserve_ledger_id, source_event_id),
  unique (reserve_ledger_id, drawn_before_cents),
  constraint ck_nil_audit_escrow_drawdowns_reserve_present
    check (char_length(reserve_ledger_id) > 0),
  constraint ck_nil_audit_escrow_drawdowns_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_nil_audit_escrow_drawdowns_class
    check (drawdown_class in ('transfer_portal_reconciliation', 'tax_withholding')),
  constraint ck_nil_audit_escrow_drawdowns_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_nil_audit_escrow_drawdowns_amounts_nonneg
    check (
      drawn_before_cents >= 0
      and drawn_cents >= 0
      and remaining_cents >= 0
    ),
  constraint ck_nil_audit_escrow_drawdowns_balance_order
    check (drawn_cents <= drawn_before_cents)
);

comment on table public.nil_audit_escrow_drawdowns is
  'The append-only per-event escrow drawdown of record (migration 0039): the held bucket''s outflow for a mid-season NCAA Transfer Portal reconciliation or a tax withholding. UNIQUE (reserve_ledger_id, source_event_id) is the replay guard — a re-walked event draws once; UNIQUE (reserve_ledger_id, drawn_before_cents) is the position lock — two racing draws at the same balance cannot both persist. drawn_before ≥ drawn (a draw never overdraws its recorded balance).';

-- ---------------------------------------------------------------------------
-- nil_audit_escrow_reconciliations: the verified reconciliation of record —
-- the release gate's key, insert-as-lock per reserve ledger.
-- ---------------------------------------------------------------------------
create table if not exists public.nil_audit_escrow_reconciliations (
  id                uuid primary key default gen_random_uuid(),
  reserve_ledger_id text not null,
  evidence_ref      text not null,
  reconciled_by     text not null,
  created_at        timestamptz not null default now(),
  unique (reserve_ledger_id),
  constraint ck_nil_audit_escrow_reconciliations_reserve_present
    check (char_length(reserve_ledger_id) > 0),
  constraint ck_nil_audit_escrow_reconciliations_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_nil_audit_escrow_reconciliations_verifier_present
    check (char_length(reconciled_by) > 0)
);

comment on table public.nil_audit_escrow_reconciliations is
  'The verified reconciliation of record (migration 0039) per reserve ledger — the escrow release gate''s key, with evidence and verifier provenance. UNIQUE (reserve_ledger_id): insert-as-lock, the FIRST reconciliation wins; a concurrent second insert surfaces the conflict. The escrow settles FAIL-CLOSED — no reconciliation of record, the bucket holds.';

-- ---------------------------------------------------------------------------
-- nil_advance_schedules: the NIL advance schedule of record per contract —
-- the pro-ration's terms.
-- ---------------------------------------------------------------------------
create table if not exists public.nil_advance_schedules (
  id              uuid primary key default gen_random_uuid(),
  nil_contract_id text not null,
  athlete_id      text not null,
  school_id       text not null,
  advance_cents   bigint not null,
  term_start_date text not null,
  term_end_date   text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (nil_contract_id),
  constraint ck_nil_advance_schedules_contract_present
    check (char_length(nil_contract_id) > 0),
  constraint ck_nil_advance_schedules_athlete_present
    check (char_length(athlete_id) > 0),
  constraint ck_nil_advance_schedules_school_present
    check (char_length(school_id) > 0),
  constraint ck_nil_advance_schedules_advance_positive
    check (advance_cents > 0),
  constraint ck_nil_advance_schedules_term_dates_shape
    check (
      term_start_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      and term_end_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    ),
  constraint ck_nil_advance_schedules_term_ordered
    check (term_start_date < term_end_date)
);

comment on table public.nil_advance_schedules is
  'The NIL advance schedule of record (migration 0039) per contract: the advance amount (integer cents) and the service term (start/end UTC dates) the pro-rated clawback reads. UNIQUE (nil_contract_id): an upsert converges — the newest terms govern the next clawback calculation. The advance is the calculation''s INPUT, never a caller-supplied figure.';

-- ---------------------------------------------------------------------------
-- nil_transfer_portal_entries: the transfer portal entry of record per
-- (contract, athlete) — the clawback's trigger, insert-as-lock.
-- ---------------------------------------------------------------------------
create table if not exists public.nil_transfer_portal_entries (
  id                          uuid primary key default gen_random_uuid(),
  nil_contract_id             text not null,
  athlete_id                  text not null,
  school_id                   text not null,
  entry_date                  text not null,
  contract_completion_date    text,
  entered_prior_to_completion boolean not null,
  created_at                  timestamptz not null default now(),
  unique (nil_contract_id, athlete_id),
  constraint ck_nil_transfer_portal_entries_contract_present
    check (char_length(nil_contract_id) > 0),
  constraint ck_nil_transfer_portal_entries_athlete_present
    check (char_length(athlete_id) > 0),
  constraint ck_nil_transfer_portal_entries_school_present
    check (char_length(school_id) > 0),
  constraint ck_nil_transfer_portal_entries_dates_shape
    check (
      entry_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      and (contract_completion_date is null
           or contract_completion_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
    ),
  constraint ck_nil_transfer_portal_entries_prior_consistent
    check (
      entered_prior_to_completion
      = (contract_completion_date is null or entry_date < contract_completion_date)
    )
);

comment on table public.nil_transfer_portal_entries is
  'The transfer portal entry of record (migration 0039) per (contract, athlete): the entry date, the contract completion date when known, and the derived entered-prior-to-completion flag — true when the completion date is unknown (fail-closed, the clawback reads a mid-season entry) or the entry strictly precedes it. UNIQUE (nil_contract_id, athlete_id): insert-as-lock, the FIRST entry wins; a re-shipped sheet or a lost race surfaces the conflict. A mid-season entry is the clawback''s TRIGGER.';

-- ---------------------------------------------------------------------------
-- nil_unearned_clawbacks: the pro-rated unearned-advance clawback of record
-- per portal entry — the calculation and its debit hold, insert-as-lock.
-- ---------------------------------------------------------------------------
create table if not exists public.nil_unearned_clawbacks (
  id                uuid primary key default gen_random_uuid(),
  nil_contract_id   text not null,
  athlete_id        text not null,
  school_id         text not null,
  portal_entry_id   text not null,
  advance_cents     bigint not null,
  term_start_date   text not null,
  term_end_date     text not null,
  entry_date        text not null,
  total_term_days   integer not null,
  served_days       integer not null,
  unearned_cents    bigint not null,
  clawback_ledger_id text not null,
  created_at        timestamptz not null default now(),
  unique (portal_entry_id),
  constraint ck_nil_unearned_clawbacks_contract_present
    check (char_length(nil_contract_id) > 0),
  constraint ck_nil_unearned_clawbacks_athlete_present
    check (char_length(athlete_id) > 0),
  constraint ck_nil_unearned_clawbacks_school_present
    check (char_length(school_id) > 0),
  constraint ck_nil_unearned_clawbacks_entry_present
    check (char_length(portal_entry_id) > 0),
  constraint ck_nil_unearned_clawbacks_ledger_present
    check (char_length(clawback_ledger_id) > 0),
  constraint ck_nil_unearned_clawbacks_advance_positive
    check (advance_cents > 0),
  constraint ck_nil_unearned_clawbacks_term_dates_shape
    check (
      term_start_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      and term_end_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      and entry_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    ),
  constraint ck_nil_unearned_clawbacks_days_sane
    check (
      total_term_days > 0
      and served_days >= 0
      and served_days <= total_term_days
    ),
  constraint ck_nil_unearned_clawbacks_unearned_identity
    check (
      unearned_cents
      = advance_cents - floor((advance_cents::numeric * served_days) / total_term_days)::bigint
    )
);

comment on table public.nil_unearned_clawbacks is
  'The pro-rated unearned-advance clawback of record (migration 0039) per portal entry: the advance and term it pro-rated, the UTC days served at portal entry, and the unearned balance that triggered the nil_unearned_clawback debit hold (clawback_ledger_id). UNIQUE (portal_entry_id): insert-as-lock — the calculation and its hold land once. The pro-ration identity is pinned in a CHECK: unearned = advance − floor(advance × served / total), ALWAYS — the records module''s pure helper computes exactly this.';

-- ---------------------------------------------------------------------------
-- RLS: deny-all for client roles (the 0017–0038 precedent) — explicit
-- policies so the denial is auditable, not an accident of missing grants.
-- ---------------------------------------------------------------------------
alter table public.nil_audit_escrow_policies enable row level security;
alter table public.nil_audit_escrow_drawdowns enable row level security;
alter table public.nil_audit_escrow_reconciliations enable row level security;
alter table public.nil_advance_schedules enable row level security;
alter table public.nil_transfer_portal_entries enable row level security;
alter table public.nil_unearned_clawbacks enable row level security;

drop policy if exists nil_audit_escrow_policies_service_role_all
  on public.nil_audit_escrow_policies;
create policy nil_audit_escrow_policies_service_role_all
  on public.nil_audit_escrow_policies
  for all
  using (false)
  with check (false);

drop policy if exists nil_audit_escrow_drawdowns_service_role_all
  on public.nil_audit_escrow_drawdowns;
create policy nil_audit_escrow_drawdowns_service_role_all
  on public.nil_audit_escrow_drawdowns
  for all
  using (false)
  with check (false);

drop policy if exists nil_audit_escrow_reconciliations_service_role_all
  on public.nil_audit_escrow_reconciliations;
create policy nil_audit_escrow_reconciliations_service_role_all
  on public.nil_audit_escrow_reconciliations
  for all
  using (false)
  with check (false);

drop policy if exists nil_advance_schedules_service_role_all
  on public.nil_advance_schedules;
create policy nil_advance_schedules_service_role_all
  on public.nil_advance_schedules
  for all
  using (false)
  with check (false);

drop policy if exists nil_transfer_portal_entries_service_role_all
  on public.nil_transfer_portal_entries;
create policy nil_transfer_portal_entries_service_role_all
  on public.nil_transfer_portal_entries
  for all
  using (false)
  with check (false);

drop policy if exists nil_unearned_clawbacks_service_role_all
  on public.nil_unearned_clawbacks;
create policy nil_unearned_clawbacks_service_role_all
  on public.nil_unearned_clawbacks
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.nil_audit_escrow_policies to service_role;
grant select, insert, update, delete on public.nil_audit_escrow_drawdowns to service_role;
grant select, insert, update, delete on public.nil_audit_escrow_reconciliations to service_role;
grant select, insert, update, delete on public.nil_advance_schedules to service_role;
grant select, insert, update, delete on public.nil_transfer_portal_entries to service_role;
grant select, insert, update, delete on public.nil_unearned_clawbacks to service_role;
