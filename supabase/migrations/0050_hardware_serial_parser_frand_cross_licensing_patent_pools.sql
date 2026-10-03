-- =============================================================================
-- 0050 — The hardware patent lane: cellular device activation / MAC log /
--        production-serial / smart-grid telemetry reconciliation to net patent
--        royalties (PR 46, the founder hardware directive)
--
-- Fifteen tables:
--
--   hardware_patent_pools             <- upsertHardwarePatentPool /
--                                        getHardwarePatentPool
--     (the patent pool of record — the MPEG-LA / Avanci shape. UNIQUE per
--      pool_code: an upsert converges.)
--
--   hardware_pool_holder_legs         <- upsertHardwarePoolHolderLeg /
--                                        listHardwarePoolHolderLegs
--     (the verified essentiality holder weightings per pool — the
--      waterfall's weights of record. UNIQUE per (pool_code,
--      holder_payee_id): a re-verification converges.)
--
--   hardware_sep_royalty_policies     <- upsertHardwareSepRoyaltyPolicy /
--                                        getHardwareSepRoyaltyPolicy
--     (the tiered FRAND SEP royalty policy of record per (patent_family_id,
--      sep_pool_code): each band a FRAND rate bps + per-unit cap. UNIQUE
--      per (patent_family_id, sep_pool_code): an upsert converges.)
--
--   hardware_automotive_pool_assignments
--                                     <- upsertHardwareAutomotivePoolAssignment /
--                                        getHardwareAutomotivePoolAssignment
--     (the automotive OEM pool routing of record per (oem_id, line_id):
--      per-vehicle cellular and navigation licensing fees route to their
--      pools. UNIQUE per (oem_id, line_id): an upsert converges.)
--
--   hardware_cleantech_royalty_policies
--                                     <- upsertHardwareCleanTechRoyaltyPolicy /
--                                        getHardwareCleanTechRoyaltyPolicy
--     (the clean-tech telemetry policy of record per patent_family_id:
--      micros per delivered kilowatt-hour and per completed charge cycle.
--      UNIQUE per patent_family_id: an upsert converges.)
--
--   hardware_ota_unlock_policies      <- upsertHardwareOtaUnlockPolicy /
--                                        getHardwareOtaUnlockPolicy
--     (the OTA unlock split policy of record per feature_code: micros per
--      unlock and the sensor licensor's share bps. UNIQUE per feature_code:
--      an upsert converges.)
--
--   hardware_cross_license_agreements <- upsertHardwareCrossLicenseAgreement /
--                                        getHardwareCrossLicenseAgreement
--     (the cross-licensing agreement of record per canonical company pair.
--      UNIQUE per (company_a_id, company_b_id) with the pair stored
--      canonically — the CHECK pins a < b so the netting walk reads one
--      direction of identity.)
--
--   hardware_sep_unit_months          <- advanceHardwareSepUnitMonth /
--                                        getHardwareSepUnitMonth
--     (the cumulative monthly unit tracker of record per (licensee_id,
--      patent_family_id, sep_pool_code, month) — the FRAND tier bands'
--      cumulative position. UNIQUE per that four-key: the tracker
--      converges.)
--
--   hardware_realization_applications <- insertHardwareRealizationApplication /
--                                        getHardwareRealizationApplication
--     (the append-only Net Hardware Patent Realization application of
--      record, keyed on the founder-specified patent_family_id,
--      sep_pool_code, and device_imei_mac columns. The realization math —
--      device wholesale ASP minus component COGS base minus non-essential
--      bill of materials = the Net Patentable Device Value Base — is pinned
--      in a CHECK, and the held verdict records the negative net. UNIQUE
--      per source_event_id is the replay guard.)
--
--   hardware_sep_royalty_applications <- insertHardwareSepRoyaltyApplication /
--                                        getHardwareSepRoyaltyApplication
--     (the append-only tiered SEP micro-royalty application of record, with
--      the cumulative units before/after pinned. UNIQUE per source_event_id
--      is the replay guard. The cross-license netting walk sums these rows
--      per (licensee_id, payee_id, period) for the mutual liabilities.)
--
--   hardware_pool_routing_applications
--                                     <- insertHardwarePoolRoutingApplication /
--                                        getHardwarePoolRoutingApplication
--     (the append-only automotive OEM pool routing application of record —
--      serials × per-vehicle fees, integer-exact, pinned in CHECKs. UNIQUE
--      per source_event_id is the replay guard.)
--
--   hardware_pool_waterfall_applications
--                                     <- insertHardwarePoolWaterfallApplication /
--                                        getHardwarePoolWaterfallApplication
--     (the append-only essentiality-weighted pool waterfall application of
--      record — the incoming pool fee pot conserved exactly across the
--      holder legs, pinned in a CHECK. UNIQUE per (routing_source_event_id,
--      pool_code) is the replay guard.)
--
--   hardware_telemetry_royalty_applications
--                                     <- insertHardwareTelemetryRoyaltyApplication /
--                                        getHardwareTelemetryRoyaltyApplication
--     (the append-only clean-tech telemetry micro-payout of record —
--      per-kilowatt-hour and per-charge-cycle micros, exact, floored into
--      payable cents, pinned in CHECKs. UNIQUE per source_event_id is the
--      replay guard.)
--
--   hardware_ota_unlock_applications  <- insertHardwareOtaUnlockApplication /
--                                        getHardwareOtaUnlockApplication
--     (the append-only OTA feature unlock split of record — the licensor's
--      bps share of the per-unlock pot, licensor + platform = the pot,
--      pinned in CHECKs. UNIQUE per source_event_id is the replay guard.)
--
--   hardware_cross_license_net_settlements
--                                     <- insertHardwareCrossLicenseNetSettlement /
--                                        getHardwareCrossLicenseNetSettlement
--     (the cross-licensing net offset of record per agreement
--      per period — the mutual liabilities net and the direction naming
--      the dispatch, pinned in CHECKs. UNIQUE per (agreement_ref, period):
--      one net clearing of record per agreement per period; the walk's
--      recompute replaces the sums in place.)
--
-- The 0032 lesson, applied: every CHECK is an explicitly named TABLE-level
-- constraint (ck_*) — column-level checks collide with table-level ones of
-- the same shape. No foreign keys by design — the tables key on the
-- senders' payee/company/OEM identifiers, content-derived event ids, pool
-- codes, and policy refs (the 0036–0049 discipline; no fk_* constraints
-- exist to name).
--
-- The PR 129 lesson, applied: the realization-verdict and net-direction
-- vocabularies in these CHECKs are byte-identical to the TS-side arrays
-- (REALIZATION_VERDICTS and CROSS_LICENSE_NET_DIRECTIONS in
-- modules/hardware/records.ts) — verified before CI.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- hardware_patent_pools: the patent pool of record — the MPEG-LA / Avanci
-- shape.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_patent_pools (
  id                uuid primary key default gen_random_uuid(),
  pool_code         text not null,
  pool_name         text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (pool_code),
  constraint ck_hardware_patent_pools_code_present
    check (char_length(pool_code) > 0),
  constraint ck_hardware_patent_pools_name_present
    check (char_length(pool_name) > 0)
);

comment on table public.hardware_patent_pools is
  'The patent pool of record (migration 0050) — the MPEG-LA / Avanci shape. UNIQUE (pool_code): an upsert converges. The pool''s holder weightings live in hardware_pool_holder_legs.';

-- ---------------------------------------------------------------------------
-- hardware_pool_holder_legs: the verified essentiality holder weightings —
-- the waterfall's weights of record.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_pool_holder_legs (
  id                    uuid primary key default gen_random_uuid(),
  pool_code             text not null,
  holder_payee_id       text not null,
  essentiality_score    bigint not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (pool_code, holder_payee_id),
  constraint ck_hardware_pool_holder_legs_holder_present
    check (char_length(holder_payee_id) > 0),
  constraint ck_hardware_pool_holder_legs_score_range
    check (essentiality_score >= 1 AND essentiality_score <= 100)
);

comment on table public.hardware_pool_holder_legs is
  'The verified essentiality holder weightings per patent pool (migration 0050) — the waterfall''s weights of record. UNIQUE (pool_code, holder_payee_id): a re-verification converges. Essentiality score 1–100 (verified).';

create index if not exists idx_hardware_pool_holder_legs_pool
  on public.hardware_pool_holder_legs (pool_code);

-- ---------------------------------------------------------------------------
-- hardware_sep_royalty_policies: the tiered FRAND SEP royalty policy of
-- record — each band a FRAND rate bps + per-unit cap.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_sep_royalty_policies (
  id                    uuid primary key default gen_random_uuid(),
  patent_family_id      text not null,
  sep_pool_code         text not null,
  payee_id              text not null,
  tier_bands            text not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (patent_family_id, sep_pool_code),
  constraint ck_hardware_sep_royalty_policies_family_present
    check (char_length(patent_family_id) > 0),
  constraint ck_hardware_sep_royalty_policies_pool_present
    check (char_length(sep_pool_code) > 0),
  constraint ck_hardware_sep_royalty_policies_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_hardware_sep_royalty_policies_bands_present
    check (char_length(tier_bands) > 0)
);

comment on table public.hardware_sep_royalty_policies is
  'The tiered FRAND SEP royalty policy of record per (patent_family_id, sep_pool_code) (migration 0050): each band a FRAND rate bps + per-unit cap, e.g. 2.5% capped at $3 per connected vehicle module. tier_bands is the JSON bands of record. UNIQUE (patent_family_id, sep_pool_code): an upsert converges.';

-- ---------------------------------------------------------------------------
-- hardware_automotive_pool_assignments: the automotive OEM pool routing of
-- record — per-vehicle cellular and navigation licensing fees route to
-- their pools.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_automotive_pool_assignments (
  id                     uuid primary key default gen_random_uuid(),
  oem_id                 text not null,
  line_id                text not null,
  cellular_pool_code     text not null,
  navigation_pool_code   text not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (oem_id, line_id),
  constraint ck_hardware_automotive_pool_assignments_cellular_pool_present
    check (char_length(cellular_pool_code) > 0),
  constraint ck_hardware_automotive_pool_assignments_navigation_pool_present
    check (char_length(navigation_pool_code) > 0)
);

comment on table public.hardware_automotive_pool_assignments is
  'The automotive OEM pool routing of record per (oem_id, line_id) (migration 0050): per-vehicle cellular and navigation licensing fees route directly from OEM production lines to multi-patent pools. UNIQUE (oem_id, line_id): an upsert converges.';

-- ---------------------------------------------------------------------------
-- hardware_cleantech_royalty_policies: the clean-tech telemetry policy of
-- record — micros per delivered kilowatt-hour and per completed cycle.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_cleantech_royalty_policies (
  id                      uuid primary key default gen_random_uuid(),
  patent_family_id        text not null,
  payee_id                text not null,
  micros_per_kwh          bigint not null,
  micros_per_charge_cycle bigint not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (patent_family_id),
  constraint ck_hardware_cleantech_royalty_policies_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_hardware_cleantech_royalty_policies_kwh_rate_non_negative
    check (micros_per_kwh >= 0),
  constraint ck_hardware_cleantech_royalty_policies_cycle_rate_non_negative
    check (micros_per_charge_cycle >= 0)
);

comment on table public.hardware_cleantech_royalty_policies is
  'The clean-tech telemetry royalty policy of record per patent_family_id (migration 0050): micros per delivered kilowatt-hour and per completed charge cycle route to clean-tech patent holders from IoT telemetry feeds. UNIQUE (patent_family_id): an upsert converges.';

-- ---------------------------------------------------------------------------
-- hardware_ota_unlock_policies: the OTA unlock split policy of record —
-- micros per unlock and the sensor licensor's share bps.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_ota_unlock_policies (
  id                       uuid primary key default gen_random_uuid(),
  feature_code             text not null,
  sensor_licensor_payee_id text not null,
  micros_per_unlock        bigint not null,
  licensor_share_bps       bigint not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (feature_code),
  constraint ck_hardware_ota_unlock_policies_licensor_present
    check (char_length(sensor_licensor_payee_id) > 0),
  constraint ck_hardware_ota_unlock_policies_price_positive
    check (micros_per_unlock > 0),
  constraint ck_hardware_ota_unlock_policies_share_bps_range
    check (licensor_share_bps >= 0 AND licensor_share_bps <= 10000)
);

comment on table public.hardware_ota_unlock_policies is
  'The OTA feature unlock split policy of record per feature_code (migration 0050): micros per unlock event and the sensor licensor''s share bps — e.g. unlocking self-driving sensors or adaptive suspension patents. The residual share posts to the platform. UNIQUE (feature_code): an upsert converges.';

-- ---------------------------------------------------------------------------
-- hardware_cross_license_agreements: the cross-licensing agreement of
-- record — the pair stored canonically.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_cross_license_agreements (
  id             uuid primary key default gen_random_uuid(),
  agreement_ref  text not null,
  company_a_id   text not null,
  company_b_id   text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (agreement_ref),
  unique (company_a_id, company_b_id),
  constraint ck_hardware_cross_license_agreements_companies_present
    check (char_length(company_a_id) > 0 AND char_length(company_b_id) > 0),
  constraint ck_hardware_cross_license_agreements_pair_canonical
    check (company_a_id < company_b_id)
);

comment on table public.hardware_cross_license_agreements is
  'The cross-licensing agreement of record per canonical company pair (migration 0050). UNIQUE (agreement_ref) and UNIQUE (company_a_id, company_b_id) with the pair stored canonically — the CHECK pins a < b so the netting walk reads one direction of identity.';

-- ---------------------------------------------------------------------------
-- hardware_sep_unit_months: the cumulative monthly unit tracker of record —
-- the FRAND tier bands' cumulative position.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_sep_unit_months (
  id                uuid primary key default gen_random_uuid(),
  licensee_id       text not null,
  patent_family_id  text not null,
  sep_pool_code     text not null,
  month             text not null,
  cumulative_units  bigint not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (licensee_id, patent_family_id, sep_pool_code, month),
  constraint ck_hardware_sep_unit_months_month_shape
    check (month ~ '^\d{4}-\d{2}$'),
  constraint ck_hardware_sep_unit_months_units_positive
    check (cumulative_units > 0)
);

comment on table public.hardware_sep_unit_months is
  'The cumulative monthly unit tracker of record per (licensee_id, patent_family_id, sep_pool_code, month) (migration 0050) — the FRAND tier bands'' cumulative position. UNIQUE per the four-key: the tracker converges.';

-- ---------------------------------------------------------------------------
-- hardware_realization_applications: the append-only Net Hardware Patent
-- Realization application of record — the founder-specified keys and the
-- exact money math.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_realization_applications (
  id                                        uuid primary key default gen_random_uuid(),
  source_event_id                           text not null,
  patent_family_id                          text not null,
  sep_pool_code                             text not null,
  device_imei_mac                           text not null,
  eid                                       text,
  period                                    text not null,
  currency                                  text not null,
  device_wholesale_asp_cents                bigint not null,
  component_cogs_base_cents                 bigint not null,
  non_essential_bom_cents                   bigint not null,
  net_patentable_device_value_base_cents    bigint not null,
  verdict                                   text not null,
  created_at                                timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_hardware_realization_applications_family_present
    check (char_length(patent_family_id) > 0),
  constraint ck_hardware_realization_applications_pool_present
    check (char_length(sep_pool_code) > 0),
  constraint ck_hardware_realization_applications_imei_mac_present
    check (char_length(device_imei_mac) > 0),
  constraint ck_hardware_realization_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_hardware_realization_applications_asp_non_negative
    check (device_wholesale_asp_cents >= 0),
  constraint ck_hardware_realization_applications_cogs_non_negative
    check (component_cogs_base_cents >= 0),
  constraint ck_hardware_realization_applications_bom_non_negative
    check (non_essential_bom_cents >= 0),
  constraint ck_hardware_realization_applications_realization_math
    check (net_patentable_device_value_base_cents
      = device_wholesale_asp_cents - component_cogs_base_cents - non_essential_bom_cents),
  constraint ck_hardware_realization_applications_verdict_vocabulary
    check (verdict IN ('paid', 'held_negative_net')),
  constraint ck_hardware_realization_applications_verdict_consistent
    check (
      (net_patentable_device_value_base_cents < 0 AND verdict = 'held_negative_net')
      OR (net_patentable_device_value_base_cents >= 0 AND verdict = 'paid')
    )
);

comment on table public.hardware_realization_applications is
  'The append-only Net Hardware Patent Realization application of record (migration 0050), keyed on the founder-specified patent_family_id, sep_pool_code, and device_imei_mac columns. The realization math — device wholesale ASP minus component COGS base minus non-essential BOM = the Net Patentable Device Value Base — is pinned in a CHECK, and the held verdict records the negative net. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- hardware_sep_royalty_applications: the append-only tiered SEP micro-royalty
-- application of record — cumulative units pinned, the netting walk's rows.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_sep_royalty_applications (
  id                        uuid primary key default gen_random_uuid(),
  source_event_id           text not null,
  licensee_id               text not null,
  patent_family_id          text not null,
  sep_pool_code             text not null,
  period                    text not null,
  currency                  text not null,
  policy_ref                text not null,
  payee_id                  text not null,
  device_mac                text not null,
  connected_units           bigint not null,
  royalty_basis_cents       bigint not null,
  tier_legs                 text not null,
  royalty_cents             bigint not null,
  cumulative_units_before   bigint not null,
  cumulative_units_after    bigint not null,
  created_at                timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_hardware_sep_royalty_applications_licensee_present
    check (char_length(licensee_id) > 0),
  constraint ck_hardware_sep_royalty_applications_family_present
    check (char_length(patent_family_id) > 0),
  constraint ck_hardware_sep_royalty_applications_pool_present
    check (char_length(sep_pool_code) > 0),
  constraint ck_hardware_sep_royalty_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_hardware_sep_royalty_applications_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_hardware_sep_royalty_applications_mac_present
    check (char_length(device_mac) > 0),
  constraint ck_hardware_sep_royalty_applications_units_positive
    check (connected_units > 0),
  constraint ck_hardware_sep_royalty_applications_basis_non_negative
    check (royalty_basis_cents >= 0),
  constraint ck_hardware_sep_royalty_applications_royalty_non_negative
    check (royalty_cents >= 0),
  constraint ck_hardware_sep_royalty_applications_position_before_non_negative
    check (cumulative_units_before >= 0),
  constraint ck_hardware_sep_royalty_applications_position_after_positive
    check (cumulative_units_after > 0),
  constraint ck_hardware_sep_royalty_applications_position_math
    check (cumulative_units_after = cumulative_units_before + connected_units)
);

comment on table public.hardware_sep_royalty_applications is
  'The append-only tiered SEP micro-royalty application of record (migration 0050) — per-unit caps and percentage splits with cumulative unit tracking, the cumulative position pinned in a CHECK. UNIQUE (source_event_id) is the replay guard. The cross-license netting walk sums these rows per (licensee_id, payee_id, period) for the mutual liabilities.';

create index if not exists idx_hardware_sep_royalty_applications_netting
  on public.hardware_sep_royalty_applications (licensee_id, payee_id, period);

-- ---------------------------------------------------------------------------
-- hardware_pool_routing_applications: the append-only automotive OEM pool
-- routing application of record — serials × per-vehicle fees, integer-exact.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_pool_routing_applications (
  id                               uuid primary key default gen_random_uuid(),
  source_event_id                  text not null,
  oem_id                           text not null,
  line_id                          text not null,
  period                           text not null,
  currency                         text not null,
  assignment_ref                   text not null,
  serials_produced                 bigint not null,
  cellular_pool_code               text not null,
  navigation_pool_code             text not null,
  cellular_fee_per_vehicle_cents   bigint not null,
  navigation_fee_per_vehicle_cents bigint not null,
  cellular_routed_cents            bigint not null,
  navigation_routed_cents          bigint not null,
  total_routed_cents               bigint not null,
  created_at                       timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_hardware_pool_routing_applications_oem_present
    check (char_length(oem_id) > 0),
  constraint ck_hardware_pool_routing_applications_line_present
    check (char_length(line_id) > 0),
  constraint ck_hardware_pool_routing_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_hardware_pool_routing_applications_serials_positive
    check (serials_produced > 0),
  constraint ck_hardware_pool_routing_applications_cellular_pool_present
    check (char_length(cellular_pool_code) > 0),
  constraint ck_hardware_pool_routing_applications_navigation_pool_present
    check (char_length(navigation_pool_code) > 0),
  constraint ck_hardware_pool_routing_applications_cellular_fee_non_negative
    check (cellular_fee_per_vehicle_cents >= 0),
  constraint ck_hardware_pool_routing_applications_navigation_fee_non_negative
    check (navigation_fee_per_vehicle_cents >= 0),
  constraint ck_hardware_pool_routing_applications_cellular_routed_non_negative
    check (cellular_routed_cents >= 0),
  constraint ck_hardware_pool_routing_applications_navigation_routed_non_negative
    check (navigation_routed_cents >= 0),
  constraint ck_hardware_pool_routing_applications_cellular_routed_math
    check (cellular_routed_cents = serials_produced * cellular_fee_per_vehicle_cents),
  constraint ck_hardware_pool_routing_applications_navigation_routed_math
    check (navigation_routed_cents = serials_produced * navigation_fee_per_vehicle_cents),
  constraint ck_hardware_pool_routing_applications_total_routed_math
    check (total_routed_cents = cellular_routed_cents + navigation_routed_cents)
);

comment on table public.hardware_pool_routing_applications is
  'The append-only automotive OEM pool routing application of record (migration 0050) — per-vehicle cellular and navigation licensing fees × serials produced, integer-exact, pinned in CHECKs; the routed legs sum to the total. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- hardware_pool_waterfall_applications: the append-only essentiality-weighted
-- pool waterfall application of record — the pot conserved exactly.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_pool_waterfall_applications (
  id                        uuid primary key default gen_random_uuid(),
  routing_source_event_id   text not null,
  pool_code                 text not null,
  period                    text not null,
  currency                  text not null,
  split_legs                text not null,
  pool_fee_pot_cents        bigint not null,
  allocated_total_cents     bigint not null,
  created_at                timestamptz not null default now(),
  unique (routing_source_event_id, pool_code),
  constraint ck_hardware_pool_waterfall_applications_pool_present
    check (char_length(pool_code) > 0),
  constraint ck_hardware_pool_waterfall_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_hardware_pool_waterfall_applications_legs_present
    check (char_length(split_legs) > 0),
  constraint ck_hardware_pool_waterfall_applications_pot_positive
    check (pool_fee_pot_cents > 0),
  constraint ck_hardware_pool_waterfall_applications_allocated_positive
    check (allocated_total_cents > 0),
  constraint ck_hardware_pool_waterfall_applications_conservation
    check (allocated_total_cents = pool_fee_pot_cents)
);

comment on table public.hardware_pool_waterfall_applications is
  'The append-only essentiality-weighted pool waterfall application of record (migration 0050) — incoming per-unit license fees distribute across the pool''s verified holder legs by essentiality score weighting (the MPEG-LA / Avanci shape); the pot conserves exactly (the dust rides the highest-scored holders), pinned in a CHECK. UNIQUE (routing_source_event_id, pool_code) is the replay guard.';

-- ---------------------------------------------------------------------------
-- hardware_telemetry_royalty_applications: the append-only clean-tech
-- telemetry micro-payout of record — per-kilowatt-hour and per-cycle micros.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_telemetry_royalty_applications (
  id                       uuid primary key default gen_random_uuid(),
  source_event_id          text not null,
  patent_family_id         text not null,
  period                   text not null,
  currency                 text not null,
  policy_ref               text not null,
  payee_id                 text not null,
  device_serial            text not null,
  kwh_micros               bigint not null,
  charge_cycles            bigint not null,
  micros_per_kwh           bigint not null,
  micros_per_charge_cycle  bigint not null,
  royalty_micros           bigint not null,
  royalty_cents            bigint not null,
  created_at               timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_hardware_telemetry_royalty_applications_family_present
    check (char_length(patent_family_id) > 0),
  constraint ck_hardware_telemetry_royalty_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_hardware_telemetry_royalty_applications_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_hardware_telemetry_royalty_applications_serial_present
    check (char_length(device_serial) > 0),
  constraint ck_hardware_telemetry_royalty_applications_kwh_non_negative
    check (kwh_micros >= 0),
  constraint ck_hardware_telemetry_royalty_applications_cycles_non_negative
    check (charge_cycles >= 0),
  constraint ck_hardware_telemetry_royalty_applications_rates_non_negative
    check (micros_per_kwh >= 0 AND micros_per_charge_cycle >= 0),
  -- The micros math: kwh_micros is the delivered energy at 1e8 statement
  -- micros per kWh, so the energy product divides back down by 1e8 (the
  -- rate is micro-dollars per kWh; without the division the product
  -- double-scales 1e8x — a $0.001/kWh micro-payout would price at
  -- $100,000/kWh). The cycle leg is a plain count x micro-dollars per
  -- cycle. Bigint division floors the energy leg (the house cent-exact
  -- canon, never rounds up).
  constraint ck_hardware_telemetry_royalty_applications_micros_math
    check (
      royalty_micros
        = (kwh_micros * micros_per_kwh) / 100000000
          + charge_cycles * micros_per_charge_cycle
    ),
  constraint ck_hardware_telemetry_royalty_applications_cents_floor
    check (royalty_cents = royalty_micros / 1000000),
  constraint ck_hardware_telemetry_royalty_applications_cents_non_negative
    check (royalty_cents >= 0)
);

comment on table public.hardware_telemetry_royalty_applications is
  'The append-only clean-tech telemetry micro-payout of record (migration 0050) — per-kilowatt-hour and per-charge-cycle micros from IoT telemetry feeds, exact, floored into payable cents (one cent = 1,000,000 statement micros), pinned in CHECKs. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- hardware_ota_unlock_applications: the append-only OTA feature unlock split
-- of record — the licensor's bps share, licensor + platform = the pot.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_ota_unlock_applications (
  id                        uuid primary key default gen_random_uuid(),
  source_event_id           text not null,
  feature_code              text not null,
  policy_ref                text not null,
  sensor_licensor_payee_id  text not null,
  device_imei_mac           text not null,
  period                    text not null,
  currency                  text not null,
  micros_per_unlock         bigint not null,
  licensor_share_bps        bigint not null,
  settlement_micros         bigint not null,
  settlement_cents          bigint not null,
  licensor_cents            bigint not null,
  platform_cents            bigint not null,
  created_at                timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_hardware_ota_unlock_applications_feature_present
    check (char_length(feature_code) > 0),
  constraint ck_hardware_ota_unlock_applications_licensor_present
    check (char_length(sensor_licensor_payee_id) > 0),
  constraint ck_hardware_ota_unlock_applications_imei_mac_present
    check (char_length(device_imei_mac) > 0),
  constraint ck_hardware_ota_unlock_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_hardware_ota_unlock_applications_price_positive
    check (micros_per_unlock > 0),
  constraint ck_hardware_ota_unlock_applications_share_bps_range
    check (licensor_share_bps >= 0 AND licensor_share_bps <= 10000),
  constraint ck_hardware_ota_unlock_applications_micros_positive
    check (settlement_micros > 0),
  constraint ck_hardware_ota_unlock_applications_cents_floor
    check (settlement_cents = settlement_micros / 1000000),
  constraint ck_hardware_ota_unlock_applications_licensor_math
    check (licensor_cents = (settlement_cents * licensor_share_bps) / 10000),
  constraint ck_hardware_ota_unlock_applications_split_conservation
    check (licensor_cents + platform_cents = settlement_cents)
);

comment on table public.hardware_ota_unlock_applications is
  'The append-only OTA feature unlock split of record (migration 0050) — a per-unlock royalty split posting instantly to sensor patent licensor ledgers; the pot floors micros/1,000,000, the licensor''s bps share, and licensor + platform = the pot ALWAYS, pinned in CHECKs. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- hardware_cross_license_net_settlements: the cross-licensing net
-- offset of record — the mutual liabilities net and the dispatch direction.
-- ---------------------------------------------------------------------------
create table if not exists public.hardware_cross_license_net_settlements (
  id                  uuid primary key default gen_random_uuid(),
  agreement_ref       text not null,
  company_a_id        text not null,
  company_b_id        text not null,
  period              text not null,
  currency            text not null,
  owed_a_to_b_cents   bigint not null,
  owed_b_to_a_cents   bigint not null,
  net_cents           bigint not null,
  direction           text not null,
  created_at          timestamptz not null default now(),
  unique (agreement_ref, period),
  constraint ck_hardware_cross_license_net_settlements_companies_present
    check (char_length(company_a_id) > 0 AND char_length(company_b_id) > 0),
  constraint ck_hardware_cross_license_net_settlements_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_hardware_cross_license_net_settlements_owed_non_negative
    check (owed_a_to_b_cents >= 0 AND owed_b_to_a_cents >= 0),
  constraint ck_hardware_cross_license_net_settlements_net_math
    check (net_cents = owed_a_to_b_cents - owed_b_to_a_cents),
  constraint ck_hardware_cross_license_net_settlements_direction_vocabulary
    check (direction IN ('a_to_b', 'b_to_a', 'balanced')),
  constraint ck_hardware_cross_license_net_settlements_direction_consistent
    check (
      (net_cents > 0 AND direction = 'a_to_b')
      OR (net_cents < 0 AND direction = 'b_to_a')
      OR (net_cents = 0 AND direction = 'balanced')
    )
);

comment on table public.hardware_cross_license_net_settlements is
  'The cross-licensing net offset of record per agreement per period (migration 0050) — the mutual patent liabilities net (e.g. Company A owes Company B $12M for 5G SEPs while Company B owes Company A $8M for Wi-Fi 7 SEPs, netting a $4M dispatch to Company B), the direction naming the dispatch, pinned in CHECKs. UNIQUE (agreement_ref, period): one net clearing of record per agreement per period; the walk''s recompute replaces the sums in place.';

-- The RLS deny-all posture — every hardware lane table is hardware-lane
-- only (the 0043–0049 discipline; the probes verify deny for
-- authenticated).

alter table public.hardware_patent_pools enable row level security;
drop policy if exists hardware_patent_pools_service_role_all
  on public.hardware_patent_pools;
create policy hardware_patent_pools_service_role_all
  on public.hardware_patent_pools
  for all
  using (false)
  with check (false);

alter table public.hardware_pool_holder_legs enable row level security;
drop policy if exists hardware_pool_holder_legs_service_role_all
  on public.hardware_pool_holder_legs;
create policy hardware_pool_holder_legs_service_role_all
  on public.hardware_pool_holder_legs
  for all
  using (false)
  with check (false);

alter table public.hardware_sep_royalty_policies enable row level security;
drop policy if exists hardware_sep_royalty_policies_service_role_all
  on public.hardware_sep_royalty_policies;
create policy hardware_sep_royalty_policies_service_role_all
  on public.hardware_sep_royalty_policies
  for all
  using (false)
  with check (false);

alter table public.hardware_automotive_pool_assignments enable row level security;
drop policy if exists hardware_automotive_pool_assignments_service_role_all
  on public.hardware_automotive_pool_assignments;
create policy hardware_automotive_pool_assignments_service_role_all
  on public.hardware_automotive_pool_assignments
  for all
  using (false)
  with check (false);

alter table public.hardware_cleantech_royalty_policies enable row level security;
drop policy if exists hardware_cleantech_royalty_policies_service_role_all
  on public.hardware_cleantech_royalty_policies;
create policy hardware_cleantech_royalty_policies_service_role_all
  on public.hardware_cleantech_royalty_policies
  for all
  using (false)
  with check (false);

alter table public.hardware_ota_unlock_policies enable row level security;
drop policy if exists hardware_ota_unlock_policies_service_role_all
  on public.hardware_ota_unlock_policies;
create policy hardware_ota_unlock_policies_service_role_all
  on public.hardware_ota_unlock_policies
  for all
  using (false)
  with check (false);

alter table public.hardware_cross_license_agreements enable row level security;
drop policy if exists hardware_cross_license_agreements_service_role_all
  on public.hardware_cross_license_agreements;
create policy hardware_cross_license_agreements_service_role_all
  on public.hardware_cross_license_agreements
  for all
  using (false)
  with check (false);

alter table public.hardware_sep_unit_months enable row level security;
drop policy if exists hardware_sep_unit_months_service_role_all
  on public.hardware_sep_unit_months;
create policy hardware_sep_unit_months_service_role_all
  on public.hardware_sep_unit_months
  for all
  using (false)
  with check (false);

alter table public.hardware_realization_applications enable row level security;
drop policy if exists hardware_realization_applications_service_role_all
  on public.hardware_realization_applications;
create policy hardware_realization_applications_service_role_all
  on public.hardware_realization_applications
  for all
  using (false)
  with check (false);

alter table public.hardware_sep_royalty_applications enable row level security;
drop policy if exists hardware_sep_royalty_applications_service_role_all
  on public.hardware_sep_royalty_applications;
create policy hardware_sep_royalty_applications_service_role_all
  on public.hardware_sep_royalty_applications
  for all
  using (false)
  with check (false);

alter table public.hardware_pool_routing_applications enable row level security;
drop policy if exists hardware_pool_routing_applications_service_role_all
  on public.hardware_pool_routing_applications;
create policy hardware_pool_routing_applications_service_role_all
  on public.hardware_pool_routing_applications
  for all
  using (false)
  with check (false);

alter table public.hardware_pool_waterfall_applications enable row level security;
drop policy if exists hardware_pool_waterfall_applications_service_role_all
  on public.hardware_pool_waterfall_applications;
create policy hardware_pool_waterfall_applications_service_role_all
  on public.hardware_pool_waterfall_applications
  for all
  using (false)
  with check (false);

alter table public.hardware_telemetry_royalty_applications enable row level security;
drop policy if exists hardware_telemetry_royalty_applications_service_role_all
  on public.hardware_telemetry_royalty_applications;
create policy hardware_telemetry_royalty_applications_service_role_all
  on public.hardware_telemetry_royalty_applications
  for all
  using (false)
  with check (false);

alter table public.hardware_ota_unlock_applications enable row level security;
drop policy if exists hardware_ota_unlock_applications_service_role_all
  on public.hardware_ota_unlock_applications;
create policy hardware_ota_unlock_applications_service_role_all
  on public.hardware_ota_unlock_applications
  for all
  using (false)
  with check (false);

alter table public.hardware_cross_license_net_settlements enable row level security;
drop policy if exists hardware_cross_license_net_settlements_service_role_all
  on public.hardware_cross_license_net_settlements;
create policy hardware_cross_license_net_settlements_service_role_all
  on public.hardware_cross_license_net_settlements
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.hardware_patent_pools to service_role;
grant select, insert, update, delete on public.hardware_pool_holder_legs to service_role;
grant select, insert, update, delete on public.hardware_sep_royalty_policies to service_role;
grant select, insert, update, delete on public.hardware_automotive_pool_assignments to service_role;
grant select, insert, update, delete on public.hardware_cleantech_royalty_policies to service_role;
grant select, insert, update, delete on public.hardware_ota_unlock_policies to service_role;
grant select, insert, update, delete on public.hardware_cross_license_agreements to service_role;
grant select, insert, update, delete on public.hardware_sep_unit_months to service_role;
grant select, insert, update, delete on public.hardware_realization_applications to service_role;
grant select, insert, update, delete on public.hardware_sep_royalty_applications to service_role;
grant select, insert, update, delete on public.hardware_pool_routing_applications to service_role;
grant select, insert, update, delete on public.hardware_pool_waterfall_applications to service_role;
grant select, insert, update, delete on public.hardware_telemetry_royalty_applications to service_role;
grant select, insert, update, delete on public.hardware_ota_unlock_applications to service_role;
grant select, insert, update, delete on public.hardware_cross_license_net_settlements to service_role;
