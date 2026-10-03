-- =============================================================================
-- 0036 — Brand licensing: Net Sales realization, tiered royalties, dual-IP
-- splits, treaty withholding, sub-license cascade (PR 32)
--
-- The founder's brand-licensing directive's durable facts of record, per the
-- brief:
--
--   licensing_royalty_deals        <- upsertLicensingRoyaltyDeal /
--                                     getLicensingRoyaltyDeal
--     (the versioned royalty deal of record per license scope
--      (`license:<license_id>`): the marginal tier schedule (cumulative
--      volume thresholds — e.g. 8% to $1M, 10% $1M–$5M, 12% above — stored
--      as JSON), the agency commission inside the founder 15–35% band, the
--      single or dual (co-branded) IP licensor payees with their residence
--      countries, the statutory withholding default, and the RUNNING
--      cumulative counters (net sales walked, gross royalties earned) that
--      carry tier state ACROSS reporting periods. UNIQUE per scope_key: a
--      re-registration converges (the caller increments version and
--      preserves the counters — the theatrical production-deal discipline).)
--
--   licensing_royalty_applications <- insertLicensingRoyaltyApplication /
--                                     listLicensingRoyaltyApplications
--     (the append-only per-event tier walk — the cumulative state's commit.
--      UNIQUE per (deal_id, source_event_id) is the replay guard (a
--      re-shipped statement is a no-op, never a double walk); UNIQUE per
--      (deal_id, cumulative_before_cents) is the POSITION LOCK (the books/
--      art/theatrical discipline — the walk's start position arbitrates the
--      race, one writer wins, the loser retries at the advanced position).
--      Slices are stored as JSON — the audit detail (per-tier portions and
--      royalties) is recoverable exactly.)
--
--   licensing_treaty_rates         <- upsertLicensingTreatyRate /
--                                     getLicensingTreatyRate
--     (the double-taxation treaty rate of record per (source_country,
--      residence_country) — e.g. US→GB 0%, US→JP 10% on IP-licensing
--      royalties. UNIQUE per the pair: a re-registration converges — the
--      newest rate governs the next walk. The deal's
--      withholding_default_bps is the statutory fallback when a pair is
--      uncovered; when BOTH are absent the payout leg is HELD
--      (licensor_*_withheld_cents null on the application) — fail-closed,
--      never guessed.)
--
--   licensing_sub_licensees        <- upsertLicensingSubLicensee /
--                                     getLicensingSubLicensee
--     (the registered regional sub-licensee of record per (scope_key,
--      sub_licensee_id): the granted region of record and THE MASTER ROYALTY
--      OVERRIDE — the bps of the sub-licensee's Net Licensed Sales that pays
--      the master licensor, replacing the tier walk for the sub-licensed
--      region's money. UNIQUE per (scope_key, sub_licensee_id): an upsert
--      converges.)
--
--   licensing_sub_license_reports  <- upsertLicensingSubLicenseReport /
--                                     getLicensingSubLicenseReport /
--                                     listLicensingSubLicenseReports
--     (the regional sub-licensee gross reports of record — the tracked
--      facts the sub-license cascade reads. UNIQUE per source_event_id (the
--      once-only key); the row carries its recorded deduction legs, the
--      Net Licensed Sales they yield, the override of record applied, and
--      the computed master royalty — then the AUDIT TRAIL state: 'unknown'
--      refuses the net-proceeds release, ONLY 'reconciled' (with evidence
--      and reconciled_by provenance) passes — the promoter audit-close
--      discipline (0035).)
--
-- No foreign keys by design: all five tables key on reconciliation
-- identifiers from statement ingestion (the addendum 12 identifier space —
-- license_id/category_code/territory_iso, shared with match_queue, which
-- carries no FK either, per 0011). Nothing here references a registry UUID.
--
-- The constraint discipline (the 0032 production lesson, applied): every
-- CHECK is a TABLE-level constraint with an explicit, table-namespaced name
-- (ck_ prefix); no column-level constraint ever shares a name with a
-- table-level one. UNIQUE constraints stay inline and unnamed (the 0032
-- pattern) — Postgres auto-names them off the table and columns, which
-- cannot collide with the explicit ck_ names.
--
-- The money discipline: bps columns are integer basis points pinned to
-- their bands in CHECKs (agency 1500–3500, withholding 0–10000, override
-- 0–10000); counters are non-negative bigints; a policy outside the band
-- cannot persist.
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with the 0033 service-role grant set (the 0017–0035
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- licensing_royalty_deals: the versioned deal of record per license scope —
-- tier schedule, agency band, licensor payees, cumulative counters.
-- ---------------------------------------------------------------------------
create table if not exists public.licensing_royalty_deals (
  id                          uuid primary key default gen_random_uuid(),
  scope_key                   text not null,
  license_id                  text not null,
  currency                    text not null,
  tiers                       jsonb not null,
  agency_commission_bps       integer,
  licensor_a_payee_id         text not null,
  licensor_a_payee_name       text not null,
  licensor_a_country          text not null,
  licensor_b_payee_id         text,
  licensor_b_payee_name       text,
  licensor_b_country          text,
  withholding_default_bps     integer,
  cumulative_net_sales_cents  bigint not null default 0,
  cumulative_royalty_cents    bigint not null default 0,
  version                     integer not null default 1,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (scope_key),
  constraint ck_licensing_deals_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_licensing_deals_license_present
    check (char_length(license_id) > 0),
  constraint ck_licensing_deals_currency_shape
    check (currency ~ '^[A-Z]{3}$'),
  constraint ck_licensing_deals_agency_band
    check (agency_commission_bps is null or (agency_commission_bps >= 1500 and agency_commission_bps <= 3500)),
  constraint ck_licensing_deals_licensor_a_present
    check (char_length(licensor_a_payee_id) > 0 and char_length(licensor_a_payee_name) > 0),
  constraint ck_licensing_deals_licensor_a_country_shape
    check (licensor_a_country ~ '^[A-Z]{2}$'),
  constraint ck_licensing_deals_licensor_b_shape
    check (
      (licensor_b_payee_id is null and licensor_b_payee_name is null and licensor_b_country is null)
      or (char_length(licensor_b_payee_id) > 0 and char_length(licensor_b_payee_name) > 0
          and licensor_b_country ~ '^[A-Z]{2}$')
    ),
  constraint ck_licensing_deals_withholding_default_band
    check (withholding_default_bps is null or (withholding_default_bps >= 0 and withholding_default_bps <= 10000)),
  constraint ck_licensing_deals_counters_nonneg
    check (cumulative_net_sales_cents >= 0 and cumulative_royalty_cents >= 0),
  constraint ck_licensing_deals_version_positive
    check (version >= 1)
);

comment on table public.licensing_royalty_deals is
  'The versioned royalty deal of record per license scope (migration 0036): the marginal tier schedule as JSON (cumulative volume thresholds — e.g. 8% to $1M, 10% $1M-$5M, 12% above), the agency commission inside the founder 15-35% band, the single or dual (co-branded 50-50) IP licensor payees with residence countries, the statutory withholding default, and the running cumulative counters that carry tier state ACROSS reporting periods. UNIQUE (scope_key): a re-registration converges — the caller increments version and preserves the counters.';

-- ---------------------------------------------------------------------------
-- licensing_royalty_applications: the append-only per-event tier walk —
-- position-locked, replay-guarded, the cumulative state's commit.
-- ---------------------------------------------------------------------------
create table if not exists public.licensing_royalty_applications (
  id                        uuid primary key default gen_random_uuid(),
  deal_id                   uuid not null,
  scope_key                 text not null,
  source_event_id           text not null,
  period                    text,
  net_sales_cents           bigint not null,
  cumulative_before_cents   bigint not null,
  royalty_cents             bigint not null,
  slices                    jsonb not null,
  agency_commission_cents   bigint not null default 0,
  licensor_a_gross_cents    bigint not null,
  licensor_b_gross_cents    bigint not null default 0,
  dust_cents                bigint not null default 0,
  withholding_rate_bps      integer,
  licensor_a_withheld_cents bigint,
  licensor_b_withheld_cents bigint,
  withholding_ref           text,
  created_at                timestamptz not null default now(),
  unique (deal_id, source_event_id),
  unique (deal_id, cumulative_before_cents),
  constraint ck_licensing_applications_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_licensing_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_licensing_applications_net_nonneg
    check (net_sales_cents >= 0),
  constraint ck_licensing_applications_position_nonneg
    check (cumulative_before_cents >= 0),
  constraint ck_licensing_applications_royalty_nonneg
    check (royalty_cents >= 0),
  constraint ck_licensing_applications_period_shape
    check (period is null or period ~ '^\d{4}-\d{2}$'),
  constraint ck_licensing_applications_licensor_a_nonneg
    check (licensor_a_gross_cents >= 0),
  constraint ck_licensing_applications_licensor_b_nonneg
    check (licensor_b_gross_cents >= 0),
  constraint ck_licensing_applications_dust_nonneg
    check (dust_cents >= 0),
  constraint ck_licensing_applications_withholding_band
    check (withholding_rate_bps is null or (withholding_rate_bps >= 0 and withholding_rate_bps <= 10000)),
  constraint ck_licensing_applications_withheld_nonneg
    check (
      (licensor_a_withheld_cents is null or licensor_a_withheld_cents >= 0)
      and (licensor_b_withheld_cents is null or licensor_b_withheld_cents >= 0)
    ),
  constraint ck_licensing_applications_split_conserves
    check (licensor_a_gross_cents + licensor_b_gross_cents + dust_cents
           = royalty_cents - agency_commission_cents)
);

comment on table public.licensing_royalty_applications is
  'The append-only per-event royalty walk (migration 0036): net_sales_cents walks the deal''s tiers from cumulative_before_cents; slices (JSON) recover the per-tier portions and royalties exactly; the agency commission deducts from the earned gross royalty BEFORE the dual-IP 50-50 split (split_conserves pins the arithmetic); the withholding legs record what the treaty held back before payout. UNIQUE (deal_id, source_event_id) is the replay guard; UNIQUE (deal_id, cumulative_before_cents) is the position lock — one writer wins the cumulative state, the loser retries at the advanced position.';

-- ---------------------------------------------------------------------------
-- licensing_treaty_rates: the double-taxation treaty rate of record per
-- (source, residence) pair.
-- ---------------------------------------------------------------------------
create table if not exists public.licensing_treaty_rates (
  id                uuid primary key default gen_random_uuid(),
  source_country    text not null,
  residence_country text not null,
  rate_bps          integer not null,
  treaty_ref        text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (source_country, residence_country),
  constraint ck_licensing_treaty_source_shape
    check (source_country ~ '^[A-Z]{2}$'),
  constraint ck_licensing_treaty_residence_shape
    check (residence_country ~ '^[A-Z]{2}$'),
  constraint ck_licensing_treaty_rate_band
    check (rate_bps >= 0 and rate_bps <= 10000),
  constraint ck_licensing_treaty_ref_present
    check (char_length(treaty_ref) > 0)
);

comment on table public.licensing_treaty_rates is
  'The double-taxation treaty rate of record per (source_country, residence_country) (migration 0036) — e.g. US to GB 0%, US to JP 10% on IP-licensing royalties. UNIQUE (source_country, residence_country): a re-registration converges — the newest rate governs the next walk. When a pair is uncovered the deal''s withholding_default_bps is the statutory fallback; when BOTH are absent the payout leg is HELD — fail-closed, never guessed.';

-- ---------------------------------------------------------------------------
-- licensing_sub_licensees: the registered regional sub-licensee of record —
-- granted region and the master royalty override.
-- ---------------------------------------------------------------------------
create table if not exists public.licensing_sub_licensees (
  id                  uuid primary key default gen_random_uuid(),
  scope_key           text not null,
  sub_licensee_id     text not null,
  region_code         text not null,
  master_override_bps integer not null,
  payee_id            text not null,
  payee_name          text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (scope_key, sub_licensee_id),
  constraint ck_licensing_sub_licensees_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_licensing_sub_licensees_id_present
    check (char_length(sub_licensee_id) > 0),
  constraint ck_licensing_sub_licensees_region_shape
    check (region_code ~ '^[A-Z]{2}$'),
  constraint ck_licensing_sub_licensees_override_band
    check (master_override_bps >= 0 and master_override_bps <= 10000),
  constraint ck_licensing_sub_licensees_payee_present
    check (char_length(payee_id) > 0 and char_length(payee_name) > 0)
);

comment on table public.licensing_sub_licensees is
  'The registered regional sub-licensee of record per (scope_key, sub_licensee_id) (migration 0036): the granted region of record (ISO alpha-2) and THE MASTER ROYALTY OVERRIDE — bps of the sub-licensee''s Net Licensed Sales that pays the master licensor, replacing the tier walk for the sub-licensed region''s money. UNIQUE (scope_key, sub_licensee_id): an upsert converges.';

-- ---------------------------------------------------------------------------
-- licensing_sub_license_reports: the regional sub-licensee gross reports of
-- record — the audit-trail facts the net-proceeds release reads.
-- ---------------------------------------------------------------------------
create table if not exists public.licensing_sub_license_reports (
  id                   uuid primary key default gen_random_uuid(),
  scope_key            text not null,
  sub_licensee_id      text not null,
  region_code          text not null,
  period               text,
  source_event_id      text not null,
  gross_cents          bigint not null,
  trade_discount_cents bigint not null default 0,
  returned_goods_cents bigint not null default 0,
  shipping_freight_cents bigint not null default 0,
  vat_cents            bigint not null default 0,
  net_sales_cents      bigint not null,
  master_override_bps  integer not null,
  master_royalty_cents bigint not null,
  audit_state          text not null,
  evidence_ref         text,
  reconciled_by        text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_licensing_sub_reports_scope_present
    check (char_length(scope_key) > 0),
  constraint ck_licensing_sub_reports_licensee_present
    check (char_length(sub_licensee_id) > 0),
  constraint ck_licensing_sub_reports_region_shape
    check (region_code ~ '^[A-Z]{2}$'),
  constraint ck_licensing_sub_reports_period_shape
    check (period is null or period ~ '^\d{4}-\d{2}$'),
  constraint ck_licensing_sub_reports_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_licensing_sub_reports_gross_nonneg
    check (gross_cents >= 0),
  constraint ck_licensing_sub_reports_legs_nonneg
    check (
      trade_discount_cents >= 0 and returned_goods_cents >= 0
      and shipping_freight_cents >= 0 and vat_cents >= 0
    ),
  constraint ck_licensing_sub_reports_net_conserves
    check (net_sales_cents >= 0 and net_sales_cents
           = gross_cents - trade_discount_cents - returned_goods_cents
             - shipping_freight_cents - vat_cents),
  constraint ck_licensing_sub_reports_override_band
    check (master_override_bps >= 0 and master_override_bps <= 10000),
  constraint ck_licensing_sub_reports_royalty_nonneg
    check (master_royalty_cents >= 0),
  constraint ck_licensing_sub_reports_audit_state
    check (audit_state in ('unknown', 'reconciled')),
  constraint ck_licensing_sub_reports_reconciled_shape
    check (
      audit_state <> 'reconciled'
      or (
        evidence_ref is not null and char_length(evidence_ref) > 0
        and reconciled_by is not null and char_length(reconciled_by) > 0
      )
    )
);

comment on table public.licensing_sub_license_reports is
  'The regional sub-licensee gross reports of record (migration 0036): the tracked facts of the sub-license cascade. The row carries its recorded deduction legs, the Net Licensed Sales they yield (net_conserves pins gross minus the four legs exactly), the master override of record applied, and the computed master royalty. The audit trail is fail-closed: ''unknown'' refuses the net-proceeds release, ONLY ''reconciled'' — with evidence_ref and reconciled_by provenance — passes (the promoter audit-close discipline, 0035). UNIQUE (source_event_id): a re-shipped manifest is a no-op, never a double report.';

-- ---------------------------------------------------------------------------
-- RLS: deny-all for client roles (the 0017–0035 precedent) — explicit
-- policies so the denial is auditable, not an accident of missing grants.
-- ---------------------------------------------------------------------------
alter table public.licensing_royalty_deals enable row level security;
alter table public.licensing_royalty_applications enable row level security;
alter table public.licensing_treaty_rates enable row level security;
alter table public.licensing_sub_licensees enable row level security;
alter table public.licensing_sub_license_reports enable row level security;

drop policy if exists licensing_royalty_deals_service_role_all
  on public.licensing_royalty_deals;
create policy licensing_royalty_deals_service_role_all
  on public.licensing_royalty_deals
  for all
  using (false)
  with check (false);

drop policy if exists licensing_royalty_applications_service_role_all
  on public.licensing_royalty_applications;
create policy licensing_royalty_applications_service_role_all
  on public.licensing_royalty_applications
  for all
  using (false)
  with check (false);

drop policy if exists licensing_treaty_rates_service_role_all
  on public.licensing_treaty_rates;
create policy licensing_treaty_rates_service_role_all
  on public.licensing_treaty_rates
  for all
  using (false)
  with check (false);

drop policy if exists licensing_sub_licensees_service_role_all
  on public.licensing_sub_licensees;
create policy licensing_sub_licensees_service_role_all
  on public.licensing_sub_licensees
  for all
  using (false)
  with check (false);

drop policy if exists licensing_sub_license_reports_service_role_all
  on public.licensing_sub_license_reports;
create policy licensing_sub_license_reports_service_role_all
  on public.licensing_sub_license_reports
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.licensing_royalty_deals to service_role;
grant select, insert, update, delete on public.licensing_royalty_applications to service_role;
grant select, insert, update, delete on public.licensing_treaty_rates to service_role;
grant select, insert, update, delete on public.licensing_sub_licensees to service_role;
grant select, insert, update, delete on public.licensing_sub_license_reports to service_role;
