-- =============================================================================
-- 0044 — The food lane: recipe royalty schedules, cumulative location-month
--        unit trackers, host operator and cook-cycle policies, co-brand
--        weightings and operator waterfalls, and the six application ledgers
--        (PR 40)
--
-- The founder food directive, per the brief. Twelve tables:
--
--   food_recipe_royalty_schedules   <- upsertFoodRecipeRoyaltySchedule /
--                                      getFoodRecipeRoyaltySchedule
--     (one (chef, recipe) pair's royalty schedule of record: the per-dish
--      micro-payout unit bands and the percentage royalty bps bands as JSON
--      arrays (re-validated at every read), plus the flat grocery CPG
--      royalty rate. UNIQUE per (chef_id, recipe_id): an upsert converges —
--      the newest schedule governs the next walk. ABSENT schedule = a
--      counted fail-closed skip — the walk never guesses a rate. The
--      founder's example lives here: 4% base royalty scaling to 7% once the
--      location's monthly units pass 2500 — encoded as bands, enforced by
--      the engine's strict-POST-threshold walk, not by this table.)
--
--   food_location_unit_months       <- advanceFoodLocationUnitMonth /
--                                      getFoodLocationUnitMonth
--     (the cumulative monthly unit tracker of record per (location, month):
--      the tier boundary prices off the CLOSING position of each row's
--      units, and the tracking is per ghost kitchen location. UNIQUE per
--      (ghost_kitchen_location_id, month): an upsert adds.)
--
--   food_host_operator_policies     <- upsertFoodHostOperatorPolicy /
--                                      getFoodHostOperatorPolicy
--     (one ghost kitchen location's host operator policy of record: the
--      brand licensor payee and the percentage cut held back from the
--      physical preparation margin — the margin routes DIRECTLY to the
--      local operator, the licensor's cut holds back. UNIQUE per location:
--      an upsert converges. ABSENT policy = a counted fail-closed skip —
--      the walk never guesses a holdback.)
--
--   food_cook_cycle_policies        <- upsertFoodCookCyclePolicy /
--                                      getFoodCookCyclePolicy
--     (one (chef, recipe) pair's cook-cycle micro-fee policy of record:
--      the payee — the master chef or food brand developer — and the
--      per-execution micro-fee. UNIQUE per (chef_id, recipe_id): an upsert
--      converges. ABSENT policy = a counted fail-closed skip.)
--
--   food_cobrand_weightings         <- upsertFoodCobrandWeighting /
--                                      listFoodCobrandWeightings
--     (one recipe's co-branded menu split legs of record — the ingredient
--      and brand weightings a collaborative dish's royalty pot routes
--      through, e.g. the celebrity chef leg and the hot sauce brand leg.
--      UNIQUE per (recipe_id, leg_id): a re-registered leg converges. An
--      unvalidated or absent weighting = a counted fail-closed skip — the
--      split never guesses a weighting.)
--
--   food_operator_waterfalls        <- upsertFoodOperatorWaterfallLeg /
--                                      listFoodOperatorWaterfallLegs
--     (one location's virtual franchise operator waterfall legs of record —
--      the proportional shares a supplier's volume rebate routes back
--      through. UNIQUE per (ghost_kitchen_location_id, operator_id): a
--      re-registered leg converges. An unvalidated or absent waterfall = a
--      counted fail-closed skip.)
--
--   food_realization_applications   <- insertFoodRealizationApplication /
--                                      getFoodRealizationApplication
--     (the append-only executed Net Recipe Realization of record per
--      delivery app order row: the founder's exact identity — gross menu
--      item sales MINUS approved ingredient COGS base MINUS delivery
--      platform engine cut MINUS local food service taxes EQUALS the Net
--      Culinary IP Pool — priced on the feed's own figures, never a rate
--      guess. The conservation identity is pinned in a CHECK. A NEGATIVE
--      pool records verdict 'held_negative_net' — visible, never dropped,
--      and the royalty walk prices nothing on a held row. UNIQUE per
--      source_event_id is the replay guard.)
--
--   food_recipe_royalty_applications
--                                   <- insertFoodRecipeRoyaltyApplication /
--                                      getFoodRecipeRoyaltyApplication
--     (the append-only executed tiered recipe royalty of record per
--      delivery app order row: the committed per-dish unit-band walk (the
--      legs pinned as JSON) and the percentage split priced on the row's
--      committed Net Culinary IP Pool at the band holding the row's
--      CLOSING cumulative monthly position. The band arithmetic, the
--      floor-pricing, and the position arithmetic are pinned in CHECKs.
--      UNIQUE per source_event_id is the replay guard.)
--
--   food_cobrand_split_applications <- insertFoodCobrandSplitApplication /
--                                      getFoodCobrandSplitApplication
--     (the append-only executed weighted co-branded menu split of record:
--      the royalty pot routed per the registered ingredient and brand
--      weightings, largest-remainder exact — the legs' allocated shares
--      conserve the pot, pinned in a CHECK. UNIQUE per source_event_id is
--      the replay guard.)
--
--   food_host_operator_split_applications
--                                   <- insertFoodHostOperatorSplitApplication /
--                                      getFoodHostOperatorSplitApplication
--     (the append-only executed host kitchen operator split of record per
--      POS ticket row: the margin's two routes — the local operator's
--      direct share and the brand licensor's held-back cut — conserving
--      the margin exactly, pinned in a CHECK. UNIQUE per source_event_id
--      is the replay guard.)
--
--   food_cook_cycle_royalties       <- insertFoodCookCycleRoyalty /
--                                      getFoodCookCycleRoyalty
--     (the append-only executed cook-cycle micro-royalty of record per
--      meal-kit production row: the per-execution fee at the policy of
--      record, the per-execution and floor-pricing identities pinned in
--      CHECKs. UNIQUE per source_event_id is the replay guard.)
--
--   food_supplier_rebate_applications
--                                   <- insertFoodSupplierRebateApplication /
--                                      getFoodSupplierRebateApplication
--     (the append-only executed supplier rebate routing of record per
--      bulk food supplier statement row — Sysco and US Foods volume
--      kickbacks: the rebate routed proportionally to the location's
--      virtual franchise operators, largest-remainder exact, the legs'
--      routed shares conserving the rebate, pinned in a CHECK. UNIQUE per
--      source_event_id is the replay guard.)
--
-- The 0032 lesson, applied: every CHECK is an explicitly named TABLE-level
-- constraint (ck_*) — column-level checks collide with table-level ones of
-- the same shape. No foreign keys by design — the tables key on the
-- senders' chef/recipe/location/operator identifiers, content-derived
-- event ids, and reporting periods (the 0036–0043 discipline; no fk_*
-- constraints exist to name).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- food_recipe_royalty_schedules: one (chef, recipe) pair's royalty schedule
-- of record — the tiers, bands, and the CPG scanner rate.
-- ---------------------------------------------------------------------------
create table if not exists public.food_recipe_royalty_schedules (
  id                    uuid primary key default gen_random_uuid(),
  chef_id               text not null,
  recipe_id             text not null,
  unit_micros_bands     text not null,
  royalty_bps_bands     text not null,
  cpg_royalty_bps       bigint not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (chef_id, recipe_id),
  constraint ck_food_recipe_royalty_schedules_chef_present
    check (char_length(chef_id) > 0),
  constraint ck_food_recipe_royalty_schedules_recipe_present
    check (char_length(recipe_id) > 0),
  constraint ck_food_recipe_royalty_schedules_bands_present
    check (char_length(unit_micros_bands) > 0 AND char_length(royalty_bps_bands) > 0),
  constraint ck_food_recipe_royalty_schedules_cpg_rate_band
    check (cpg_royalty_bps >= 0 AND cpg_royalty_bps <= 10000)
);

comment on table public.food_recipe_royalty_schedules is
  'One (chef, recipe) pair''s royalty schedule of record (migration 0044): the per-dish micro-payout unit bands and the percentage royalty bps bands as JSON arrays re-validated at every read, plus the flat grocery CPG royalty rate. UNIQUE (chef_id, recipe_id): an upsert converges — the newest schedule governs the next walk. ABSENT schedule = a counted fail-closed skip (the walk never guesses a rate).';

-- ---------------------------------------------------------------------------
-- food_location_unit_months: the cumulative monthly unit tracker of record
-- per (location, month) — the tier boundary's position source.
-- ---------------------------------------------------------------------------
create table if not exists public.food_location_unit_months (
  id                          uuid primary key default gen_random_uuid(),
  ghost_kitchen_location_id   text not null,
  month                       text not null,
  cumulative_units            bigint not null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (ghost_kitchen_location_id, month),
  constraint ck_food_location_unit_months_location_present
    check (char_length(ghost_kitchen_location_id) > 0),
  constraint ck_food_location_unit_months_month_present
    check (char_length(month) > 0),
  constraint ck_food_location_unit_months_units_non_negative
    check (cumulative_units >= 0)
);

comment on table public.food_location_unit_months is
  'The cumulative monthly unit tracker of record (migration 0044) per (ghost kitchen location, month): the tier boundary prices off each row''s CLOSING cumulative position, and the tracking is per ghost kitchen location. UNIQUE (ghost_kitchen_location_id, month): an upsert adds.';

-- ---------------------------------------------------------------------------
-- food_host_operator_policies: one location's host operator policy of
-- record — the margin's brand holdback terms.
-- ---------------------------------------------------------------------------
create table if not exists public.food_host_operator_policies (
  id                          uuid primary key default gen_random_uuid(),
  ghost_kitchen_location_id   text not null,
  brand_licensor_id           text not null,
  brand_licensor_holdback_bps bigint not null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (ghost_kitchen_location_id),
  constraint ck_food_host_operator_policies_location_present
    check (char_length(ghost_kitchen_location_id) > 0),
  constraint ck_food_host_operator_policies_licensor_present
    check (char_length(brand_licensor_id) > 0),
  constraint ck_food_host_operator_policies_holdback_band
    check (brand_licensor_holdback_bps >= 0 AND brand_licensor_holdback_bps <= 10000)
);

comment on table public.food_host_operator_policies is
  'One ghost kitchen location''s host operator policy of record (migration 0044): the brand licensor payee and the percentage cut held back from the physical preparation margin — the margin routes DIRECTLY to the local operator, the licensor''s cut holds back. UNIQUE (ghost_kitchen_location_id): an upsert converges. ABSENT policy = a counted fail-closed skip (the walk never guesses a holdback).';

-- ---------------------------------------------------------------------------
-- food_cook_cycle_policies: one (chef, recipe) pair's cook-cycle micro-fee
-- policy of record — the payee and the per-execution fee.
-- ---------------------------------------------------------------------------
create table if not exists public.food_cook_cycle_policies (
  id                     uuid primary key default gen_random_uuid(),
  chef_id                text not null,
  recipe_id              text not null,
  payee_id               text not null,
  micros_per_cook_cycle  bigint not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (chef_id, recipe_id),
  constraint ck_food_cook_cycle_policies_chef_present
    check (char_length(chef_id) > 0),
  constraint ck_food_cook_cycle_policies_recipe_present
    check (char_length(recipe_id) > 0),
  constraint ck_food_cook_cycle_policies_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_food_cook_cycle_policies_fee_non_negative
    check (micros_per_cook_cycle >= 0)
);

comment on table public.food_cook_cycle_policies is
  'One (chef, recipe) pair''s cook-cycle micro-fee policy of record (migration 0044): the payee — the master chef or food brand developer — and the per-execution micro-fee. UNIQUE (chef_id, recipe_id): an upsert converges. ABSENT policy = a counted fail-closed skip.';

-- ---------------------------------------------------------------------------
-- food_cobrand_weightings: one recipe's co-branded menu split legs of
-- record — the ingredient and brand weightings the royalty pot routes
-- through.
-- ---------------------------------------------------------------------------
create table if not exists public.food_cobrand_weightings (
  id           uuid primary key default gen_random_uuid(),
  recipe_id    text not null,
  leg_id       text not null,
  payee_id     text not null,
  payee_role   text not null,
  weight_bps   bigint not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (recipe_id, leg_id),
  constraint ck_food_cobrand_weightings_recipe_present
    check (char_length(recipe_id) > 0),
  constraint ck_food_cobrand_weightings_leg_present
    check (char_length(leg_id) > 0),
  constraint ck_food_cobrand_weightings_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_food_cobrand_weightings_role_vocabulary
    check (payee_role IN ('chef', 'brand', 'operator', 'supplier_partner')),
  constraint ck_food_cobrand_weightings_weight_positive
    check (weight_bps > 0 AND weight_bps <= 10000)
);

create index if not exists idx_food_cobrand_weightings_recipe
  on public.food_cobrand_weightings (recipe_id);

comment on table public.food_cobrand_weightings is
  'One recipe''s co-branded menu split legs of record (migration 0044) — the ingredient and brand weightings a collaborative dish''s royalty pot routes through (e.g. the celebrity chef leg and the hot sauce brand leg). UNIQUE (recipe_id, leg_id): a re-registered leg converges. An unvalidated or absent weighting = a counted fail-closed skip (the split never guesses a weighting).';

-- ---------------------------------------------------------------------------
-- food_operator_waterfalls: one location's virtual franchise operator
-- waterfall legs of record — the proportional shares supplier volume
-- rebates route back through.
-- ---------------------------------------------------------------------------
create table if not exists public.food_operator_waterfalls (
  id                         uuid primary key default gen_random_uuid(),
  ghost_kitchen_location_id  text not null,
  operator_id                text not null,
  weight_bps                 bigint not null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (ghost_kitchen_location_id, operator_id),
  constraint ck_food_operator_waterfalls_location_present
    check (char_length(ghost_kitchen_location_id) > 0),
  constraint ck_food_operator_waterfalls_operator_present
    check (char_length(operator_id) > 0),
  constraint ck_food_operator_waterfalls_weight_positive
    check (weight_bps > 0 AND weight_bps <= 10000)
);

create index if not exists idx_food_operator_waterfalls_location
  on public.food_operator_waterfalls (ghost_kitchen_location_id);

comment on table public.food_operator_waterfalls is
  'One location''s virtual franchise operator waterfall legs of record (migration 0044) — the proportional shares a supplier''s volume rebate routes back through. UNIQUE (ghost_kitchen_location_id, operator_id): a re-registered leg converges. An unvalidated or absent waterfall = a counted fail-closed skip.';

-- ---------------------------------------------------------------------------
-- food_realization_applications: the append-only executed Net Recipe
-- Realization of record per delivery app order row — the founder's exact
-- identity, priced on the feed's own figures.
-- ---------------------------------------------------------------------------
create table if not exists public.food_realization_applications (
  id                              uuid primary key default gen_random_uuid(),
  source_event_id                 text not null,
  chef_id                         text not null,
  recipe_id                       text not null,
  ghost_kitchen_location_id       text not null,
  period                          text not null,
  currency                        text not null,
  gross_menu_item_sales_cents     bigint not null,
  approved_ingredient_cogs_cents  bigint not null,
  delivery_platform_engine_cut_cents bigint not null,
  local_food_service_taxes_cents  bigint not null,
  net_culinary_ip_pool_cents      bigint not null,
  verdict                         text not null,
  created_at                      timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_food_realization_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_food_realization_applications_chef_present
    check (char_length(chef_id) > 0),
  constraint ck_food_realization_applications_recipe_present
    check (char_length(recipe_id) > 0),
  constraint ck_food_realization_applications_location_present
    check (char_length(ghost_kitchen_location_id) > 0),
  constraint ck_food_realization_applications_period_present
    check (char_length(period) > 0),
  constraint ck_food_realization_applications_currency_present
    check (char_length(currency) > 0),
  constraint ck_food_realization_applications_gross_non_negative
    check (gross_menu_item_sales_cents >= 0),
  constraint ck_food_realization_applications_cogs_non_negative
    check (approved_ingredient_cogs_cents >= 0),
  constraint ck_food_realization_applications_cut_non_negative
    check (delivery_platform_engine_cut_cents >= 0),
  constraint ck_food_realization_applications_taxes_non_negative
    check (local_food_service_taxes_cents >= 0),
  constraint ck_food_realization_applications_verdict_vocabulary
    check (verdict IN ('paid', 'held_negative_net')),
  constraint ck_food_realization_applications_net_recipe_realization
    check (
      approved_ingredient_cogs_cents
      + delivery_platform_engine_cut_cents
      + local_food_service_taxes_cents
      + net_culinary_ip_pool_cents
      = gross_menu_item_sales_cents
    )
);

comment on table public.food_realization_applications is
  'The append-only executed Net Recipe Realization of record (migration 0044) per delivery app order row: the founder''s exact identity — gross menu item sales MINUS approved ingredient COGS base MINUS delivery platform engine cut MINUS local food service taxes EQUALS the Net Culinary IP Pool — priced on the feed''s own figures, never a rate guess. The conservation identity is pinned in a CHECK. A NEGATIVE pool records verdict ''held_negative_net'' — visible, never dropped, and the royalty walk prices nothing on a held row. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- food_recipe_royalty_applications: the append-only executed tiered recipe
-- royalty of record per delivery app order row — the committed unit-band
-- walk and the percentage split on the realized pool.
-- ---------------------------------------------------------------------------
create table if not exists public.food_recipe_royalty_applications (
  id                          uuid primary key default gen_random_uuid(),
  source_event_id             text not null,
  sender                      text not null,
  chef_id                     text not null,
  recipe_id                   text not null,
  ghost_kitchen_location_id   text not null,
  period                      text not null,
  currency                    text not null,
  platform                    text not null,
  units_sold                  bigint not null,
  net_basis_cents             bigint not null,
  schedule_ref                text not null,
  unit_walk_legs              text not null,
  unit_payout_micros          bigint not null,
  unit_payout_cents           bigint not null,
  royalty_bps                 bigint not null,
  percentage_split_cents      bigint not null,
  units_before                bigint not null,
  units_after                 bigint not null,
  verdict                     text not null,
  created_at                  timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_food_recipe_royalty_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_food_recipe_royalty_applications_chef_present
    check (char_length(chef_id) > 0),
  constraint ck_food_recipe_royalty_applications_recipe_present
    check (char_length(recipe_id) > 0),
  constraint ck_food_recipe_royalty_applications_location_present
    check (char_length(ghost_kitchen_location_id) > 0),
  constraint ck_food_recipe_royalty_applications_platform_present
    check (char_length(platform) > 0),
  constraint ck_food_recipe_royalty_applications_schedule_present
    check (char_length(schedule_ref) > 0),
  constraint ck_food_recipe_royalty_applications_walk_legs_present
    check (char_length(unit_walk_legs) > 0),
  constraint ck_food_recipe_royalty_applications_units_positive
    check (units_sold > 0),
  constraint ck_food_recipe_royalty_applications_net_basis_non_negative
    check (net_basis_cents >= 0),
  constraint ck_food_recipe_royalty_applications_rate_band
    check (royalty_bps >= 0 AND royalty_bps <= 10000),
  constraint ck_food_recipe_royalty_applications_verdict_vocabulary
    check (verdict IN ('paid')),
  constraint ck_food_recipe_royalty_applications_position_arithmetic
    check (units_after = units_before + units_sold),
  constraint ck_food_recipe_royalty_applications_payout_floor
    check (unit_payout_cents = unit_payout_micros / 1000000),
  constraint ck_food_recipe_royalty_applications_percentage_split_floor
    check (percentage_split_cents = (net_basis_cents * royalty_bps) / 10000)
);

comment on table public.food_recipe_royalty_applications is
  'The append-only executed tiered recipe royalty of record (migration 0044) per delivery app order row: the committed per-dish unit-band walk (the legs pinned as JSON) and the percentage split priced on the row''s committed Net Culinary IP Pool at the band holding the row''s CLOSING cumulative monthly position. The band arithmetic, the floor-pricing, and the position arithmetic are pinned in CHECKs. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- food_cobrand_split_applications: the append-only executed weighted
-- co-branded menu split of record — the royalty pot routed per the
-- registered weightings, largest-remainder exact.
-- ---------------------------------------------------------------------------
create table if not exists public.food_cobrand_split_applications (
  id                        uuid primary key default gen_random_uuid(),
  source_event_id           text not null,
  chef_id                   text not null,
  recipe_id                 text not null,
  ghost_kitchen_location_id text not null,
  period                    text not null,
  currency                  text not null,
  royalty_pot_cents         bigint not null,
  weighting_legs            text not null,
  allocated_total_cents     bigint not null,
  created_at                timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_food_cobrand_split_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_food_cobrand_split_applications_chef_present
    check (char_length(chef_id) > 0),
  constraint ck_food_cobrand_split_applications_recipe_present
    check (char_length(recipe_id) > 0),
  constraint ck_food_cobrand_split_applications_location_present
    check (char_length(ghost_kitchen_location_id) > 0),
  constraint ck_food_cobrand_split_applications_weighting_legs_present
    check (char_length(weighting_legs) > 0),
  constraint ck_food_cobrand_split_applications_pot_positive
    check (royalty_pot_cents > 0),
  constraint ck_food_cobrand_split_applications_pot_conservation
    check (allocated_total_cents = royalty_pot_cents)
);

comment on table public.food_cobrand_split_applications is
  'The append-only executed weighted co-branded menu split of record (migration 0044): the royalty pot routed per the registered ingredient and brand weightings, largest-remainder exact — the legs'' allocated shares conserve the pot, pinned in a CHECK. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- food_host_operator_split_applications: the append-only executed host
-- kitchen operator split of record per POS ticket row — the margin's two
-- routes.
-- ---------------------------------------------------------------------------
create table if not exists public.food_host_operator_split_applications (
  id                                uuid primary key default gen_random_uuid(),
  source_event_id                   text not null,
  chef_id                           text not null,
  recipe_id                         text not null,
  ghost_kitchen_location_id         text not null,
  period                            text not null,
  currency                          text not null,
  platform                          text not null,
  tickets                           bigint not null,
  physical_preparation_margin_cents bigint not null,
  brand_licensor_id                 text not null,
  brand_licensor_holdback_bps       bigint not null,
  brand_licensor_holdback_cents     bigint not null,
  host_operator_cents               bigint not null,
  created_at                        timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_food_host_operator_split_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_food_host_operator_split_applications_chef_present
    check (char_length(chef_id) > 0),
  constraint ck_food_host_operator_split_applications_recipe_present
    check (char_length(recipe_id) > 0),
  constraint ck_food_host_operator_split_applications_location_present
    check (char_length(ghost_kitchen_location_id) > 0),
  constraint ck_food_host_operator_split_applications_licensor_present
    check (char_length(brand_licensor_id) > 0),
  constraint ck_food_host_operator_split_applications_tickets_positive
    check (tickets > 0),
  constraint ck_food_host_operator_split_applications_margin_non_negative
    check (physical_preparation_margin_cents >= 0),
  constraint ck_food_host_operator_split_applications_holdback_band
    check (brand_licensor_holdback_bps >= 0 AND brand_licensor_holdback_bps <= 10000),
  constraint ck_food_host_operator_split_applications_margin_conservation
    check (
      host_operator_cents
      = physical_preparation_margin_cents - brand_licensor_holdback_cents
    )
);

comment on table public.food_host_operator_split_applications is
  'The append-only executed host kitchen operator split of record (migration 0044) per POS ticket row: the margin''s two routes — the local operator''s direct share and the brand licensor''s held-back cut — conserving the margin exactly, pinned in a CHECK. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- food_cook_cycle_royalties: the append-only executed cook-cycle
-- micro-royalty of record per meal-kit production row — the per-execution
-- fee at the policy of record.
-- ---------------------------------------------------------------------------
create table if not exists public.food_cook_cycle_royalties (
  id                        uuid primary key default gen_random_uuid(),
  source_event_id           text not null,
  chef_id                   text not null,
  recipe_id                 text not null,
  ghost_kitchen_location_id text not null,
  period                    text not null,
  currency                  text not null,
  meal_kits_produced        bigint not null,
  cook_cycles_executed      bigint not null,
  payee_id                  text not null,
  micros_per_cook_cycle     bigint not null,
  royalty_micros            bigint not null,
  royalty_cents             bigint not null,
  created_at                timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_food_cook_cycle_royalties_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_food_cook_cycle_royalties_chef_present
    check (char_length(chef_id) > 0),
  constraint ck_food_cook_cycle_royalties_recipe_present
    check (char_length(recipe_id) > 0),
  constraint ck_food_cook_cycle_royalties_location_present
    check (char_length(ghost_kitchen_location_id) > 0),
  constraint ck_food_cook_cycle_royalties_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_food_cook_cycle_royalties_kits_non_negative
    check (meal_kits_produced >= 0),
  constraint ck_food_cook_cycle_royalties_cycles_positive
    check (cook_cycles_executed > 0),
  constraint ck_food_cook_cycle_royalties_fee_non_negative
    check (micros_per_cook_cycle >= 0),
  constraint ck_food_cook_cycle_royalties_per_execution
    check (royalty_micros = cook_cycles_executed * micros_per_cook_cycle),
  constraint ck_food_cook_cycle_royalties_floor
    check (royalty_cents = royalty_micros / 1000000)
);

comment on table public.food_cook_cycle_royalties is
  'The append-only executed cook-cycle micro-royalty of record (migration 0044) per meal-kit production row: the per-execution fee at the policy of record — the per-execution and floor-pricing identities pinned in CHECKs. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- food_supplier_rebate_applications: the append-only executed supplier
-- rebate routing of record per bulk food supplier statement row — Sysco
-- and US Foods volume kickbacks routed proportionally back to the
-- location's virtual franchise operators.
-- ---------------------------------------------------------------------------
create table if not exists public.food_supplier_rebate_applications (
  id                        uuid primary key default gen_random_uuid(),
  source_event_id           text not null,
  supplier                  text not null,
  ghost_kitchen_location_id text not null,
  period                    text not null,
  currency                  text not null,
  rebate_basis_cents        bigint not null,
  volume_rebate_cents       bigint not null,
  routing_legs              text not null,
  routed_total_cents        bigint not null,
  created_at                timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_food_supplier_rebate_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_food_supplier_rebate_applications_supplier_vocabulary
    check (supplier IN ('sysco', 'us_foods')),
  constraint ck_food_supplier_rebate_applications_location_present
    check (char_length(ghost_kitchen_location_id) > 0),
  constraint ck_food_supplier_rebate_applications_routing_legs_present
    check (char_length(routing_legs) > 0),
  constraint ck_food_supplier_rebate_applications_basis_non_negative
    check (rebate_basis_cents >= 0),
  constraint ck_food_supplier_rebate_applications_rebate_non_negative
    check (volume_rebate_cents >= 0),
  constraint ck_food_supplier_rebate_applications_rebate_conservation
    check (routed_total_cents = volume_rebate_cents)
);

comment on table public.food_supplier_rebate_applications is
  'The append-only executed supplier rebate routing of record (migration 0044) per bulk food supplier statement row — Sysco and US Foods volume kickbacks: the rebate routed proportionally to the location''s virtual franchise operators, largest-remainder exact, the legs'' routed shares conserving the rebate, pinned in a CHECK. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- Row-level security: deny-all for every role — the service role reaches
-- these tables through grants and the service client's bypassRLS, the same
-- platform-wide boundary every migration since 0007 enforces. Every policy
-- is an explicitly named table-level policy.
-- ---------------------------------------------------------------------------
alter table public.food_recipe_royalty_schedules enable row level security;
alter table public.food_location_unit_months enable row level security;
alter table public.food_host_operator_policies enable row level security;
alter table public.food_cook_cycle_policies enable row level security;
alter table public.food_cobrand_weightings enable row level security;
alter table public.food_operator_waterfalls enable row level security;
alter table public.food_realization_applications enable row level security;
alter table public.food_recipe_royalty_applications enable row level security;
alter table public.food_cobrand_split_applications enable row level security;
alter table public.food_host_operator_split_applications enable row level security;
alter table public.food_cook_cycle_royalties enable row level security;
alter table public.food_supplier_rebate_applications enable row level security;

drop policy if exists food_recipe_royalty_schedules_service_role_all
  on public.food_recipe_royalty_schedules;
create policy food_recipe_royalty_schedules_service_role_all
  on public.food_recipe_royalty_schedules
  for all
  using (false)
  with check (false);

drop policy if exists food_location_unit_months_service_role_all
  on public.food_location_unit_months;
create policy food_location_unit_months_service_role_all
  on public.food_location_unit_months
  for all
  using (false)
  with check (false);

drop policy if exists food_host_operator_policies_service_role_all
  on public.food_host_operator_policies;
create policy food_host_operator_policies_service_role_all
  on public.food_host_operator_policies
  for all
  using (false)
  with check (false);

drop policy if exists food_cook_cycle_policies_service_role_all
  on public.food_cook_cycle_policies;
create policy food_cook_cycle_policies_service_role_all
  on public.food_cook_cycle_policies
  for all
  using (false)
  with check (false);

drop policy if exists food_cobrand_weightings_service_role_all
  on public.food_cobrand_weightings;
create policy food_cobrand_weightings_service_role_all
  on public.food_cobrand_weightings
  for all
  using (false)
  with check (false);

drop policy if exists food_operator_waterfalls_service_role_all
  on public.food_operator_waterfalls;
create policy food_operator_waterfalls_service_role_all
  on public.food_operator_waterfalls
  for all
  using (false)
  with check (false);

drop policy if exists food_realization_applications_service_role_all
  on public.food_realization_applications;
create policy food_realization_applications_service_role_all
  on public.food_realization_applications
  for all
  using (false)
  with check (false);

drop policy if exists food_recipe_royalty_applications_service_role_all
  on public.food_recipe_royalty_applications;
create policy food_recipe_royalty_applications_service_role_all
  on public.food_recipe_royalty_applications
  for all
  using (false)
  with check (false);

drop policy if exists food_cobrand_split_applications_service_role_all
  on public.food_cobrand_split_applications;
create policy food_cobrand_split_applications_service_role_all
  on public.food_cobrand_split_applications
  for all
  using (false)
  with check (false);

drop policy if exists food_host_operator_split_applications_service_role_all
  on public.food_host_operator_split_applications;
create policy food_host_operator_split_applications_service_role_all
  on public.food_host_operator_split_applications
  for all
  using (false)
  with check (false);

drop policy if exists food_cook_cycle_royalties_service_role_all
  on public.food_cook_cycle_royalties;
create policy food_cook_cycle_royalties_service_role_all
  on public.food_cook_cycle_royalties
  for all
  using (false)
  with check (false);

drop policy if exists food_supplier_rebate_applications_service_role_all
  on public.food_supplier_rebate_applications;
create policy food_supplier_rebate_applications_service_role_all
  on public.food_supplier_rebate_applications
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.food_recipe_royalty_schedules to service_role;
grant select, insert, update, delete on public.food_location_unit_months to service_role;
grant select, insert, update, delete on public.food_host_operator_policies to service_role;
grant select, insert, update, delete on public.food_cook_cycle_policies to service_role;
grant select, insert, update, delete on public.food_cobrand_weightings to service_role;
grant select, insert, update, delete on public.food_operator_waterfalls to service_role;
grant select, insert, update, delete on public.food_realization_applications to service_role;
grant select, insert, update, delete on public.food_recipe_royalty_applications to service_role;
grant select, insert, update, delete on public.food_cobrand_split_applications to service_role;
grant select, insert, update, delete on public.food_host_operator_split_applications to service_role;
grant select, insert, update, delete on public.food_cook_cycle_royalties to service_role;
grant select, insert, update, delete on public.food_supplier_rebate_applications to service_role;
