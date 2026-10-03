-- =============================================================================
-- 0034 — AGBOR box office + theatrical recoupment tiers: versioned production
-- deals, per-stop settlement sheets, investor recoupment applications, and
-- split accruals (PR 30)
--
-- The live-theater/touring/comedy box office directive's durable facts of
-- record, per the founder brief — venue settlement reports (AXS,
-- Ticketmaster, Eventbrite, VenuePOS) convert to artist and producer payouts
-- through the box office engine:
--
--   theatrical_production_deals     <- registerTheatricalProductionDeal /
--                                      getTheatricalProductionDeal
--     (the versioned deal of record per production scope — the tier table
--      the waterfall walks. deal_class 'comedy_guarantee' pins the
--      greater-of terms: flat_guarantee_cents vs guarantee_percentage_bps of
--      the net box office after venue expense recoupment, whichever is
--      greater, paying the artist payee. deal_class
--      'theatrical_recoupment' pins the capitalization budget the investors
--      recoup 100% of net profits against, then the automatic 50% producer /
--      50% investor shift. grand_rights_rate_bps is the optional top-line
--      Grand Rights licensing rate — the 6–10% founder band validates at
--      registration and here — with its theatrical publisher of record
--      (Concord, MTI, Rodgers & Hammerstein); the deduction is taken from
--      AGBOR before the production profit splits. UNIQUE per scope_key: a
--      re-registration increments version — accrued designations keep their
--      version's history, never re-cut.)
--   theatrical_stop_settlements     <- insertTheatricalStopSettlement /
--                                      listTheatricalStopSettlements
--     (the per-stop settlement sheets — the multi-city venue reconciliation
--      ledger keyed on (production_id, venue_id, show_date), the addendum 11
--      triple. Every leg of the stop's math rides the row: GBOR, the four
--      AGBOR deduction legs (local sales tax, card processing fees, facility
--      maintenance + FF&E fees, group sales discounts), AGBOR itself, the
--      Grand Rights deduction, the venue expense recoupment against the
--      local promoter expense cap (the capped overage stays visible), and
--      the deal payout. The conservation checks pin the AGBOR equation and
--      the cap arithmetic EXACTLY in the database — the sheet cannot drift
--      from the engine. UNIQUE per (production_id, venue_id, show_date,
--      source_event_id): the reconciliation triple plus the funding row is
--      the once-only key — a replayed event is the unique violation, never a
--      double settlement.)
--   theatrical_recoupment_applications <- insertTheatricalRecoupmentApplication /
--                                      listTheatricalRecoupmentApplications
--     (the append-only investor recoupment ledger — the books/art
--      discipline: UNIQUE per (deal_id, source_event_id) is the replay
--      guard; UNIQUE per (deal_id, recouped_before_cents) is the POSITION
--      lock, the insert-as-lock arbiter — two concurrent stop events derive
--      the same running position and exactly one wins it; the loser
--      re-derives from the append-only truth.)
--   theatrical_split_accruals       <- insertTheatricalSplitAccrual /
--                                      listTheatricalSplitAccruals
--     (the append-only payout designation ledger: allocations is the jsonb
--      array of per-payee designated shares ({ payee_id, payee_name, role,
--      share_cents }) — the Grand Rights publisher leg, the artist's
--      guarantee payout, the investor recoupment leg, and the post-recoupment
--      50/50 producer/investor legs. dust_cents is the sub-cent residue of
--      the half splits — conservation: allocations + dust = basis, exact,
--      nothing rounds up into a payee's credit. UNIQUE per (scope_key,
--      source_event_id): the once-only designation per funding event per
--      production.)
--
-- The constraint discipline (the 0032 production lesson, applied): every
-- CHECK and FK is a TABLE-level constraint with an explicit, table-
-- namespaced name (ck_/fk_ prefixes); no column-level constraint ever
-- shares a name with a table-level one. UNIQUE constraints stay inline and
-- unnamed (the 0032 pattern) — Postgres auto-names them off the table and
-- columns, which cannot collide with the explicit ck_/fk_ names.
--
-- The money discipline: every *_cents column is an integer cent count (the
-- Don ledger's whole-cents contract); the engine computes in exact bigint
-- statement micros and posts whole cents. Ledger-child tables carry the
-- 0027 foreign-key discipline (cascade on delete).
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with the 0033 service-role grant set (the 0017–0033
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- theatrical_production_deals: the versioned deal of record per production
-- scope — the tier table the box office waterfall walks.
-- ---------------------------------------------------------------------------
create table if not exists public.theatrical_production_deals (
  id                       uuid primary key default gen_random_uuid(),
  scope_key                text not null,
  deal_class               text not null,
  grand_rights_rate_bps    integer,
  publisher_code           text,
  publisher_payee_id       text,
  publisher_payee_name     text,
  artist_payee_id          text,
  artist_payee_name        text,
  producer_payee_id        text,
  producer_payee_name      text,
  investor_payee_id        text,
  investor_payee_name      text,
  flat_guarantee_cents     integer,
  guarantee_percentage_bps integer,
  capitalization_budget_cents integer,
  recouped_cents           integer not null default 0,
  currency                 text not null,
  version                  integer not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (scope_key),
  constraint ck_theatrical_deals_deal_class
    check (deal_class in ('comedy_guarantee', 'theatrical_recoupment')),
  constraint ck_theatrical_deals_grand_rights_band
    check (grand_rights_rate_bps is null or (grand_rights_rate_bps >= 600 and grand_rights_rate_bps <= 1000)),
  constraint ck_theatrical_deals_grand_rights_pairing
    check (
      (grand_rights_rate_bps is null) = (publisher_code is null)
      and (grand_rights_rate_bps is null) = (publisher_payee_id is null)
      and (grand_rights_rate_bps is null) = (publisher_payee_name is null)
    ),
  constraint ck_theatrical_deals_guarantee_pct
    check (guarantee_percentage_bps is null or (guarantee_percentage_bps >= 0 and guarantee_percentage_bps <= 10000)),
  constraint ck_theatrical_deals_comedy_shape
    check (
      deal_class <> 'comedy_guarantee'
      or (
        flat_guarantee_cents is not null and flat_guarantee_cents > 0
        and guarantee_percentage_bps is not null
        and artist_payee_id is not null and artist_payee_name is not null
        and capitalization_budget_cents is null
        and producer_payee_id is null and producer_payee_name is null
        and investor_payee_id is null and investor_payee_name is null
      )
    ),
  constraint ck_theatrical_deals_recoupment_shape
    check (
      deal_class <> 'theatrical_recoupment'
      or (
        capitalization_budget_cents is not null and capitalization_budget_cents > 0
        and producer_payee_id is not null and producer_payee_name is not null
        and investor_payee_id is not null and investor_payee_name is not null
        and flat_guarantee_cents is null
        and artist_payee_id is null and artist_payee_name is null
      )
    ),
  constraint ck_theatrical_deals_recouped
    check (
      recouped_cents >= 0
      and (capitalization_budget_cents is null or recouped_cents <= capitalization_budget_cents)
    ),
  constraint ck_theatrical_deals_version
    check (version >= 1),
  constraint ck_theatrical_deals_currency
    check (currency ~ '^[A-Z]{3}$')
);

comment on table public.theatrical_production_deals is
  'The versioned box office deal of record per production scope (migration 0034). deal_class comedy_guarantee pins the greater-of terms — flat_guarantee_cents vs guarantee_percentage_bps of the net box office after venue expense recoupment, whichever is greater, paying the artist payee (e.g. $10,000 flat vs 85%). deal_class theatrical_recoupment pins the capitalization budget investors recoup 100% of net profits against, then the automatic 50% producer / 50% investor shift. grand_rights_rate_bps is the optional top-line Grand Rights licensing rate inside the 6–10% founder band (600–1000 bps), paired with the theatrical publisher of record (Concord, MTI, Rodgers & Hammerstein) — the deduction is taken from AGBOR before the production profit splits. UNIQUE (scope_key): a re-registration increments version; accrued designations keep their version''s history — never re-cut.';

-- ---------------------------------------------------------------------------
-- theatrical_stop_settlements: the per-stop settlement sheets — the
-- multi-city venue reconciliation ledger keyed on the addendum 11 triple.
-- ---------------------------------------------------------------------------
create table if not exists public.theatrical_stop_settlements (
  id                          uuid primary key default gen_random_uuid(),
  production_id               text not null,
  venue_id                    text not null,
  show_date                   text not null,
  source_event_id             text not null,
  settlement_id               text not null,
  sender_code                 text not null,
  city                        text not null,
  gbor_cents                  integer not null,
  sales_tax_cents             integer not null,
  card_fees_cents             integer not null,
  facility_fee_cents          integer not null,
  ffe_fee_cents               integer not null,
  group_discount_cents        integer not null,
  agbor_cents                 integer not null,
  grand_rights_cents          integer not null,
  venue_expense_cents         integer not null,
  promoter_expense_cap_cents  integer not null,
  venue_expense_recouped_cents integer not null,
  venue_expense_capped_cents  integer not null,
  deal_payout_cents           integer not null,
  currency                    text not null,
  created_at                  timestamptz not null default now(),
  unique (production_id, venue_id, show_date, source_event_id),
  constraint ck_theatrical_stops_sender
    check (sender_code in ('axs', 'ticketmaster', 'eventbrite', 'venuepos')),
  constraint ck_theatrical_stops_show_date
    check (show_date ~ '^\d{4}-\d{2}-\d{2}$'),
  constraint ck_theatrical_stops_legs_nonnegative
    check (
      gbor_cents >= 0 and sales_tax_cents >= 0 and card_fees_cents >= 0
      and facility_fee_cents >= 0 and ffe_fee_cents >= 0 and group_discount_cents >= 0
      and grand_rights_cents >= 0 and venue_expense_cents >= 0
      and promoter_expense_cap_cents >= 0 and venue_expense_recouped_cents >= 0
      and venue_expense_capped_cents >= 0 and deal_payout_cents >= 0
    ),
  constraint ck_theatrical_stops_agbor_conservation
    check (
      agbor_cents =
        gbor_cents - sales_tax_cents - card_fees_cents
        - facility_fee_cents - ffe_fee_cents - group_discount_cents
    ),
  constraint ck_theatrical_stops_grand_rights_top_line
    check (grand_rights_cents <= agbor_cents),
  constraint ck_theatrical_stops_expense_cap
    check (
      venue_expense_recouped_cents = least(venue_expense_cents, promoter_expense_cap_cents)
      and venue_expense_capped_cents = venue_expense_cents - venue_expense_recouped_cents
    )
);

create index if not exists theatrical_stop_settlements_production_idx
  on public.theatrical_stop_settlements (production_id);
create index if not exists theatrical_stop_settlements_venue_idx
  on public.theatrical_stop_settlements (venue_id);
create index if not exists theatrical_stop_settlements_show_date_idx
  on public.theatrical_stop_settlements (show_date);

comment on table public.theatrical_stop_settlements is
  'The per-stop settlement sheet of record (migration 0034) — the multi-city venue reconciliation keyed on (production_id, venue_id, show_date), the addendum 11 triple. Every leg of the stop''s math rides the row: GBOR, the AGBOR deduction legs (local sales tax, card processing fees, facility maintenance + FF&E fees, group sales discounts), AGBOR, the Grand Rights deduction, the venue expense recoupment against the local promoter expense cap (the capped overage stays visible), and the deal payout. The conservation checks pin the AGBOR equation and the cap arithmetic exactly — the sheet cannot drift from the engine. UNIQUE (production_id, venue_id, show_date, source_event_id) is the once-only key: a replayed event is the unique violation, never a double settlement.';

-- ---------------------------------------------------------------------------
-- theatrical_recoupment_applications: the append-only investor recoupment
-- ledger — inserted, never updated or deleted.
-- ---------------------------------------------------------------------------
create table if not exists public.theatrical_recoupment_applications (
  id                    uuid primary key default gen_random_uuid(),
  deal_id               uuid not null,
  scope_key             text not null,
  source_event_id       text not null,
  recouped_before_cents integer not null,
  applied_cents         integer not null,
  remaining_cents       integer not null,
  created_at            timestamptz not null default now(),
  unique (deal_id, source_event_id),
  unique (deal_id, recouped_before_cents),
  constraint fk_theatrical_recoupment_applications_deal
    foreign key (deal_id) references public.theatrical_production_deals (id)
    on delete cascade,
  constraint ck_theatrical_recoupment_positions
    check (recouped_before_cents >= 0 and applied_cents > 0 and remaining_cents >= 0),
  constraint ck_theatrical_recoupment_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_theatrical_recoupment_event_present
    check (char_length(source_event_id) > 0)
);

create index if not exists theatrical_recoupment_applications_deal_idx
  on public.theatrical_recoupment_applications (deal_id);

comment on table public.theatrical_recoupment_applications is
  'The append-only investor recoupment ledger (migration 0034): investors receive 100% of net profits until the capitalization budget fully recoups. UNIQUE (deal_id, source_event_id) is the replay guard — a replayed application is the unique violation, never a double recovery; UNIQUE (deal_id, recouped_before_cents) is the POSITION lock (the insert-as-lock arbiter) — two concurrent stop events derive the same running position and exactly one wins it; the loser re-derives from the append-only truth. Rows are inserted and never updated or deleted — audit-preserving.';

-- ---------------------------------------------------------------------------
-- theatrical_split_accruals: the append-only payout designation ledger —
-- the once-only designations behind the payout gates.
-- ---------------------------------------------------------------------------
create table if not exists public.theatrical_split_accruals (
  id              uuid primary key default gen_random_uuid(),
  deal_id         uuid not null,
  scope_key       text not null,
  deal_class      text not null,
  source_event_id text not null,
  basis_cents     integer not null,
  allocations     jsonb not null,
  dust_cents      integer not null default 0,
  created_at      timestamptz not null default now(),
  unique (scope_key, source_event_id),
  constraint fk_theatrical_split_accruals_deal
    foreign key (deal_id) references public.theatrical_production_deals (id)
    on delete cascade,
  constraint ck_theatrical_accruals_deal_class
    check (deal_class in ('comedy_guarantee', 'theatrical_recoupment')),
  constraint ck_theatrical_accruals_basis
    check (basis_cents >= 0),
  constraint ck_theatrical_accruals_dust
    check (dust_cents >= 0),
  constraint ck_theatrical_accruals_allocations_shape
    check (jsonb_typeof(allocations) = 'array'),
  constraint ck_theatrical_accruals_event_present
    check (char_length(source_event_id) > 0)
);

create index if not exists theatrical_split_accruals_deal_idx
  on public.theatrical_split_accruals (deal_id);

comment on table public.theatrical_split_accruals is
  'The append-only theatrical payout designation ledger (migration 0034): allocations is the jsonb array of per-payee designated shares ({ payee_id, payee_name, role, share_cents }) — the Grand Rights publisher leg, the artist''s guarantee payout, the investor recoupment leg, and the post-recoupment 50% producer / 50% investor legs. dust_cents is the sub-cent residue of the half splits — conservation: allocations + dust = basis, exact, nothing rounds up into a payee''s credit. UNIQUE (scope_key, source_event_id): the once-only designation per funding event per production — a replayed event is the unique violation, never a double designation.';

-- ---------------------------------------------------------------------------
-- RLS: deny-all for client roles (the 0017–0033 precedent) — explicit
-- policies so the denial is auditable, not an accident of missing grants.
-- ---------------------------------------------------------------------------
alter table public.theatrical_production_deals enable row level security;
alter table public.theatrical_stop_settlements enable row level security;
alter table public.theatrical_recoupment_applications enable row level security;
alter table public.theatrical_split_accruals enable row level security;

drop policy if exists theatrical_production_deals_service_role_all
  on public.theatrical_production_deals;
create policy theatrical_production_deals_service_role_all
  on public.theatrical_production_deals
  for all
  using (false)
  with check (false);

drop policy if exists theatrical_stop_settlements_service_role_all
  on public.theatrical_stop_settlements;
create policy theatrical_stop_settlements_service_role_all
  on public.theatrical_stop_settlements
  for all
  using (false)
  with check (false);

drop policy if exists theatrical_recoupment_applications_service_role_all
  on public.theatrical_recoupment_applications;
create policy theatrical_recoupment_applications_service_role_all
  on public.theatrical_recoupment_applications
  for all
  using (false)
  with check (false);

drop policy if exists theatrical_split_accruals_service_role_all
  on public.theatrical_split_accruals;
create policy theatrical_split_accruals_service_role_all
  on public.theatrical_split_accruals
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.theatrical_production_deals to service_role;
grant select, insert, update, delete on public.theatrical_stop_settlements to service_role;
grant select, insert, update, delete on public.theatrical_recoupment_applications to service_role;
grant select, insert, update, delete on public.theatrical_split_accruals to service_role;
