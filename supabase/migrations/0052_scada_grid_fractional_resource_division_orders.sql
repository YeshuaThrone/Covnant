-- =============================================================================
-- 0052 — The energy lane: SCADA/grid fractional resource realization,
--        tiered fractional royalties, multi-owner acreage division,
--        telemetry-weighted compute-grid splits, division orders with deed
--        transfers and statutory interest, and per-tonne carbon offset
--        micro-royalties (PR 48, the founder resource directive)
--
-- Eighteen tables:
--
--   energy_land_parcels                <- upsertEnergyLandParcel /
--                                         getEnergyLandParcel
--     (the surveyed land parcels of record per the founder-specified
--      parcel_id. UNIQUE per parcel_id: an upsert converges.)
--
--   energy_parcel_owner_interests      <- upsertEnergyParcelOwnerInterest /
--                                         listEnergyParcelOwnerInterests
--     (the deeded fractional acreage interests per (parcel_id,
--      owner_payee_id) — the division's ratio basis. UNIQUE per that
--      pair: an upsert converges.)
--
--   energy_parcel_royalty_policies     <- upsertEnergyParcelRoyaltyPolicy /
--                                         getEnergyParcelRoyaltyPolicy
--     (the tiered royalty ladder of record per parcel_id — the ORRI
--      bands the walk prices from. UNIQUE per parcel_id.)
--
--   energy_parcel_royalty_positions    <- advanceEnergyParcelRoyaltyPosition /
--                                         getEnergyParcelRoyaltyPosition
--     (the cumulative royalty position per (parcel_id, period, currency)
--      — the tier walk's cumulative input. UNIQUE per that triple.)
--
--   energy_compute_yield_policies      <- upsertEnergyComputeYieldPolicy /
--                                         getEnergyComputeYieldPolicy
--     (the GPU cluster yield split policy of record per the
--      founder-specified gpu_cluster_hash. UNIQUE per hash.)
--
--   energy_compute_yield_positions     <- advanceEnergyComputeYieldPosition /
--                                         getEnergyComputeYieldPosition
--     (the cumulative yield position per (gpu_cluster_hash, period,
--      currency). UNIQUE per that triple.)
--
--   energy_grid_participant_registrations
--                                      <- upsertEnergyGridParticipant /
--                                         listEnergyGridParticipants
--     (the split participants per (gpu_cluster_hash, participant_payee_id)
--      — GPU hardware owners, power plant operators, colocation facility
--      managers — with their telemetry weights. UNIQUE per that pair.)
--
--   energy_division_orders             <- upsertEnergyDivisionOrder /
--                                         getEnergyDivisionOrder
--     (the parsed title division orders of record per order_ref. UNIQUE
--      per order_ref.)
--
--   energy_deed_transfers              <- upsertEnergyDeedTransfer /
--                                         getEnergyDeedTransfer
--     (the recorded deed transfers per deed_ref — the reroute triggers
--      with the statutory interest rate of record AT the transfer.
--      UNIQUE per deed_ref.)
--
--   energy_carbon_offset_policies      <- upsertEnergyCarbonOffsetPolicy /
--                                         getEnergyCarbonOffsetPolicy
--     (the per-tonne payout policy of record per parcel_id — the
--      conservation trust and project developer routes. UNIQUE per
--      parcel_id.)
--
--   energy_meter_sales_posts           <- insertEnergyMeterSalesPost /
--                                         getEnergyMeterSalesPost
--   energy_pipeline_deduction_posts    <- insertEnergyPipelineDeductionPost /
--                                         getEnergyPipelineDeductionPost
--   energy_gpu_utilization_posts       <- insertEnergyGpuUtilizationPost /
--                                         getEnergyGpuUtilizationPost
--     (the append-only per-row post truth from the three ingestion
--      profiles — the replay guards AND the realization recompute's
--      aggregation inputs. UNIQUE per source_event_id.)
--
--   energy_net_realization_applications
--                                      <- upsertEnergyNetRealizationApplication /
--                                         getEnergyNetRealizationApplication
--     (THE NET REALIZED RESOURCE POOL of record per the founder's
--      five-tuple (parcel_id, well_meter_id, gpu_cluster_hash, period,
--      currency): gross energy + mineral sales minus transportation and
--      pipeline deductions minus grid transmission fees minus processing
--      and refining base fees. Recomputed in place from the post sums —
--      the id and created_at survive (the PR 33 id-rotation lesson). The
--      verdict holds the money visible when deductions exceed gross:
--      'held_negative_net' — never dropped, never guessed into a route.
--      UNIQUE per the five-tuple.)
--
--   energy_parcel_division_applications
--                                      <- insertEnergyParcelDivisionApplication /
--                                         getEnergyParcelDivisionApplication
--   energy_compute_grid_split_applications
--                                      <- insertEnergyComputeGridSplitApplication /
--                                         getEnergyComputeGridSplitApplication
--   energy_statutory_interest_applications
--                                      <- insertEnergyStatutoryInterestApplication /
--                                         getEnergyStatutoryInterestApplication
--   energy_carbon_offset_payout_applications
--                                      <- insertEnergyCarbonOffsetPayoutApplication /
--                                         getEnergyCarbonOffsetPayoutApplication
--     (the append-only money applications of record. UNIQUE per
--      source_event_id: the replay guard. The conservation CHECKs pin
--      the full allocation: the division and the split each allocate the
--      whole pot; the payout's trust + developer legs sum to the total.)
--
-- CONSTRAINT NAMING (the 0032 production lesson): every CHECK is a
-- TABLE-LEVEL constraint with an explicit ck_<table>_<what> name — column-
-- level CHECKs collide with table-level names on regeneration. No foreign
-- keys: the tables key on parcel ids, meter ids, cluster hashes, and text
-- payee ids — the energy lane's own identifier space (the 0037–0051
-- discipline).
--
-- VOCABULARY (the PR 129/130 lesson — byte-identity with the TS unions
-- BEFORE CI): the SQL CHECK token lists below are byte-identical to
--   ENERGY_APPLICATION_VERDICTS        (src/modules/energy/records.ts)
--   ENERGY_INTEREST_CLASSES            (src/modules/energy/records.ts)
--   ENERGY_GRID_PARTICIPANT_CLASSES    (src/modules/energy/records.ts)
-- and the parity floors match the CHECK floors exactly. Verified
-- byte-identical before CI dispatch (the PR 133/134/137 discipline).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- energy_land_parcels: the surveyed land parcels of record.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_land_parcels (
  id            uuid primary key default gen_random_uuid(),
  parcel_id     text not null,
  parcel_name   text not null,
  region        text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (parcel_id),
  constraint ck_energy_land_parcels_parcel_present
    check (char_length(parcel_id) > 0),
  constraint ck_energy_land_parcels_name_present
    check (char_length(parcel_name) > 0),
  constraint ck_energy_land_parcels_region_present
    check (char_length(region) > 0)
);

comment on table public.energy_land_parcels is
  'The surveyed land parcels of record per parcel_id (migration 0052) — the founder-specified parcel identity the Net Resource Realization keys on. UNIQUE (parcel_id): an upsert converges.';

-- ---------------------------------------------------------------------------
-- energy_parcel_owner_interests: the deeded fractional acreage interests —
-- the division's ratio basis.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_parcel_owner_interests (
  id                   uuid primary key default gen_random_uuid(),
  parcel_id            text not null,
  owner_payee_id       text not null,
  owner_name           text not null,
  deeded_acres_micros  bigint not null,
  interest_class       text not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (parcel_id, owner_payee_id),
  constraint ck_energy_parcel_owner_interests_parcel_present
    check (char_length(parcel_id) > 0),
  constraint ck_energy_parcel_owner_interests_owner_present
    check (char_length(owner_payee_id) > 0),
  constraint ck_energy_parcel_owner_interests_name_present
    check (char_length(owner_name) > 0),
  constraint ck_energy_parcel_owner_interests_acres_positive
    check (deeded_acres_micros > 0),
  constraint ck_energy_parcel_owner_interests_interest_class_vocabulary
    check (interest_class IN ('mineral', 'surface', 'wind', 'mixed'))
);

comment on table public.energy_parcel_owner_interests is
  'The deeded fractional acreage interests of record per (parcel_id, owner_payee_id) (migration 0052) — the surveyed acreage in micros the multi-owner division''s ratios come from, across hundreds of deeded fractional heirs. UNIQUE (parcel_id, owner_payee_id): an upsert converges.';

-- ---------------------------------------------------------------------------
-- energy_parcel_royalty_policies: the tiered royalty ladders of record.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_parcel_royalty_policies (
  id           uuid primary key default gen_random_uuid(),
  parcel_id    text not null,
  tier_bands   text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (parcel_id),
  constraint ck_energy_parcel_royalty_policies_parcel_present
    check (char_length(parcel_id) > 0),
  constraint ck_energy_parcel_royalty_policies_bands_present
    check (char_length(tier_bands) > 0)
);

comment on table public.energy_parcel_royalty_policies is
  'The tiered royalty ladder of record per parcel_id (migration 0052) — the ORRI bands (e.g. a 12.5% mineral ORRI split across fractional land tract heirs) as validated JSON text; validateEnergyRoyaltyBands runs before persist. UNIQUE (parcel_id): an upsert converges.';

-- ---------------------------------------------------------------------------
-- energy_parcel_royalty_positions: the cumulative royalty positions.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_parcel_royalty_positions (
  id                         uuid primary key default gen_random_uuid(),
  parcel_id                  text not null,
  period                     text not null,
  currency                   text not null,
  cumulative_revenue_cents   bigint not null,
  cumulative_royalty_cents   bigint not null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (parcel_id, period, currency),
  constraint ck_energy_parcel_royalty_positions_parcel_present
    check (char_length(parcel_id) > 0),
  constraint ck_energy_parcel_royalty_positions_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_energy_parcel_royalty_positions_currency_present
    check (char_length(currency) > 0),
  constraint ck_energy_parcel_royalty_positions_cumulative_non_negative
    check (cumulative_revenue_cents >= 0 AND cumulative_royalty_cents >= 0)
);

comment on table public.energy_parcel_royalty_positions is
  'The cumulative parcel royalty position of record per (parcel_id, period, currency) (migration 0052) — the tier walk''s cumulative revenue input and the cumulative royalty it priced. UNIQUE (parcel_id, period, currency): the position converges.';

-- ---------------------------------------------------------------------------
-- energy_compute_yield_policies: the GPU cluster yield ladders of record.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_compute_yield_policies (
  id                  uuid primary key default gen_random_uuid(),
  gpu_cluster_hash    text not null,
  sponsor_payee_id    text not null,
  sponsor_payee_name  text not null,
  tier_bands          text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (gpu_cluster_hash),
  constraint ck_energy_compute_yield_policies_cluster_present
    check (char_length(gpu_cluster_hash) > 0),
  constraint ck_energy_compute_yield_policies_sponsor_present
    check (char_length(sponsor_payee_id) > 0),
  constraint ck_energy_compute_yield_policies_sponsor_name_present
    check (char_length(sponsor_payee_name) > 0),
  constraint ck_energy_compute_yield_policies_bands_present
    check (char_length(tier_bands) > 0)
);

comment on table public.energy_compute_yield_policies is
  'The GPU cluster yield split policy of record per gpu_cluster_hash (migration 0052) — the founder-specified cluster hash and the yield bands (e.g. a 20% GPU cluster yield split to data center infrastructure sponsors) as validated JSON text. UNIQUE (gpu_cluster_hash): an upsert converges.';

-- ---------------------------------------------------------------------------
-- energy_compute_yield_positions: the cumulative yield positions.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_compute_yield_positions (
  id                                uuid primary key default gen_random_uuid(),
  gpu_cluster_hash                  text not null,
  period                            text not null,
  currency                          text not null,
  cumulative_compute_revenue_cents  bigint not null,
  cumulative_yield_cents            bigint not null,
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now(),
  unique (gpu_cluster_hash, period, currency),
  constraint ck_energy_compute_yield_positions_cluster_present
    check (char_length(gpu_cluster_hash) > 0),
  constraint ck_energy_compute_yield_positions_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_energy_compute_yield_positions_currency_present
    check (char_length(currency) > 0),
  constraint ck_energy_compute_yield_positions_cumulative_non_negative
    check (cumulative_compute_revenue_cents >= 0 AND cumulative_yield_cents >= 0)
);

comment on table public.energy_compute_yield_positions is
  'The cumulative compute yield position of record per (gpu_cluster_hash, period, currency) (migration 0052). UNIQUE (gpu_cluster_hash, period, currency): the position converges.';

-- ---------------------------------------------------------------------------
-- energy_grid_participant_registrations: the split participants.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_grid_participant_registrations (
  id                     uuid primary key default gen_random_uuid(),
  gpu_cluster_hash       text not null,
  participant_payee_id   text not null,
  participant_payee_name text not null,
  participant_class      text not null,
  weight_micros          bigint not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (gpu_cluster_hash, participant_payee_id),
  constraint ck_energy_grid_participant_registrations_cluster_present
    check (char_length(gpu_cluster_hash) > 0),
  constraint ck_energy_grid_participant_registrations_participant_present
    check (char_length(participant_payee_id) > 0),
  constraint ck_energy_grid_participant_registrations_participant_name_present
    check (char_length(participant_payee_name) > 0),
  constraint ck_energy_grid_participant_registrations_participant_class_vocabulary
    check (participant_class IN ('gpu_hardware_owner', 'power_plant_operator', 'colocation_manager')),
  constraint ck_energy_grid_participant_registrations_weight_positive
    check (weight_micros > 0)
);

comment on table public.energy_grid_participant_registrations is
  'The compute-grid split participants of record per (gpu_cluster_hash, participant_payee_id) (migration 0052) — GPU hardware owners, power plant operators, and colocation facility managers with their registered telemetry weights the dynamic split scales. UNIQUE (gpu_cluster_hash, participant_payee_id): an upsert converges.';

-- ---------------------------------------------------------------------------
-- energy_division_orders: the parsed title division orders.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_division_orders (
  id                uuid primary key default gen_random_uuid(),
  order_ref         text not null,
  parcel_id         text not null,
  owner_payee_id    text not null,
  owner_payee_name  text not null,
  interest_bps      bigint not null,
  effective_on      text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (order_ref),
  constraint ck_energy_division_orders_ref_present
    check (char_length(order_ref) > 0),
  constraint ck_energy_division_orders_parcel_present
    check (char_length(parcel_id) > 0),
  constraint ck_energy_division_orders_owner_present
    check (char_length(owner_payee_id) > 0),
  constraint ck_energy_division_orders_owner_name_present
    check (char_length(owner_payee_name) > 0),
  constraint ck_energy_division_orders_interest_in_unit_range
    check (interest_bps >= 0 AND interest_bps <= 10000),
  constraint ck_energy_division_orders_effective_shape
    check (effective_on ~ '^\d{4}-\d{2}-\d{2}$')
);

comment on table public.energy_division_orders is
  'The parsed energy title division orders of record per order_ref (migration 0052) — the stated fractional interest in bps of the parcel and the effective date the routing keys on. UNIQUE (order_ref): an upsert converges.';

-- ---------------------------------------------------------------------------
-- energy_deed_transfers: the recorded deed transfers — the reroute
-- triggers with the statutory interest rate of record AT the transfer.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_deed_transfers (
  id                        uuid primary key default gen_random_uuid(),
  deed_ref                  text not null,
  parcel_id                 text not null,
  from_payee_id             text not null,
  to_payee_id               text not null,
  transferred_acres_micros  bigint not null,
  statutory_interest_bps    bigint not null,
  recorded_on               text not null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (deed_ref),
  constraint ck_energy_deed_transfers_ref_present
    check (char_length(deed_ref) > 0),
  constraint ck_energy_deed_transfers_parcel_present
    check (char_length(parcel_id) > 0),
  constraint ck_energy_deed_transfers_parties_present
    check (char_length(from_payee_id) > 0 AND char_length(to_payee_id) > 0),
  constraint ck_energy_deed_transfers_acres_positive
    check (transferred_acres_micros > 0),
  constraint ck_energy_deed_transfers_statutory_rate_non_negative
    check (statutory_interest_bps >= 0),
  constraint ck_energy_deed_transfers_recorded_shape
    check (recorded_on ~ '^\d{4}-\d{2}-\d{2}$')
);

comment on table public.energy_deed_transfers is
  'The recorded deed transfers of record per deed_ref (migration 0052) — the acreage the deed moved and the statutory interest rate of record AT the transfer, the inputs the reroute accrual prices. UNIQUE (deed_ref): an upsert converges.';

-- ---------------------------------------------------------------------------
-- energy_carbon_offset_policies: the per-tonne payout routes.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_carbon_offset_policies (
  id                    uuid primary key default gen_random_uuid(),
  parcel_id             text not null,
  trust_payee_id        text not null,
  trust_payee_name      text not null,
  developer_payee_id    text not null,
  developer_payee_name  text not null,
  micros_per_tonne      bigint not null,
  trust_share_bps       bigint not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (parcel_id),
  constraint ck_energy_carbon_offset_policies_parcel_present
    check (char_length(parcel_id) > 0),
  constraint ck_energy_carbon_offset_policies_trust_present
    check (char_length(trust_payee_id) > 0),
  constraint ck_energy_carbon_offset_policies_trust_name_present
    check (char_length(trust_payee_name) > 0),
  constraint ck_energy_carbon_offset_policies_developer_present
    check (char_length(developer_payee_id) > 0),
  constraint ck_energy_carbon_offset_policies_developer_name_present
    check (char_length(developer_payee_name) > 0),
  constraint ck_energy_carbon_offset_policies_rate_positive
    check (micros_per_tonne > 0),
  constraint ck_energy_carbon_offset_policies_trust_share_in_unit_range
    check (trust_share_bps > 0 AND trust_share_bps < 10000)
);

comment on table public.energy_carbon_offset_policies is
  'The per-tonne carbon offset payout policy of record per parcel_id (migration 0052) — the conservation trust and project developer routes and the trust''s bps share of the payout pot. UNIQUE (parcel_id): an upsert converges.';

-- ---------------------------------------------------------------------------
-- energy_meter_sales_posts: the gross-sales post truth (the SCADA smart
-- meter utility profile's realization input).
-- ---------------------------------------------------------------------------
create table if not exists public.energy_meter_sales_posts (
  id                          uuid primary key default gen_random_uuid(),
  source_event_id             text not null,
  parcel_id                   text not null,
  well_meter_id               text not null,
  gpu_cluster_hash            text not null,
  period                      text not null,
  currency                    text not null,
  gross_energy_sales_cents    bigint not null,
  gross_mineral_sales_cents   bigint not null,
  created_at                  timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_energy_meter_sales_posts_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_energy_meter_sales_posts_parcel_present
    check (char_length(parcel_id) > 0),
  constraint ck_energy_meter_sales_posts_meter_present
    check (char_length(well_meter_id) > 0),
  constraint ck_energy_meter_sales_posts_cluster_present
    check (char_length(gpu_cluster_hash) > 0),
  constraint ck_energy_meter_sales_posts_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_energy_meter_sales_posts_currency_present
    check (char_length(currency) > 0),
  constraint ck_energy_meter_sales_posts_gross_non_negative
    check (gross_energy_sales_cents >= 0 AND gross_mineral_sales_cents >= 0)
);

comment on table public.energy_meter_sales_posts is
  'The append-only gross-sales post truth from the SCADA smart meter utility profile (migration 0052). UNIQUE (source_event_id): the replay guard; the rows are the Net Resource Realization recompute''s aggregation inputs. gpu_cluster_hash is '''' where the parcel carries no compute — the NULL-distinctness avoidance.';

-- ---------------------------------------------------------------------------
-- energy_pipeline_deduction_posts: the deduction post truth (the pipeline
-- flow-meter volume profile's realization input).
-- ---------------------------------------------------------------------------
create table if not exists public.energy_pipeline_deduction_posts (
  id                                        uuid primary key default gen_random_uuid(),
  source_event_id                           text not null,
  parcel_id                                 text not null,
  well_meter_id                             text not null,
  gpu_cluster_hash                          text not null,
  period                                    text not null,
  currency                                  text not null,
  transportation_pipeline_deductions_cents  bigint not null,
  grid_transmission_fees_cents              bigint not null,
  processing_refining_base_fees_cents       bigint not null,
  created_at                                timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_energy_pipeline_deduction_posts_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_energy_pipeline_deduction_posts_parcel_present
    check (char_length(parcel_id) > 0),
  constraint ck_energy_pipeline_deduction_posts_meter_present
    check (char_length(well_meter_id) > 0),
  constraint ck_energy_pipeline_deduction_posts_cluster_present
    check (char_length(gpu_cluster_hash) > 0),
  constraint ck_energy_pipeline_deduction_posts_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_energy_pipeline_deduction_posts_currency_present
    check (char_length(currency) > 0),
  constraint ck_energy_pipeline_deduction_posts_deductions_non_negative
    check (
      transportation_pipeline_deductions_cents >= 0
      AND grid_transmission_fees_cents >= 0
      AND processing_refining_base_fees_cents >= 0
    )
);

comment on table public.energy_pipeline_deduction_posts is
  'The append-only deduction post truth from the pipeline flow-meter volume profile (migration 0052) — transportation and pipeline deductions, grid transmission fees, and processing/refining base fees the Net Resource Realization subtracts. UNIQUE (source_event_id): the replay guard.';

-- ---------------------------------------------------------------------------
-- energy_gpu_utilization_posts: the compute post truth (the GPU data
-- center utilization profile's walk input).
-- ---------------------------------------------------------------------------
create table if not exists public.energy_gpu_utilization_posts (
  id                     uuid primary key default gen_random_uuid(),
  source_event_id        text not null,
  gpu_cluster_hash       text not null,
  period                 text not null,
  currency               text not null,
  compute_hours_micros   bigint not null,
  power_draw_kw_micros   bigint not null,
  compute_revenue_cents  bigint not null,
  created_at             timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_energy_gpu_utilization_posts_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_energy_gpu_utilization_posts_cluster_present
    check (char_length(gpu_cluster_hash) > 0),
  constraint ck_energy_gpu_utilization_posts_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_energy_gpu_utilization_posts_currency_present
    check (char_length(currency) > 0),
  constraint ck_energy_gpu_utilization_posts_telemetry_non_negative
    check (compute_hours_micros >= 0 AND power_draw_kw_micros >= 0),
  constraint ck_energy_gpu_utilization_posts_revenue_non_negative
    check (compute_revenue_cents >= 0)
);

comment on table public.energy_gpu_utilization_posts is
  'The append-only GPU utilization post truth from the GPU data center utilization profile (migration 0052) — the compute hours and power draw the dynamic grid split scales weights with, and the compute revenue the yield walk and instant cascade price. UNIQUE (source_event_id): the replay guard.';

-- ---------------------------------------------------------------------------
-- energy_net_realization_applications: THE NET REALIZED RESOURCE POOL of
-- record — recomputed in place from the post sums (the PR 33 lesson: the
-- id and created_at survive, no id in the conflict payload).
-- ---------------------------------------------------------------------------
create table if not exists public.energy_net_realization_applications (
  id                                        uuid primary key default gen_random_uuid(),
  source_event_id                           text not null,
  parcel_id                                 text not null,
  well_meter_id                             text not null,
  gpu_cluster_hash                          text not null,
  period                                    text not null,
  currency                                  text not null,
  gross_energy_sales_cents                  bigint not null,
  gross_mineral_sales_cents                 bigint not null,
  transportation_pipeline_deductions_cents  bigint not null,
  grid_transmission_fees_cents              bigint not null,
  processing_refining_base_fees_cents       bigint not null,
  net_realized_resource_pool_cents          bigint not null,
  verdict                                   text not null,
  created_at                                timestamptz not null default now(),
  updated_at                                timestamptz not null default now(),
  unique (parcel_id, well_meter_id, gpu_cluster_hash, period, currency),
  constraint ck_energy_net_realization_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_energy_net_realization_applications_parcel_present
    check (char_length(parcel_id) > 0),
  constraint ck_energy_net_realization_applications_meter_present
    check (char_length(well_meter_id) > 0),
  constraint ck_energy_net_realization_applications_cluster_present
    check (char_length(gpu_cluster_hash) > 0),
  constraint ck_energy_net_realization_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_energy_net_realization_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_energy_net_realization_applications_gross_non_negative
    check (gross_energy_sales_cents >= 0 AND gross_mineral_sales_cents >= 0),
  constraint ck_energy_net_realization_applications_deductions_non_negative
    check (
      transportation_pipeline_deductions_cents >= 0
      AND grid_transmission_fees_cents >= 0
      AND processing_refining_base_fees_cents >= 0
    ),
  constraint ck_energy_net_realization_applications_pool_conserves
    check (
      net_realized_resource_pool_cents =
        gross_energy_sales_cents
        + gross_mineral_sales_cents
        - transportation_pipeline_deductions_cents
        - grid_transmission_fees_cents
        - processing_refining_base_fees_cents
    ),
  constraint ck_energy_net_realization_applications_verdict_vocabulary
    check (verdict IN ('posted', 'held_negative_net'))
);

comment on table public.energy_net_realization_applications is
  'THE NET REALIZED RESOURCE POOL of record per (parcel_id, well_meter_id, gpu_cluster_hash, period, currency) (migration 0052) — the founder''s exact arithmetic: gross energy + mineral sales minus transportation and pipeline deductions minus grid transmission fees minus processing and refining base fees, pinned by the conservation CHECK at the database too. Recomputed in place from the meter + pipeline post sums on every post — the id and created_at survive (the PR 33 id-rotation lesson). The verdict holds the money visible when the deduction legs exceed the gross: ''held_negative_net'' pauses the payout, never drops it, never guesses it into a route. UNIQUE per the founder''s five-tuple: the recompute converges.';

-- ---------------------------------------------------------------------------
-- energy_parcel_division_applications: the append-only monthly acreage
-- division of record.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_parcel_division_applications (
  id                    uuid primary key default gen_random_uuid(),
  source_event_id       text not null,
  parcel_id             text not null,
  period                text not null,
  currency              text not null,
  revenue_basis_cents   bigint not null,
  division_legs         text not null,
  allocated_total_cents bigint not null,
  owner_count           bigint not null,
  created_at            timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_energy_parcel_division_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_energy_parcel_division_applications_parcel_present
    check (char_length(parcel_id) > 0),
  constraint ck_energy_parcel_division_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_energy_parcel_division_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_energy_parcel_division_applications_basis_non_negative
    check (revenue_basis_cents >= 0),
  constraint ck_energy_parcel_division_applications_legs_present
    check (char_length(division_legs) > 0),
  constraint ck_energy_parcel_division_applications_owners_positive
    check (owner_count > 0),
  constraint ck_energy_parcel_division_applications_allocation_conserves
    check (allocated_total_cents = revenue_basis_cents)
);

comment on table public.energy_parcel_division_applications is
  'The append-only monthly acreage division of record (migration 0052) — the incoming oil, gas, or wind generation revenue divided across the deeded fractional heirs by surveyed acreage ratios, exact to the cent (floors plus the deterministic dust top-up). The conservation CHECK pins the full allocation: the division allocates the whole pot, never a remainder of dust. UNIQUE (source_event_id): the replay guard.';

-- ---------------------------------------------------------------------------
-- energy_compute_grid_split_applications: the append-only dynamic grid
-- split of record — the instant cascade's record.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_compute_grid_split_applications (
  id                     uuid primary key default gen_random_uuid(),
  source_event_id        text not null,
  gpu_cluster_hash       text not null,
  period                 text not null,
  currency               text not null,
  compute_revenue_cents  bigint not null,
  split_legs             text not null,
  allocated_total_cents  bigint not null,
  journal_id             uuid,
  created_at             timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_energy_compute_grid_split_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_energy_compute_grid_split_applications_cluster_present
    check (char_length(gpu_cluster_hash) > 0),
  constraint ck_energy_compute_grid_split_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_energy_compute_grid_split_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_energy_compute_grid_split_applications_revenue_non_negative
    check (compute_revenue_cents >= 0),
  constraint ck_energy_compute_grid_split_applications_legs_present
    check (char_length(split_legs) > 0),
  constraint ck_energy_compute_grid_split_applications_allocation_conserves
    check (allocated_total_cents = compute_revenue_cents)
);

comment on table public.energy_compute_grid_split_applications is
  'The append-only dynamic compute-grid split of record (migration 0052) — the AI and cloud compute revenue distributed between GPU hardware owners, power plant operators, and colocation facility managers by telemetry-scaled weights, exact to the cent. The conservation CHECK pins the full allocation. journal_id is the instant posting''s ledger journal of record (null when the split recorded but the posting did not run — the reconciliation gap). UNIQUE (source_event_id): the replay guard.';

-- ---------------------------------------------------------------------------
-- energy_statutory_interest_applications: the append-only statutory
-- interest accrual of record.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_statutory_interest_applications (
  id                       uuid primary key default gen_random_uuid(),
  source_event_id          text not null,
  parcel_id                text not null,
  deed_ref                 text not null,
  period                   text not null,
  currency                 text not null,
  base_cents               bigint not null,
  late_days                bigint not null,
  statutory_interest_bps   bigint not null,
  interest_cents           bigint not null,
  created_at               timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_energy_statutory_interest_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_energy_statutory_interest_applications_parcel_present
    check (char_length(parcel_id) > 0),
  constraint ck_energy_statutory_interest_applications_deed_present
    check (char_length(deed_ref) > 0),
  constraint ck_energy_statutory_interest_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_energy_statutory_interest_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_energy_statutory_interest_applications_base_non_negative
    check (base_cents >= 0),
  constraint ck_energy_statutory_interest_applications_late_days_non_negative
    check (late_days >= 0),
  constraint ck_energy_statutory_interest_applications_rate_non_negative
    check (statutory_interest_bps >= 0),
  constraint ck_energy_statutory_interest_applications_interest_non_negative
    check (interest_cents >= 0)
);

comment on table public.energy_statutory_interest_applications is
  'The append-only statutory interest accrual of record (migration 0052) — the interest a rerouted royalty check accrues across deed transfers at the transfer''s statutory rate of record, over the days the payment ran late. UNIQUE (source_event_id): the replay guard.';

-- ---------------------------------------------------------------------------
-- energy_carbon_offset_payout_applications: the append-only per-tonne
-- payout of record.
-- ---------------------------------------------------------------------------
create table if not exists public.energy_carbon_offset_payout_applications (
  id                      uuid primary key default gen_random_uuid(),
  source_event_id         text not null,
  parcel_id               text not null,
  registry_ref            text not null,
  period                  text not null,
  currency                text not null,
  tonnes_verified_micros  bigint not null,
  micros_per_tonne        bigint not null,
  trust_share_bps         bigint not null,
  trust_payee_id          text not null,
  trust_payout_cents      bigint not null,
  developer_payee_id      text not null,
  developer_payout_cents  bigint not null,
  total_payout_cents      bigint not null,
  created_at              timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_energy_carbon_offset_payout_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_energy_carbon_offset_payout_applications_parcel_present
    check (char_length(parcel_id) > 0),
  constraint ck_energy_carbon_offset_payout_applications_registry_present
    check (char_length(registry_ref) > 0),
  constraint ck_energy_carbon_offset_payout_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_energy_carbon_offset_payout_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_energy_carbon_offset_payout_applications_tonnes_positive
    check (tonnes_verified_micros > 0),
  constraint ck_energy_carbon_offset_payout_applications_rate_positive
    check (micros_per_tonne > 0),
  constraint ck_energy_carbon_offset_payout_applications_trust_share_in_unit_range
    check (trust_share_bps > 0 AND trust_share_bps < 10000),
  constraint ck_energy_carbon_offset_payout_applications_trust_present
    check (char_length(trust_payee_id) > 0),
  constraint ck_energy_carbon_offset_payout_applications_developer_present
    check (char_length(developer_payee_id) > 0),
  constraint ck_energy_carbon_offset_payout_applications_payouts_non_negative
    check (trust_payout_cents >= 0 AND developer_payout_cents >= 0 AND total_payout_cents >= 0),
  constraint ck_energy_carbon_offset_payout_applications_payout_conserves
    check (trust_payout_cents + developer_payout_cents = total_payout_cents)
);

comment on table public.energy_carbon_offset_payout_applications is
  'The append-only per-tonne carbon offset payout of record (migration 0052) — satellite-verified canopy and emissions tonnes priced at the policy''s micros-per-tonne and split between the local land conservation trust and the project developer, routed directly. The conservation CHECK pins trust + developer = total. UNIQUE (source_event_id): the replay guard.';

-- The RLS deny-all posture — every energy lane table is energy-lane only
-- (the 0043–0051 discipline; the probes verify deny for authenticated).

alter table public.energy_land_parcels enable row level security;
drop policy if exists energy_land_parcels_service_role_all
  on public.energy_land_parcels;
create policy energy_land_parcels_service_role_all
  on public.energy_land_parcels
  for all
  using (false)
  with check (false);

alter table public.energy_parcel_owner_interests enable row level security;
drop policy if exists energy_parcel_owner_interests_service_role_all
  on public.energy_parcel_owner_interests;
create policy energy_parcel_owner_interests_service_role_all
  on public.energy_parcel_owner_interests
  for all
  using (false)
  with check (false);

alter table public.energy_parcel_royalty_policies enable row level security;
drop policy if exists energy_parcel_royalty_policies_service_role_all
  on public.energy_parcel_royalty_policies;
create policy energy_parcel_royalty_policies_service_role_all
  on public.energy_parcel_royalty_policies
  for all
  using (false)
  with check (false);

alter table public.energy_parcel_royalty_positions enable row level security;
drop policy if exists energy_parcel_royalty_positions_service_role_all
  on public.energy_parcel_royalty_positions;
create policy energy_parcel_royalty_positions_service_role_all
  on public.energy_parcel_royalty_positions
  for all
  using (false)
  with check (false);

alter table public.energy_compute_yield_policies enable row level security;
drop policy if exists energy_compute_yield_policies_service_role_all
  on public.energy_compute_yield_policies;
create policy energy_compute_yield_policies_service_role_all
  on public.energy_compute_yield_policies
  for all
  using (false)
  with check (false);

alter table public.energy_compute_yield_positions enable row level security;
drop policy if exists energy_compute_yield_positions_service_role_all
  on public.energy_compute_yield_positions;
create policy energy_compute_yield_positions_service_role_all
  on public.energy_compute_yield_positions
  for all
  using (false)
  with check (false);

alter table public.energy_grid_participant_registrations enable row level security;
drop policy if exists energy_grid_participant_registrations_service_role_all
  on public.energy_grid_participant_registrations;
create policy energy_grid_participant_registrations_service_role_all
  on public.energy_grid_participant_registrations
  for all
  using (false)
  with check (false);

alter table public.energy_division_orders enable row level security;
drop policy if exists energy_division_orders_service_role_all
  on public.energy_division_orders;
create policy energy_division_orders_service_role_all
  on public.energy_division_orders
  for all
  using (false)
  with check (false);

alter table public.energy_deed_transfers enable row level security;
drop policy if exists energy_deed_transfers_service_role_all
  on public.energy_deed_transfers;
create policy energy_deed_transfers_service_role_all
  on public.energy_deed_transfers
  for all
  using (false)
  with check (false);

alter table public.energy_carbon_offset_policies enable row level security;
drop policy if exists energy_carbon_offset_policies_service_role_all
  on public.energy_carbon_offset_policies;
create policy energy_carbon_offset_policies_service_role_all
  on public.energy_carbon_offset_policies
  for all
  using (false)
  with check (false);

alter table public.energy_meter_sales_posts enable row level security;
drop policy if exists energy_meter_sales_posts_service_role_all
  on public.energy_meter_sales_posts;
create policy energy_meter_sales_posts_service_role_all
  on public.energy_meter_sales_posts
  for all
  using (false)
  with check (false);

alter table public.energy_pipeline_deduction_posts enable row level security;
drop policy if exists energy_pipeline_deduction_posts_service_role_all
  on public.energy_pipeline_deduction_posts;
create policy energy_pipeline_deduction_posts_service_role_all
  on public.energy_pipeline_deduction_posts
  for all
  using (false)
  with check (false);

alter table public.energy_gpu_utilization_posts enable row level security;
drop policy if exists energy_gpu_utilization_posts_service_role_all
  on public.energy_gpu_utilization_posts;
create policy energy_gpu_utilization_posts_service_role_all
  on public.energy_gpu_utilization_posts
  for all
  using (false)
  with check (false);

alter table public.energy_net_realization_applications enable row level security;
drop policy if exists energy_net_realization_applications_service_role_all
  on public.energy_net_realization_applications;
create policy energy_net_realization_applications_service_role_all
  on public.energy_net_realization_applications
  for all
  using (false)
  with check (false);

alter table public.energy_parcel_division_applications enable row level security;
drop policy if exists energy_parcel_division_applications_service_role_all
  on public.energy_parcel_division_applications;
create policy energy_parcel_division_applications_service_role_all
  on public.energy_parcel_division_applications
  for all
  using (false)
  with check (false);

alter table public.energy_compute_grid_split_applications enable row level security;
drop policy if exists energy_compute_grid_split_applications_service_role_all
  on public.energy_compute_grid_split_applications;
create policy energy_compute_grid_split_applications_service_role_all
  on public.energy_compute_grid_split_applications
  for all
  using (false)
  with check (false);

alter table public.energy_statutory_interest_applications enable row level security;
drop policy if exists energy_statutory_interest_applications_service_role_all
  on public.energy_statutory_interest_applications;
create policy energy_statutory_interest_applications_service_role_all
  on public.energy_statutory_interest_applications
  for all
  using (false)
  with check (false);

alter table public.energy_carbon_offset_payout_applications enable row level security;
drop policy if exists energy_carbon_offset_payout_applications_service_role_all
  on public.energy_carbon_offset_payout_applications;
create policy energy_carbon_offset_payout_applications_service_role_all
  on public.energy_carbon_offset_payout_applications
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.energy_land_parcels to service_role;
grant select, insert, update, delete on public.energy_parcel_owner_interests to service_role;
grant select, insert, update, delete on public.energy_parcel_royalty_policies to service_role;
grant select, insert, update, delete on public.energy_parcel_royalty_positions to service_role;
grant select, insert, update, delete on public.energy_compute_yield_policies to service_role;
grant select, insert, update, delete on public.energy_compute_yield_positions to service_role;
grant select, insert, update, delete on public.energy_grid_participant_registrations to service_role;
grant select, insert, update, delete on public.energy_division_orders to service_role;
grant select, insert, update, delete on public.energy_deed_transfers to service_role;
grant select, insert, update, delete on public.energy_carbon_offset_policies to service_role;
grant select, insert, update, delete on public.energy_meter_sales_posts to service_role;
grant select, insert, update, delete on public.energy_pipeline_deduction_posts to service_role;
grant select, insert, update, delete on public.energy_gpu_utilization_posts to service_role;
grant select, insert, update, delete on public.energy_net_realization_applications to service_role;
grant select, insert, update, delete on public.energy_parcel_division_applications to service_role;
grant select, insert, update, delete on public.energy_compute_grid_split_applications to service_role;
grant select, insert, update, delete on public.energy_statutory_interest_applications to service_role;
grant select, insert, update, delete on public.energy_carbon_offset_payout_applications to service_role;
