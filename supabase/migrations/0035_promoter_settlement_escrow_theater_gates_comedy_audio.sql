-- =============================================================================
-- 0035 — Promoter settlement escrow gates + venue hall fees + comedy audio
-- rights isolation (PR 31)
--
-- The live-theater/touring/comedy settlement-protection and rights-isolation
-- directive's durable facts of record, per the founder brief:
--
--   promoter_settlement_audits     <- upsertPromoterSettlementAudit /
--                                     getPromoterSettlementAudit
--     (the final night-of-show audit close of record per the addendum 11
--      triple (production_id, venue_id, show_date) — the persisted fact the
--      PROMOTER_BOX_OFFICE_SETTLEMENT_PENDING escrow release reads. The
--      escrow itself needs no table: it is a ledger_transactions receipt
--      (kind AND status 'promoter_box_office_settlement_pending', the
--      film-escrow/gaming-cashout/holdback pattern), and its verified
--      release flips that receipt 'settled' ONLY when this table carries a
--      'closed' audit for the stop. Fail-closed: an ABSENT close refuses
--      (audit_close_not_verified), ''unknown'' refuses, ONLY ''closed''
--      passes. UNIQUE per the triple: a re-recording converges — the newest
--      close governs the next release.)
--   theatrical_payout_gate_states  <- upsertTheatricalPayoutGateState /
--                                     getTheatricalPayoutGateState
--     (the theater vertical's per-(payee, production) payout-gate states of
--      record — grand_rights_cleared and venue_settlement_reconciled, the
--      estate gate-state pattern (0033). Fail-closed: absent refuses
--      (vertical_state_unknown), ''unknown'' refuses the specific condition,
--      only ''cleared''/''reconciled'' pass. UNIQUE per (payee_id,
--      production_id): an upsert converges — the newest states govern the
--      next dispatch.)
--   venue_hall_fee_policies        <- upsertVenueHallFeePolicy /
--                                     getVenueHallFeePolicy
--     (the founder-banded venue hall fee of record per (tour_id, venue_id):
--      the 15–25% venue cut on tour merchandise, deducted from gross merch
--      sales BEFORE the artist's apparel net releases. UNIQUE per the
--      pairing: an upsert converges.)
--
-- No foreign keys by design: all three tables key on reconciliation
-- identifiers from venue settlement ingestion (the addendum-11 triple's
-- identifier space, shared with theatrical_stop_settlements — which carries
-- no FK either, per 0034). Nothing here references a registry UUID.
--
-- The constraint discipline (the 0032 production lesson, applied): every
-- CHECK is a TABLE-level constraint with an explicit, table-namespaced name
-- (ck_ prefix); no column-level constraint ever shares a name with a
-- table-level one. UNIQUE constraints stay inline and unnamed (the 0032
-- pattern) — Postgres auto-names them off the table and columns, which
-- cannot collide with the explicit ck_ names.
--
-- The money discipline: hall_fee_rate_bps is an integer basis-points band
-- pinned to the founder's 15–25% directive in the CHECK — a policy outside
-- the band cannot persist.
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with the 0033 service-role grant set (the 0017–0034
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- promoter_settlement_audits: the final night-of-show audit close of record
-- per stop — the promoter settlement escrow release's fail-closed gate.
-- ---------------------------------------------------------------------------
create table if not exists public.promoter_settlement_audits (
  id             uuid primary key default gen_random_uuid(),
  production_id  text not null,
  venue_id       text not null,
  show_date      text not null,
  audit_state    text not null,
  evidence_ref   text,
  closed_by      text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (production_id, venue_id, show_date),
  constraint ck_promoter_settlement_audits_audit_state
    check (audit_state in ('unknown', 'closed')),
  constraint ck_promoter_settlement_audits_production_present
    check (char_length(production_id) > 0),
  constraint ck_promoter_settlement_audits_venue_present
    check (char_length(venue_id) > 0),
  constraint ck_promoter_settlement_audits_show_date_present
    check (char_length(show_date) > 0),
  constraint ck_promoter_settlement_audits_closed_shape
    check (
      audit_state <> 'closed'
      or (
        evidence_ref is not null and char_length(evidence_ref) > 0
        and closed_by is not null and char_length(closed_by) > 0
      )
    )
);

comment on table public.promoter_settlement_audits is
  'The final night-of-show audit close of record per the addendum-11 triple (migration 0035). The PROMOTER_BOX_OFFICE_SETTLEMENT_PENDING escrow release reads this fail-closed: an absent close refuses (audit_close_not_verified), ''unknown'' refuses, ONLY ''closed'' passes — and a ''closed'' row must carry its evidence_ref and closed_by provenance. UNIQUE (production_id, venue_id, show_date): a re-recording converges — the newest close governs the next release.';

-- ---------------------------------------------------------------------------
-- theatrical_payout_gate_states: the theater vertical's per-(payee,
-- production) payout-gate states of record — grand_rights_cleared and
-- venue_settlement_reconciled, fail-closed.
-- ---------------------------------------------------------------------------
create table if not exists public.theatrical_payout_gate_states (
  id                         uuid primary key default gen_random_uuid(),
  payee_id                   text not null,
  production_id              text not null,
  grand_rights_state         text not null,
  venue_settlement_state     text not null,
  grand_rights_evidence_ref  text,
  venue_settlement_evidence_ref text,
  verified_by                text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (payee_id, production_id),
  constraint ck_theatrical_gate_states_grand_rights_state
    check (grand_rights_state in ('unknown', 'cleared')),
  constraint ck_theatrical_gate_states_venue_settlement_state
    check (venue_settlement_state in ('unknown', 'reconciled')),
  constraint ck_theatrical_gate_states_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_theatrical_gate_states_production_present
    check (char_length(production_id) > 0)
);

comment on table public.theatrical_payout_gate_states is
  'The theater vertical''s per-(payee, production) payout-gate states of record the theatrical payout gate resolves through (migration 0035): grand_rights_cleared and venue_settlement_reconciled. Fail-closed: an absent row refuses (vertical_state_unknown), ''unknown'' refuses the specific condition, ONLY ''cleared''/''reconciled'' pass. UNIQUE (payee_id, production_id): a re-recording converges — the newest states govern the next dispatch.';

-- ---------------------------------------------------------------------------
-- venue_hall_fee_policies: the founder-banded 15–25% venue cut on tour
-- merchandise of record per (tour, venue) — deducted from gross merch sales
-- before the artist's apparel net releases.
-- ---------------------------------------------------------------------------
create table if not exists public.venue_hall_fee_policies (
  id                 uuid primary key default gen_random_uuid(),
  tour_id            text not null,
  venue_id           text not null,
  hall_fee_rate_bps  integer not null,
  venue_payee_id     text not null,
  venue_payee_name   text not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tour_id, venue_id),
  constraint ck_venue_hall_fee_policies_rate_band
    check (hall_fee_rate_bps >= 1500 and hall_fee_rate_bps <= 2500),
  constraint ck_venue_hall_fee_policies_tour_present
    check (char_length(tour_id) > 0),
  constraint ck_venue_hall_fee_policies_venue_present
    check (char_length(venue_id) > 0),
  constraint ck_venue_hall_fee_policies_venue_payee_present
    check (char_length(venue_payee_id) > 0),
  constraint ck_venue_hall_fee_policies_venue_payee_name_present
    check (char_length(venue_payee_name) > 0)
);

comment on table public.venue_hall_fee_policies is
  'The venue hall fee policy of record per (tour_id, venue_id) (migration 0035): the founder-banded 15–25% venue cut on tour merchandise — the CHECK pins the band, so a policy outside 1500–2500 bps cannot persist. The venue''s cut deducts from gross merch sales BEFORE the artist''s apparel net releases; the merch hall-fee release reads the policy fail-closed (absent refuses, never guesses). UNIQUE (tour_id, venue_id): an upsert converges.';

-- ---------------------------------------------------------------------------
-- RLS: deny-all for client roles (the 0017–0034 precedent) — explicit
-- policies so the denial is auditable, not an accident of missing grants.
-- ---------------------------------------------------------------------------
alter table public.promoter_settlement_audits enable row level security;
alter table public.theatrical_payout_gate_states enable row level security;
alter table public.venue_hall_fee_policies enable row level security;

drop policy if exists promoter_settlement_audits_service_role_all
  on public.promoter_settlement_audits;
create policy promoter_settlement_audits_service_role_all
  on public.promoter_settlement_audits
  for all
  using (false)
  with check (false);

drop policy if exists theatrical_payout_gate_states_service_role_all
  on public.theatrical_payout_gate_states;
create policy theatrical_payout_gate_states_service_role_all
  on public.theatrical_payout_gate_states
  for all
  using (false)
  with check (false);

drop policy if exists venue_hall_fee_policies_service_role_all
  on public.venue_hall_fee_policies;
create policy venue_hall_fee_policies_service_role_all
  on public.venue_hall_fee_policies
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.promoter_settlement_audits to service_role;
grant select, insert, update, delete on public.theatrical_payout_gate_states to service_role;
grant select, insert, update, delete on public.venue_hall_fee_policies to service_role;
