-- =============================================================================
-- 0040 — The spatial POS + occupancy royalty + zone allocation lane's durable
-- facts of record (PR 36)
--
-- The founder spatial directive's tables, per the brief:
--
--   spatial_occupancy_tier_schedules <- upsertSpatialOccupancyTierSchedule /
--                                        getSpatialOccupancyTierSchedule
--     (the occupancy royalty schedule of record per (venue_id, year): the
--      sliding-scale basis ('annual_throughput' — the directive's 5% on
--      the first 500,000 annual turnstile entries scaling to 8% above
--      1,000,000 — or 'footprint_sqft') and the ordered tier bands as
--      JSON text. UNIQUE per (venue_id, year): an upsert converges — the
--      newest schedule governs the next walk. ABSENT schedule = no
--      royalty (the walk refuses fail-closed).)
--
--   spatial_overhead_policies        <- upsertSpatialOverheadPolicy /
--                                       getSpatialOverheadPolicy
--     (the shared facility overhead policy of record per (venue_id,
--      year): the three park-wide bps legs — security, wristband
--      maintenance, ticketing platform — deducted BEFORE the net IP
--      distribution. UNIQUE per (venue_id, year): an upsert converges.
--      ABSENT policy = no deduction and no royalty (every IP
--      distribution refuses fail-closed).)
--
--   spatial_zone_assignments         <- upsertSpatialZoneAssignment /
--                                       getSpatialZoneAssignment
--     (the assigned IP owner of record per (venue_id, zone_code): the
--      owner the zone's merch and food-and-beverage sales route to, at
--      the zone's royalty rate. UNIQUE per (venue_id, zone_code): an
--      upsert converges — the newest assignment governs the next zone
--      walk. ABSENT assignment = the zone walk skips fail-closed —
--      routing is never guessed.)
--
--   spatial_micro_policies           <- upsertSpatialMicroPolicy /
--                                       getSpatialMicroPolicy
--     (the dynamic micro-royalty rates of record per (venue_id,
--      zone_code): micro-dollars per guest dwell minute and per ride
--      session as registered by venue sensors and RFID wristbands.
--      UNIQUE per (venue_id, zone_code): an upsert converges. ABSENT
--      policy = the telemetry walk skips fail-closed.)
--
--   spatial_throughput_years         <- advanceSpatialThroughputYear /
--                                       getSpatialThroughputYear
--     (the cumulative annual throughput tracker of record per (venue_id,
--      year): the turnstile entries an occupancy walk consumes advance
--      the standing position; the next walk reads the position BEFORE
--      advancing. UNIQUE per (venue_id, year): the tracker converges —
--      an advance adds to the standing row, never a second row.)
--
--   spatial_royalty_applications     <- insertSpatialRoyaltyApplication /
--                                       getSpatialRoyaltyApplication
--     (the append-only occupancy royalty application of record per
--      source event: the Adjusted Location Sales calculator's legs
--      (gross venue ticket + merch revenue − local occupancy taxes −
--      venue infrastructure COGS − approved group tour discounts = Net
--      Spatial Licensed Revenue), the shared overhead deduction (the
--      three park-wide legs deducted prior to the royalty basis), and
--      the tier walk's committed bands with the cumulative throughput
--      position before/after. UNIQUE per source_event_id is the replay
--      guard — a re-walked event throws, never a double royalty. The
--      calculator identity, the overhead ordering, and the overhead
--      legs' sum are pinned in CHECKs — an application outside its own
--      arithmetic cannot persist.)
--
--   spatial_zone_allocations         <- insertSpatialZoneAllocation /
--                                       getSpatialZoneAllocation
--     (the append-only zone allocation of record per source event: the
--      zone's food-and-beverage or retail gross, the shared overhead
--      legs deducted first, and the allocated basis routed to the
--      assigned IP owner's royalty waterfall at the zone's rate. UNIQUE
--      per source_event_id is the replay guard — a re-walked sale
--      throws, never a double allocation. The overhead ordering and the
--      overhead legs' sum are pinned in CHECKs.)
--
--   spatial_micro_royalty_ledger     <- insertSpatialMicroRoyalty /
--                                       getSpatialMicroRoyalty
--     (the append-only dynamic micro-royalty of record per source
--      event: the dwell-minute and ride-session legs at the zone's
--      registered micro rates, the micro-dollar total, and the
--      whole-cent floor that posts to the IP owner. UNIQUE per
--      source_event_id is the replay guard — a re-walked telemetry
--      event throws, never a double micro-payout. Both legs and the
--      micro→cent conversion are pinned in CHECKs.)
--
-- No foreign keys by design: the tables key on ledger transaction ids,
-- the sender's venue/zone identifiers, and content-derived event ids —
-- the same discipline 0036/0037/0038/0039 applied (the NIL tables carry
-- no FK either).
--
-- The constraint discipline (the 0032 production lesson, applied): every
-- CHECK is a TABLE-level constraint with an explicit, table-namespaced name
-- (ck_ prefix); no column-level constraint ever shares a name with a
-- table-level one. UNIQUE constraints stay inline and unnamed (the 0032
-- pattern) — Postgres auto-names them off the table and columns, which
-- cannot collide with the explicit ck_ names.
--
-- The money discipline: revenues, taxes, COGS, discounts, overhead legs,
-- and royalties are non-negative bigints of integer cents; the tier
-- royalty is non-negative; micro-royalties carry micro-dollar legs with
-- the cent floor at posting. Negative-net events do not post a royalty —
-- they land as verdict 'held_negative_net' rows (the held truth), never
-- a negative royalty.
--
-- Additive-only: create-table-if-not-exists, no ALTERs, no data backfill.
-- RLS is deny-all with the 0033 service-role grant set (the 0017–0039
-- precedent): client roles read nothing; workers use the service role.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- spatial_occupancy_tier_schedules: the occupancy royalty schedule of record
-- per (venue, year) — the sliding-scale tier bands.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_occupancy_tier_schedules (
  id         uuid primary key default gen_random_uuid(),
  venue_id   text not null,
  year       text not null,
  basis      text not null,
  bands      text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue_id, year),
  constraint ck_spatial_occupancy_tier_schedules_venue_present
    check (char_length(venue_id) > 0),
  constraint ck_spatial_occupancy_tier_schedules_year_format
    check (year ~ '^[0-9]{4}$'),
  constraint ck_spatial_occupancy_tier_schedules_basis
    check (basis in ('annual_throughput', 'footprint_sqft')),
  constraint ck_spatial_occupancy_tier_schedules_bands_present
    check (char_length(bands) > 0)
);

comment on table public.spatial_occupancy_tier_schedules is
  'The occupancy royalty schedule of record (migration 0040) per (venue_id, year): the sliding-scale basis (''annual_throughput'' — the directive''s 5% on the first 500,000 annual turnstile entries scaling to 8% above 1,000,000 — or ''footprint_sqft'') and the ordered tier bands as JSON text. UNIQUE (venue_id, year): an upsert converges — the newest schedule governs the next walk. ABSENT schedule = no royalty (fail-closed).';

-- ---------------------------------------------------------------------------
-- spatial_overhead_policies: the shared facility overhead policy of record —
-- the three park-wide bps legs deducted prior to net IP distribution.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_overhead_policies (
  id                        uuid primary key default gen_random_uuid(),
  venue_id                  text not null,
  year                      text not null,
  security_bps              integer not null,
  wristband_maintenance_bps integer not null,
  ticketing_platform_bps    integer not null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (venue_id, year),
  constraint ck_spatial_overhead_policies_venue_present
    check (char_length(venue_id) > 0),
  constraint ck_spatial_overhead_policies_year_format
    check (year ~ '^[0-9]{4}$'),
  constraint ck_spatial_overhead_policies_bps_band
    check (
      security_bps >= 0 and security_bps <= 10000
      and wristband_maintenance_bps >= 0 and wristband_maintenance_bps <= 10000
      and ticketing_platform_bps >= 0 and ticketing_platform_bps <= 10000
    )
);

comment on table public.spatial_overhead_policies is
  'The shared facility overhead policy of record (migration 0040) per (venue_id, year): the three park-wide bps legs — security, wristband maintenance, ticketing platform — deducted BEFORE the net IP distribution. UNIQUE (venue_id, year): an upsert converges. ABSENT policy = no deduction and no royalty (fail-closed).';

-- ---------------------------------------------------------------------------
-- spatial_zone_assignments: the assigned IP owner of record per (venue,
-- zone) — the zone walk's routing.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_zone_assignments (
  id                  uuid primary key default gen_random_uuid(),
  venue_id            text not null,
  zone_code           text not null,
  assigned_ip_owner_id text not null,
  royalty_bps         integer not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (venue_id, zone_code),
  constraint ck_spatial_zone_assignments_venue_present
    check (char_length(venue_id) > 0),
  constraint ck_spatial_zone_assignments_zone_present
    check (char_length(zone_code) > 0),
  constraint ck_spatial_zone_assignments_owner_present
    check (char_length(assigned_ip_owner_id) > 0),
  constraint ck_spatial_zone_assignments_bps_band
    check (royalty_bps >= 0 and royalty_bps <= 10000)
);

comment on table public.spatial_zone_assignments is
  'The assigned IP owner of record (migration 0040) per (venue_id, zone_code): the owner the zone''s merch and food-and-beverage sales route to, at the zone''s royalty rate. UNIQUE (venue_id, zone_code): an upsert converges — the newest assignment governs the next zone walk. ABSENT assignment = the zone walk skips fail-closed — routing is never guessed.';

-- ---------------------------------------------------------------------------
-- spatial_micro_policies: the dynamic micro-royalty rates of record per
-- (venue, zone) — dwell time and ride session micro rates.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_micro_policies (
  id                      uuid primary key default gen_random_uuid(),
  venue_id                text not null,
  zone_code               text not null,
  micros_per_dwell_minute bigint not null,
  micros_per_ride_session bigint not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (venue_id, zone_code),
  constraint ck_spatial_micro_policies_venue_present
    check (char_length(venue_id) > 0),
  constraint ck_spatial_micro_policies_zone_present
    check (char_length(zone_code) > 0),
  constraint ck_spatial_micro_policies_rates_nonneg
    check (micros_per_dwell_minute >= 0 and micros_per_ride_session >= 0)
);

comment on table public.spatial_micro_policies is
  'The dynamic micro-royalty rates of record (migration 0040) per (venue_id, zone_code): micro-dollars per guest dwell minute and per ride session as registered by venue sensors and RFID wristbands. UNIQUE (venue_id, zone_code): an upsert converges. ABSENT policy = the telemetry walk skips fail-closed.';

-- ---------------------------------------------------------------------------
-- spatial_throughput_years: the cumulative annual throughput tracker of
-- record per (venue, year).
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_throughput_years (
  id                uuid primary key default gen_random_uuid(),
  venue_id          text not null,
  year              text not null,
  cumulative_entries bigint not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (venue_id, year),
  constraint ck_spatial_throughput_years_venue_present
    check (char_length(venue_id) > 0),
  constraint ck_spatial_throughput_years_year_format
    check (year ~ '^[0-9]{4}$'),
  constraint ck_spatial_throughput_years_entries_nonneg
    check (cumulative_entries >= 0)
);

comment on table public.spatial_throughput_years is
  'The cumulative annual throughput tracker of record (migration 0040) per (venue_id, year): the turnstile entries an occupancy walk consumes advance the standing position; the next walk reads the position BEFORE advancing. UNIQUE (venue_id, year): the tracker converges — an advance adds to the standing row, never a second row.';

-- ---------------------------------------------------------------------------
-- spatial_royalty_applications: the append-only occupancy royalty application
-- of record per source event — the Adjusted Location Sales calculator's
-- legs, the shared overhead deduction, and the tier walk's committed bands.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_royalty_applications (
  id                                uuid primary key default gen_random_uuid(),
  source_event_id                   text not null,
  sender                            text not null,
  venue_id                          text not null,
  zone_code                         text not null,
  spatial_footprint_sqft            integer not null,
  period                            text not null,
  ticket_revenue_cents              bigint not null,
  merch_revenue_cents               bigint not null,
  gross_revenue_cents               bigint not null,
  occupancy_tax_cents               bigint not null,
  infrastructure_cogs_cents         bigint not null,
  group_tour_discount_cents         bigint not null,
  net_spatial_licensed_revenue_cents bigint not null,
  overhead_security_cents           bigint not null,
  overhead_wristband_cents          bigint not null,
  overhead_ticketing_cents          bigint not null,
  overhead_total_cents              bigint not null,
  royalty_basis_cents               bigint not null,
  tier_basis                        text not null,
  tier_schedule_ref                 text,
  tier_legs                         text not null,
  entries_count                     integer not null,
  entries_before                    bigint,
  entries_after                     bigint,
  occupancy_royalty_cents           bigint not null,
  verdict                           text not null,
  created_at                        timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_spatial_royalty_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_spatial_royalty_applications_sender
    check (sender in ('turnstile', 'pass')),
  constraint ck_spatial_royalty_applications_venue_present
    check (char_length(venue_id) > 0),
  constraint ck_spatial_royalty_applications_zone_present
    check (char_length(zone_code) > 0),
  constraint ck_spatial_royalty_applications_footprint_positive
    check (spatial_footprint_sqft > 0),
  constraint ck_spatial_royalty_applications_revenues_nonneg
    check (
      ticket_revenue_cents >= 0
      and merch_revenue_cents >= 0
      and gross_revenue_cents >= 0
      and occupancy_tax_cents >= 0
      and infrastructure_cogs_cents >= 0
      and group_tour_discount_cents >= 0
    ),
  constraint ck_spatial_royalty_applications_calculator_identity
    check (
      net_spatial_licensed_revenue_cents
      = ticket_revenue_cents + merch_revenue_cents
        - occupancy_tax_cents - infrastructure_cogs_cents
        - group_tour_discount_cents
    ),
  constraint ck_spatial_royalty_applications_overhead_nonneg
    check (
      overhead_security_cents >= 0
      and overhead_wristband_cents >= 0
      and overhead_ticketing_cents >= 0
      and overhead_total_cents >= 0
      and royalty_basis_cents >= 0
    ),
  constraint ck_spatial_royalty_applications_overhead_legs
    check (
      overhead_total_cents
      = overhead_security_cents + overhead_wristband_cents
        + overhead_ticketing_cents
    ),
  constraint ck_spatial_royalty_applications_overhead_ordering
    check (
      verdict = 'held_negative_net'
      or royalty_basis_cents = net_spatial_licensed_revenue_cents - overhead_total_cents
    ),
  constraint ck_spatial_royalty_applications_held_money_legs_zeroed
    check (
      verdict = 'paid'
      or (
        overhead_security_cents = 0
        and overhead_wristband_cents = 0
        and overhead_ticketing_cents = 0
        and overhead_total_cents = 0
        and royalty_basis_cents = 0
        and occupancy_royalty_cents = 0
      )
    ),
  constraint ck_spatial_royalty_applications_tier_basis
    check (tier_basis in ('annual_throughput', 'footprint_sqft')),
  constraint ck_spatial_royalty_applications_entries_nonneg
    check (entries_count >= 0),
  constraint ck_spatial_royalty_applications_royalty_nonneg
    check (occupancy_royalty_cents >= 0),
  constraint ck_spatial_royalty_applications_verdict
    check (verdict in ('paid', 'held_negative_net')),
  constraint ck_spatial_royalty_applications_held_when_negative_net
    check (
      (verdict = 'paid' and net_spatial_licensed_revenue_cents >= 0)
      or (verdict = 'held_negative_net' and net_spatial_licensed_revenue_cents < 0)
    )
);

comment on table public.spatial_royalty_applications is
  'The append-only occupancy royalty application of record (migration 0040) per source event: the Adjusted Location Sales calculator''s legs (gross venue ticket + merch revenue − local occupancy taxes − venue infrastructure COGS − approved group tour discounts = Net Spatial Licensed Revenue), the shared facility overhead legs deducted prior to the royalty basis, and the tier walk''s committed bands with the cumulative throughput position before/after. UNIQUE (source_event_id) is the replay guard — a re-walked event throws, never a double royalty. The calculator identity, the overhead ordering, and the legs'' sum are pinned in CHECKs; negative-net events hold (verdict ''held_negative_net'') without a royalty posting.';

-- ---------------------------------------------------------------------------
-- spatial_zone_allocations: the append-only zone allocation of record per
-- source event — the zone's sales routed to the assigned IP owner's royalty
-- waterfall, shared overhead deducted first.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_zone_allocations (
  id                     uuid primary key default gen_random_uuid(),
  source_event_id        text not null,
  row_class              text not null,
  venue_id               text not null,
  zone_code              text not null,
  period                 text not null,
  gross_cents            bigint not null,
  overhead_security_cents bigint not null,
  overhead_wristband_cents bigint not null,
  overhead_ticketing_cents bigint not null,
  overhead_total_cents   bigint not null,
  allocated_basis_cents  bigint not null,
  assigned_ip_owner_id   text not null,
  royalty_bps            integer not null,
  royalty_cents          bigint not null,
  created_at             timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_spatial_zone_allocations_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_spatial_zone_allocations_row_class
    check (row_class in ('fnb', 'retail')),
  constraint ck_spatial_zone_allocations_venue_present
    check (char_length(venue_id) > 0),
  constraint ck_spatial_zone_allocations_zone_present
    check (char_length(zone_code) > 0),
  constraint ck_spatial_zone_allocations_gross_nonneg
    check (gross_cents >= 0),
  constraint ck_spatial_zone_allocations_overhead_nonneg
    check (
      overhead_security_cents >= 0
      and overhead_wristband_cents >= 0
      and overhead_ticketing_cents >= 0
      and overhead_total_cents >= 0
      and allocated_basis_cents >= 0
    ),
  constraint ck_spatial_zone_allocations_overhead_legs
    check (
      overhead_total_cents
      = overhead_security_cents + overhead_wristband_cents
        + overhead_ticketing_cents
    ),
  constraint ck_spatial_zone_allocations_overhead_ordering
    check (allocated_basis_cents = gross_cents - overhead_total_cents),
  constraint ck_spatial_zone_allocations_owner_present
    check (char_length(assigned_ip_owner_id) > 0),
  constraint ck_spatial_zone_allocations_bps_band
    check (royalty_bps >= 0 and royalty_bps <= 10000),
  constraint ck_spatial_zone_allocations_royalty_nonneg
    check (royalty_cents >= 0)
);

comment on table public.spatial_zone_allocations is
  'The append-only zone allocation of record (migration 0040) per source event: the zone''s food-and-beverage or retail gross, the shared facility overhead legs deducted first, and the allocated basis routed to the assigned IP owner''s royalty waterfall at the zone''s rate. UNIQUE (source_event_id) is the replay guard — a re-walked sale throws, never a double allocation. The overhead ordering and the legs'' sum are pinned in CHECKs.';

-- ---------------------------------------------------------------------------
-- spatial_micro_royalty_ledger: the append-only dynamic micro-royalty of
-- record per source event — dwell time and ride session legs at the zone's
-- registered micro rates.
-- ---------------------------------------------------------------------------
create table if not exists public.spatial_micro_royalty_ledger (
  id                      uuid primary key default gen_random_uuid(),
  source_event_id         text not null,
  venue_id                text not null,
  zone_code               text not null,
  wristband_id            text not null,
  sensor_id               text not null,
  period                  text not null,
  dwell_minutes           integer not null,
  ride_sessions           integer not null,
  micros_per_dwell_minute bigint not null,
  micros_per_ride_session bigint not null,
  dwell_royalty_micros    bigint not null,
  session_royalty_micros  bigint not null,
  total_royalty_micros    bigint not null,
  royalty_cents           bigint not null,
  created_at              timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_spatial_micro_royalty_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_spatial_micro_royalty_venue_present
    check (char_length(venue_id) > 0),
  constraint ck_spatial_micro_royalty_zone_present
    check (char_length(zone_code) > 0),
  constraint ck_spatial_micro_royalty_wristband_present
    check (char_length(wristband_id) > 0),
  constraint ck_spatial_micro_royalty_sensor_present
    check (char_length(sensor_id) > 0),
  constraint ck_spatial_micro_royalty_units_nonneg
    check (dwell_minutes >= 0 and ride_sessions >= 0),
  constraint ck_spatial_micro_royalty_rates_nonneg
    check (micros_per_dwell_minute >= 0 and micros_per_ride_session >= 0),
  constraint ck_spatial_micro_royalty_dwell_leg
    check (dwell_royalty_micros = dwell_minutes * micros_per_dwell_minute),
  constraint ck_spatial_micro_royalty_session_leg
    check (session_royalty_micros = ride_sessions * micros_per_ride_session),
  constraint ck_spatial_micro_royalty_total
    check (total_royalty_micros = dwell_royalty_micros + session_royalty_micros),
  constraint ck_spatial_micro_royalty_cents
    check (royalty_cents = total_royalty_micros / 1000000)
);

comment on table public.spatial_micro_royalty_ledger is
  'The append-only dynamic micro-royalty of record (migration 0040) per source event: the dwell-minute and ride-session legs at the zone''s registered micro rates, the micro-dollar total, and the whole-cent floor that posts to the IP owner. UNIQUE (source_event_id) is the replay guard — a re-walked telemetry event throws, never a double micro-payout. Both legs and the micro→cent floor conversion are pinned in CHECKs.';

-- ---------------------------------------------------------------------------
-- Row Level Security — deny-all with the 0033 service-role grant set (the
-- 0017–0039 precedent): client roles read nothing; workers use the service
-- role.
-- ---------------------------------------------------------------------------

alter table public.spatial_occupancy_tier_schedules enable row level security;
alter table public.spatial_overhead_policies enable row level security;
alter table public.spatial_zone_assignments enable row level security;
alter table public.spatial_micro_policies enable row level security;
alter table public.spatial_throughput_years enable row level security;
alter table public.spatial_royalty_applications enable row level security;
alter table public.spatial_zone_allocations enable row level security;
alter table public.spatial_micro_royalty_ledger enable row level security;

drop policy if exists spatial_occupancy_tier_schedules_service_role_all
  on public.spatial_occupancy_tier_schedules;
create policy spatial_occupancy_tier_schedules_service_role_all
  on public.spatial_occupancy_tier_schedules
  for all
  using (false)
  with check (false);

drop policy if exists spatial_overhead_policies_service_role_all
  on public.spatial_overhead_policies;
create policy spatial_overhead_policies_service_role_all
  on public.spatial_overhead_policies
  for all
  using (false)
  with check (false);

drop policy if exists spatial_zone_assignments_service_role_all
  on public.spatial_zone_assignments;
create policy spatial_zone_assignments_service_role_all
  on public.spatial_zone_assignments
  for all
  using (false)
  with check (false);

drop policy if exists spatial_micro_policies_service_role_all
  on public.spatial_micro_policies;
create policy spatial_micro_policies_service_role_all
  on public.spatial_micro_policies
  for all
  using (false)
  with check (false);

drop policy if exists spatial_throughput_years_service_role_all
  on public.spatial_throughput_years;
create policy spatial_throughput_years_service_role_all
  on public.spatial_throughput_years
  for all
  using (false)
  with check (false);

drop policy if exists spatial_royalty_applications_service_role_all
  on public.spatial_royalty_applications;
create policy spatial_royalty_applications_service_role_all
  on public.spatial_royalty_applications
  for all
  using (false)
  with check (false);

drop policy if exists spatial_zone_allocations_service_role_all
  on public.spatial_zone_allocations;
create policy spatial_zone_allocations_service_role_all
  on public.spatial_zone_allocations
  for all
  using (false)
  with check (false);

drop policy if exists spatial_micro_royalty_ledger_service_role_all
  on public.spatial_micro_royalty_ledger;
create policy spatial_micro_royalty_ledger_service_role_all
  on public.spatial_micro_royalty_ledger
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.spatial_occupancy_tier_schedules to service_role;
grant select, insert, update, delete on public.spatial_overhead_policies to service_role;
grant select, insert, update, delete on public.spatial_zone_assignments to service_role;
grant select, insert, update, delete on public.spatial_micro_policies to service_role;
grant select, insert, update, delete on public.spatial_throughput_years to service_role;
grant select, insert, update, delete on public.spatial_royalty_applications to service_role;
grant select, insert, update, delete on public.spatial_zone_allocations to service_role;
grant select, insert, update, delete on public.spatial_micro_royalty_ledger to service_role;
