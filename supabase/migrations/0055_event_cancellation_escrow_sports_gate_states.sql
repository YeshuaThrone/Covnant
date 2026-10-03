-- =============================================================================
-- 0055 — The event cancellation escrow, the sports payout gate states, and
--        the staged sports applications' instant-posting journal stamps
--        (PR 51, the founder sports directive)
--
-- Three new tables plus two journal-stamp columns:
--
--   sports_event_cancellation_escrow_policies
--                                       <- upsertEventCancellationEscrowPolicy /
--                                          getEventCancellationEscrowPolicy
--     (the event cancellation escrow rate of record per
--      promoter:{payeeId}:event:{eventRef}: the founder band, 1500–2000 bps
--      (15–20%) share of the scope's net gate receipts that locks into the
--      EVENT_CANCELLATION_ESCROW bucket at payout. UNIQUE per scope_key: an
--      upsert converges — the newest rate governs the next routing.)
--
--   sports_event_cancellation_escrow_drawdowns
--                                       <- insertEventCancellationEscrowDrawdown /
--                                          listEventCancellationEscrowDrawdowns
--     (the append-only drawdown truth: weather delays, athlete withdrawals,
--      and mandatory ticket refund calls spending one escrow's balance.
--      UNIQUE per (reserve_ledger_id, source_event_id): the replay guard.
--      UNIQUE per (reserve_ledger_id, drawn_before_cents): the position
--      lock. The conservation CHECK pins remaining = before − drawn ≥ 0
--      per row; the balance derives from this append-only truth, never a
--      mutable counter.)
--
--   sports_payout_gate_states           <- upsertSportsPayoutGateState /
--                                          getSportsPayoutGateState
--     (the sports payout gate's durable states of record per (payee_id,
--      event_ref): the event completion telemetry verification, the
--      promoter insurance clearance, the collegiate NIL waterfall flag with
--      its NIL compliance audit state, and the event's completion timestamp
--      the escrow release's 48-hour clock anchors to. UNIQUE per
--      (payee_id, event_ref): an upsert converges — a verification heals
--      'unknown'; states never regress through this table. The telemetry
--      CHECK pins the completion timestamp: a 'verified' telemetry state
--      carries its verified-at moment, 'unknown' carries none.)
--
--   ALTER: sports_resale_royalty_applications and
--   sports_biometric_micro_payout_applications (migration 0054) gain a
--   nullable journal_id — PR 50 stages the applications with journal_id
--   null; PR 51's instant posting CAS-stamps the posting's journal of
--   record (the OTA instant-posting discipline; the reconciliation of
--   staged applications against journals surfaces any gap).
--
-- SQL CHECK vocabularies are byte-identical to the TypeScript engine's
-- union constants (src/modules/sports/records.ts:
-- SPORTS_EVENT_CANCELLATION_DRAWDOWN_CLASSES, SPORTS_GATE_TELEMETRY_STATES,
-- SPORTS_GATE_INSURANCE_STATES, SPORTS_GATE_NIL_AUDIT_STATES) and to the
-- SQLite mirror's CHECKs (src/lib/server/sqliteStore.ts) — verified
-- byte-identical before CI dispatch (the PR 133/134/137/138 discipline).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- sports_event_cancellation_escrow_policies: the event cancellation escrow
-- rate of record — the founder band, 1500–2000 bps (15–20%).
-- ---------------------------------------------------------------------------
create table if not exists public.sports_event_cancellation_escrow_policies (
  id                uuid primary key default gen_random_uuid(),
  scope_key         text not null,
  reserve_rate_bps  bigint not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (scope_key),
  constraint ck_sports_event_cancellation_escrow_policies_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_sports_event_cancellation_escrow_policies_rate_in_founder_band
    check (reserve_rate_bps >= 1500 AND reserve_rate_bps <= 2000)
);

comment on table public.sports_event_cancellation_escrow_policies is
  'The event cancellation escrow rate of record per scope_key (migration 0055) — promoter:{payeeId}:event:{eventRef} — the founder-banded 1500–2000 bps (15–20%) share of the scope''s net gate receipts that locks into the EVENT_CANCELLATION_ESCROW bucket at payout, drawn down against weather delays, athlete withdrawals, and mandatory ticket refund calls, released only after verified event completion telemetry plus 48 elapsed hours post-event. The CHECK pins the band at the database too.';

-- ---------------------------------------------------------------------------
-- sports_event_cancellation_escrow_drawdowns: the append-only drawdown
-- truth — weather delays, athlete withdrawals, and mandatory ticket refund
-- calls spending one escrow's balance.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_event_cancellation_escrow_drawdowns (
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
  constraint ck_sports_event_cancellation_escrow_drawdowns_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_sports_event_cancellation_escrow_drawdowns_class_vocabulary
    check (drawdown_class IN ('weather_delay', 'athlete_withdrawal', 'ticket_refund_call')),
  constraint ck_sports_event_cancellation_escrow_drawdowns_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_sports_event_cancellation_escrow_drawdowns_amount_positive
    check (drawn_cents > 0),
  constraint ck_sports_event_cancellation_escrow_drawdowns_before_non_negative
    check (drawn_before_cents >= 0),
  constraint ck_sports_event_cancellation_escrow_drawdowns_position_conserves
    check (remaining_cents = drawn_before_cents - drawn_cents AND remaining_cents >= 0)
);
create index if not exists idx_sports_event_cancellation_escrow_drawdowns_reserve
  on public.sports_event_cancellation_escrow_drawdowns (reserve_ledger_id);

comment on table public.sports_event_cancellation_escrow_drawdowns is
  'The append-only event cancellation escrow drawdown truth (migration 0055) — one row per event exposure executed against one escrow''s balance: a weather delay, an athlete withdrawal, or a mandatory ticket refund call. UNIQUE (reserve_ledger_id, source_event_id): the replay guard. UNIQUE (reserve_ledger_id, drawn_before_cents): the position lock — the position-locked insert before the money moves. The conservation CHECK pins remaining = before − drawn ≥ 0 per row; the balance derives from this append-only truth, never a mutable counter.';

-- ---------------------------------------------------------------------------
-- sports_payout_gate_states: the sports payout gate's durable states of
-- record — the fail-closed release/resolver inputs.
-- ---------------------------------------------------------------------------
create table if not exists public.sports_payout_gate_states (
  id                             uuid primary key default gen_random_uuid(),
  payee_id                       text not null,
  event_ref                      text not null,
  event_completion_telemetry_state text not null,
  promoter_insurance_state       text not null,
  is_collegiate_nil_waterfall    boolean not null,
  nil_compliance_audit_state     text not null,
  event_completed_at             timestamptz,
  evidence_ref                   text not null,
  verified_by                    text not null,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  unique (payee_id, event_ref),
  constraint ck_sports_payout_gate_states_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_sports_payout_gate_states_event_present
    check (char_length(event_ref) > 0),
  constraint ck_sports_payout_gate_states_telemetry_state_vocabulary
    check (event_completion_telemetry_state IN ('unknown', 'verified')),
  constraint ck_sports_payout_gate_states_insurance_state_vocabulary
    check (promoter_insurance_state IN ('unknown', 'cleared')),
  constraint ck_sports_payout_gate_states_nil_audit_state_vocabulary
    check (nil_compliance_audit_state IN ('unknown', 'cleared')),
  constraint ck_sports_payout_gate_states_telemetry_verified_carries_timestamp
    check (
      (event_completion_telemetry_state = 'verified' AND event_completed_at IS NOT NULL)
      OR (event_completion_telemetry_state = 'unknown' AND event_completed_at IS NULL)
    ),
  constraint ck_sports_payout_gate_states_evidence_present
    check (char_length(evidence_ref) > 0),
  constraint ck_sports_payout_gate_states_verifier_present
    check (char_length(verified_by) > 0)
);

comment on table public.sports_payout_gate_states is
  'The sports payout gate''s durable states of record per (payee_id, event_ref) (migration 0055) — the event completion telemetry verification, the promoter insurance clearance, the collegiate NIL waterfall flag with its NIL compliance audit state (gender equity compliance + university athletic association disclosure), and the event''s completion timestamp the escrow release''s 48-hour clock anchors to. UNIQUE (payee_id, event_ref): an upsert converges — a verification heals ''unknown''; states never regress through this table. The payout gate resolves fail-closed: an absent record and an ''unknown'' state BOTH refuse.';

-- ---------------------------------------------------------------------------
-- The staged applications' instant-posting journal stamps (PR 51): the
-- nullable journal_id the CAS stamp flips from null to the posting's
-- journal of record.
-- ---------------------------------------------------------------------------
alter table public.sports_resale_royalty_applications
  add column if not exists journal_id uuid;
alter table public.sports_biometric_micro_payout_applications
  add column if not exists journal_id uuid;

-- ---------------------------------------------------------------------------
-- RLS deny-all — the service side reads and writes through service_role
-- (the standard grant set); authenticated and anon clients are denied by
-- policy (the platform's deny-all pattern).
-- ---------------------------------------------------------------------------
alter table public.sports_event_cancellation_escrow_policies enable row level security;
drop policy if exists sports_event_cancellation_escrow_policies_service_role_all
  on public.sports_event_cancellation_escrow_policies;
create policy sports_event_cancellation_escrow_policies_service_role_all
  on public.sports_event_cancellation_escrow_policies
  for all
  using (false)
  with check (false);

alter table public.sports_event_cancellation_escrow_drawdowns enable row level security;
drop policy if exists sports_event_cancellation_escrow_drawdowns_service_role_all
  on public.sports_event_cancellation_escrow_drawdowns;
create policy sports_event_cancellation_escrow_drawdowns_service_role_all
  on public.sports_event_cancellation_escrow_drawdowns
  for all
  using (false)
  with check (false);

alter table public.sports_payout_gate_states enable row level security;
drop policy if exists sports_payout_gate_states_service_role_all
  on public.sports_payout_gate_states;
create policy sports_payout_gate_states_service_role_all
  on public.sports_payout_gate_states
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.sports_event_cancellation_escrow_policies to service_role;
grant select, insert, update, delete on public.sports_event_cancellation_escrow_drawdowns to service_role;
grant select, insert, update, delete on public.sports_payout_gate_states to service_role;
