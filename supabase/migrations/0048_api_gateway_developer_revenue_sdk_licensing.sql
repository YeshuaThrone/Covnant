-- =============================================================================
-- 0048 — The developer lane: the founder developer directive (PR 44) —
--        API/SDK developer revenue share and SDK licensing. Four strict
--        ingestion feed families (API gateway usage logs, SDK initialization
--        events, app store marketplace sales feeds, usage-based billing
--        tokens) plus the co-authored-package, SBOM-scan, white-label
--        license, and AI-agent tool-call statements convert through:
--
--   THE NET API REALIZATION CALCULATOR, keyed on the founder-specified
--   developer_id, api_endpoint_id, and sdk_package_hash columns:
--
--     Net Code Usage Pool =
--       gross API transaction revenue
--       − cloud infrastructure hosting base
--       − payment processing gate cut
--       − enterprise service level agreement reserves
--
--   and the six money walks the directive names: tiered developer
--   micro-royalties (usage-based and per-call splits with cumulative
--   monthly tracking), the platform marketplace split (15–30% platform
--   share, net 70–85% to the plugin/SDK developer), co-authored package
--   splits (Git commit + PR contribution weightings), dependency usage
--   micro-fees (SBOM scans), white-label SDK licensing (MMG recoupment +
--   overage royalties), and AI agent tool-calling micro-royalty triggers.
--
-- Fifteen tables (the 0046/0047 discipline):
--
--   developer_api_royalty_policies   <- upsertDeveloperApiRoyaltyPolicy /
--                                       getDeveloperApiRoyaltyPolicy
--     (one developer's micro-royalty policy of record: the royalty mode
--      'per_call' or 'usage_share', the payee of record (the third-party
--      data provider), the per-call tier bands as JSON text, and the
--      usage-share bps. UNIQUE per developer_id: an upsert converges.
--      ABSENT policy = a counted fail-closed skip — the walk never
--      guesses a rate.)
--
--   developer_api_call_months        <- getDeveloperApiCallMonth /
--                                       advanceDeveloperApiCallMonth
--     (the cumulative monthly call tracker per (developer_id, month) —
--      the tier walk's position: the founder's "monthly active developer
--      tiers" scale on the month's cumulative calls. UNIQUE per
--      (developer_id, month).)
--
--   developer_marketplace_split_policies
--                                    <- upsertDeveloperMarketplaceSplitPolicy /
--                                       getDeveloperMarketplaceSplitPolicy
--     (one marketplace's platform revenue share of record — the founder
--      band 1500–3000 bps (15–30%), enforced here and again at use. The
--      net 70–85% routes to the independent plugin or SDK developer. UNIQUE
--      per marketplace: an upsert converges.)
--
--   developer_copackage_contribution_legs
--                                    <- upsertDeveloperCopackageContributionLeg /
--                                       listDeveloperCopackageContributionLegs
--     (one co-maintainer's verified Git contribution weighting per
--      co-authored package: the commit and pull-request counts of record.
--      UNIQUE per (package_id, maintainer_id): an upsert converges.)
--
--   developer_dependency_maintainer_ledgers
--                                    <- upsertDeveloperDependencyMaintainerLedger /
--                                       getDeveloperDependencyMaintainerLedger
--     (one SBOM component's maintainer ledger of record: the payee and
--      the per-deploy / per-active-instance micro-fees. UNIQUE per
--      component_id: an upsert converges. ABSENT ledger = a counted
--      fail-closed skip.)
--
--   developer_whitelabel_license_deals
--                                    <- upsertDeveloperWhitelabelLicenseDeal /
--                                       getDeveloperWhitelabelLicenseDeal
--     (one white-labeled SDK package's enterprise license deal of record:
--      the owner payee, the per-seat and per-deployment micro rates, the
--      minimum monthly guarantee, and the overage royalty bps. UNIQUE per
--      sdk_package_hash: an upsert converges.)
--
--   developer_tool_royalty_policies  <- upsertDeveloperToolRoyaltyPolicy /
--                                       getDeveloperToolRoyaltyPolicy
--     (one AI-agent tool's per-call micro-settlement policy of record:
--      the tool builder payee, the per-call micros, and the builder's
--      share bps of the settlement pot. UNIQUE per tool_id: an upsert
--      converges.)
--
--   developer_api_realization_applications
--                                    <- insertDeveloperApiRealizationApplication /
--                                       getDeveloperApiRealizationApplication
--     (the append-only Net API Realization per usage event across the
--      three realizing feeds — gateway_usage, sdk_initialization,
--      usage_billing_token — with the four-leg identity pinned in a
--      CHECK and the negative-net hold verdict.)
--
--   developer_api_micro_royalty_applications
--                                    <- insertDeveloperApiMicroRoyaltyApplication /
--                                       getDeveloperApiMicroRoyaltyApplication
--     (the append-only tiered micro-royalty per usage event — the tier
--      legs with the cumulative monthly position, or the usage-share bps
--      priced off the row's Net Code Usage Pool.)
--
--   developer_marketplace_split_applications
--                                    <- insertDeveloperMarketplaceSplitApplication /
--                                       getDeveloperMarketplaceSplitApplication
--     (the append-only marketplace split per sale event — the platform's
--      floored share and the developer's residual, conserving the sale
--      exactly.)
--
--   developer_copackage_split_applications
--                                    <- insertDeveloperCopackageSplitApplication /
--                                       getDeveloperCopackageSplitApplication
--     (the append-only co-authored package split per revenue event —
--      largest-remainder exact across the contribution weightings,
--      conserving the revenue exactly.)
--
--   developer_dependency_fee_applications
--                                    <- insertDeveloperDependencyFeeApplication /
--                                       getDeveloperDependencyFeeApplication
--     (the append-only SBOM dependency micro-fee per scan event —
--      per-deploy and per-active-instance micros floored into payable
--      cents.)
--
--   developer_whitelabel_license_applications
--                                    <- insertDeveloperWhitelabelLicenseApplication /
--                                       getDeveloperWhitelabelLicenseApplication
--     (the append-only white-label settlement per license event — the
--      usage accrual, the MMG recoupment position, and the overage
--      royalty, all pinned in CHECKs.)
--
--   developer_whitelabel_usage_months
--                                    <- getDeveloperWhitelabelUsageMonth /
--                                       advanceDeveloperWhitelabelUsageMonth
--     (the cumulative monthly usage tracker per (sdk_package_hash,
--      licensor_id, month) — the MMG recoupment's position. UNIQUE per
--      the triple.)
--
--   developer_agent_tool_call_applications
--                                    <- insertDeveloperAgentToolCallApplication /
--                                       getDeveloperAgentToolCallApplication
--     (the append-only tool-call micro-settlement per batch event — the
--      builder and platform shares conserving the settlement pot
--      exactly.)
--
-- The 0032 lesson, applied: every CHECK is an explicitly named TABLE-level
-- constraint (ck_*) — column-level checks collide with table-level ones of
-- the same shape. No foreign keys by design — the tables key on the
-- senders' developer/endpoint/package identifiers, content-derived event
-- ids, and reporting months (the 0036–0047 discipline; no fk_*
-- constraints exist to name).
--
-- The PR 129 lesson, applied: every vocabulary in these CHECKs is
-- byte-identical to the TS-side arrays (DEVELOPER_REALIZATION_FEEDS,
-- DEVELOPER_ROYALTY_MODES, DEVELOPER_APPLICATION_VERDICTS,
-- DEVELOPER_MARKETPLACES, DEVELOPER_COPACKAGE_REVENUE_KINDS,
-- DEVELOPER_SCAN_CONTEXTS, DEVELOPER_LICENSE_EVENT_KINDS, and
-- DEVELOPER_AGENT_TOOLS in modules/developer/records.ts) — verified
-- byte-identical before CI.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- developer_api_royalty_policies: one developer's micro-royalty policy of
-- record — mode, payee, tier ladder, usage-share bps.
-- ---------------------------------------------------------------------------
create table if not exists public.developer_api_royalty_policies (
  id              uuid primary key default gen_random_uuid(),
  developer_id    text not null,
  royalty_mode    text not null,
  payee_id        text not null,
  tier_bands      text not null,
  usage_share_bps bigint not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (developer_id),
  constraint ck_developer_api_royalty_policies_developer_present
    check (char_length(developer_id) > 0),
  constraint ck_developer_api_royalty_policies_mode_vocabulary
    check (royalty_mode IN ('per_call', 'usage_share')),
  constraint ck_developer_api_royalty_policies_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_developer_api_royalty_policies_bands_present
    check (char_length(tier_bands) > 0),
  constraint ck_developer_api_royalty_policies_usage_share_band
    check (usage_share_bps >= 0 AND usage_share_bps <= 10000)
);

comment on table public.developer_api_royalty_policies is
  'One developer''s micro-royalty policy of record (migration 0048): the royalty mode ''per_call'' (tier bands on the month''s cumulative API calls, bigint-exact statement micros per call — e.g. $0.0001 = 10000 micros) or ''usage_share'' (bps of the row''s Net Code Usage Pool), the payee of record (the third-party data provider), and the tier ladder as JSON text. UNIQUE (developer_id): an upsert converges. ABSENT policy = a counted fail-closed skip (the walk never guesses a rate).';

-- ---------------------------------------------------------------------------
-- developer_api_call_months: the cumulative monthly call tracker — the
-- tier walk's position per (developer, month).
-- ---------------------------------------------------------------------------
create table if not exists public.developer_api_call_months (
  id                 uuid primary key default gen_random_uuid(),
  developer_id       text not null,
  month              text not null,
  cumulative_calls   bigint not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (developer_id, month),
  constraint ck_developer_api_call_months_developer_present
    check (char_length(developer_id) > 0),
  constraint ck_developer_api_call_months_period_shape
    check (month ~ '^\d{4}-\d{2}$'),
  constraint ck_developer_api_call_months_calls_non_negative
    check (cumulative_calls >= 0)
);

comment on table public.developer_api_call_months is
  'The cumulative monthly API-call tracker per (developer, month) (migration 0048) — the tier walk''s position: the founder''s monthly active developer tiers scale on the month''s cumulative calls across every call-bearing row. UNIQUE (developer_id, month).';

-- ---------------------------------------------------------------------------
-- developer_marketplace_split_policies: one marketplace's platform share
-- of record — the founder 15–30% band, enforced here and again at use.
-- ---------------------------------------------------------------------------
create table if not exists public.developer_marketplace_split_policies (
  id                 uuid primary key default gen_random_uuid(),
  marketplace        text not null,
  platform_share_bps bigint not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (marketplace),
  constraint ck_developer_marketplace_split_policies_marketplace_vocabulary
    check (marketplace IN ('apple_app_store', 'google_play', 'unity_asset_store', 'vscode_marketplace')),
  constraint ck_developer_marketplace_split_policies_platform_band
    check (platform_share_bps >= 1500 AND platform_share_bps <= 3000)
);

comment on table public.developer_marketplace_split_policies is
  'One marketplace''s platform revenue share of record (migration 0048): the founder band 1500–3000 bps (15–30%) deducting automatically before the net 70–85% routes to the independent plugin or SDK developer. UNIQUE (marketplace): an upsert converges. ABSENT policy = a counted fail-closed skip.';

-- ---------------------------------------------------------------------------
-- developer_copackage_contribution_legs: one co-maintainer's verified Git
-- contribution weighting per co-authored package.
-- ---------------------------------------------------------------------------
create table if not exists public.developer_copackage_contribution_legs (
  id             uuid primary key default gen_random_uuid(),
  package_id     text not null,
  maintainer_id  text not null,
  commits        bigint not null,
  pull_requests  bigint not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (package_id, maintainer_id),
  constraint ck_developer_copackage_contribution_legs_package_present
    check (char_length(package_id) > 0),
  constraint ck_developer_copackage_contribution_legs_maintainer_present
    check (char_length(maintainer_id) > 0),
  constraint ck_developer_copackage_contribution_legs_commits_non_negative
    check (commits >= 0),
  constraint ck_developer_copackage_contribution_legs_prs_non_negative
    check (pull_requests >= 0),
  constraint ck_developer_copackage_contribution_legs_units_positive
    check (commits + pull_requests > 0)
);

comment on table public.developer_copackage_contribution_legs is
  'One co-maintainer''s verified Git contribution weighting per co-authored package (migration 0048): the commit and pull-request counts of record — the split weightings for incoming subscription and sponsorship revenue. UNIQUE (package_id, maintainer_id): an upsert converges; a leg with zero contributions is a hostile registration.';

-- ---------------------------------------------------------------------------
-- developer_dependency_maintainer_ledgers: one SBOM component's maintainer
-- ledger of record.
-- ---------------------------------------------------------------------------
create table if not exists public.developer_dependency_maintainer_ledgers (
  id                         uuid primary key default gen_random_uuid(),
  component_id               text not null,
  maintainer_payee_id        text not null,
  micros_per_deploy          bigint not null,
  micros_per_active_instance bigint not null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (component_id),
  constraint ck_developer_dependency_maintainer_ledgers_component_present
    check (char_length(component_id) > 0),
  constraint ck_developer_dependency_maintainer_ledgers_payee_present
    check (char_length(maintainer_payee_id) > 0),
  constraint ck_developer_dependency_maintainer_ledgers_deploy_rate_non_negative
    check (micros_per_deploy >= 0),
  constraint ck_developer_dependency_maintainer_ledgers_instance_rate_non_negative
    check (micros_per_active_instance >= 0),
  constraint ck_developer_dependency_maintainer_ledgers_rates_price_something
    check (micros_per_deploy > 0 OR micros_per_active_instance > 0)
);

comment on table public.developer_dependency_maintainer_ledgers is
  'One SBOM component''s open-source maintainer ledger of record (migration 0048): the payee and the per-deploy / per-active-instance micro-fees the dependency usage micro-royalties route through. UNIQUE (component_id): an upsert converges; a ledger pricing nothing is a hostile registration. ABSENT ledger = a counted fail-closed skip.';

-- ---------------------------------------------------------------------------
-- developer_whitelabel_license_deals: one white-labeled SDK package's
-- enterprise license deal of record.
-- ---------------------------------------------------------------------------
create table if not exists public.developer_whitelabel_license_deals (
  id                          uuid primary key default gen_random_uuid(),
  sdk_package_hash            text not null,
  owner_payee_id              text not null,
  seat_micros_per_seat        bigint not null,
  deployment_micros_per_deployment bigint not null,
  minimum_monthly_guarantee_cents  bigint not null,
  overage_royalty_bps         bigint not null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (sdk_package_hash),
  constraint ck_developer_whitelabel_license_deals_package_present
    check (char_length(sdk_package_hash) > 0),
  constraint ck_developer_whitelabel_license_deals_owner_present
    check (char_length(owner_payee_id) > 0),
  constraint ck_developer_whitelabel_license_deals_seat_rate_non_negative
    check (seat_micros_per_seat >= 0),
  constraint ck_developer_whitelabel_license_deals_deployment_rate_non_negative
    check (deployment_micros_per_deployment >= 0),
  constraint ck_developer_whitelabel_license_deals_rates_price_something
    check (seat_micros_per_seat > 0 OR deployment_micros_per_deployment > 0),
  constraint ck_developer_whitelabel_license_deals_mmg_non_negative
    check (minimum_monthly_guarantee_cents >= 0),
  constraint ck_developer_whitelabel_license_deals_overage_band
    check (overage_royalty_bps >= 0 AND overage_royalty_bps <= 10000)
);

comment on table public.developer_whitelabel_license_deals is
  'One white-labeled SDK package''s enterprise license deal of record (migration 0048): the owner payee, the per-seat and per-deployment micro rates, the minimum monthly guarantee (MMG), and the overage royalty bps — usage recoups the MMG month by month and the overage royalties route directly to the SDK owner. UNIQUE (sdk_package_hash): an upsert converges. ABSENT deal = a counted fail-closed skip.';

-- ---------------------------------------------------------------------------
-- developer_tool_royalty_policies: one AI-agent tool's per-call
-- micro-settlement policy of record.
-- ---------------------------------------------------------------------------
create table if not exists public.developer_tool_royalty_policies (
  id                uuid primary key default gen_random_uuid(),
  tool_id           text not null,
  builder_payee_id  text not null,
  micros_per_call   bigint not null,
  builder_share_bps bigint not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tool_id),
  constraint ck_developer_tool_royalty_policies_tool_present
    check (char_length(tool_id) > 0),
  constraint ck_developer_tool_royalty_policies_tool_vocabulary
    check (tool_id IN ('web_search', 'database_query', 'payment_action')),
  constraint ck_developer_tool_royalty_policies_builder_present
    check (char_length(builder_payee_id) > 0),
  constraint ck_developer_tool_royalty_policies_rate_positive
    check (micros_per_call > 0),
  constraint ck_developer_tool_royalty_policies_share_band
    check (builder_share_bps >= 0 AND builder_share_bps <= 10000)
);

comment on table public.developer_tool_royalty_policies is
  'One AI-agent tool''s per-call micro-settlement policy of record (migration 0048): the tool builder payee, the per-call micros (a paid third-party tool call), and the builder''s share bps of the settlement pot — the instant posting the tool-call triggers route. UNIQUE (tool_id): an upsert converges. ABSENT policy = a counted fail-closed skip.';

-- ---------------------------------------------------------------------------
-- developer_api_realization_applications: the append-only Net API
-- Realization per usage event — the founder's exact identity.
-- ---------------------------------------------------------------------------
create table if not exists public.developer_api_realization_applications (
  id                                     uuid primary key default gen_random_uuid(),
  source_event_id                        text not null,
  feed                                   text not null,
  developer_id                           text not null,
  api_endpoint_id                        text not null,
  sdk_package_hash                       text not null,
  period                                 text not null,
  currency                               text not null,
  gross_api_transaction_revenue_cents    bigint not null,
  cloud_infrastructure_hosting_base_cents bigint not null,
  payment_processing_gate_cut_cents      bigint not null,
  enterprise_sla_reserve_cents           bigint not null,
  net_code_usage_pool_cents              bigint not null,
  verdict                                text not null,
  created_at                             timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_developer_api_realization_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_developer_api_realization_applications_feed_vocabulary
    check (feed IN ('gateway_usage', 'sdk_initialization', 'usage_billing_token')),
  constraint ck_developer_api_realization_applications_developer_present
    check (char_length(developer_id) > 0),
  constraint ck_developer_api_realization_applications_package_present
    check (char_length(sdk_package_hash) > 0),
  constraint ck_developer_api_realization_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_developer_api_realization_applications_gross_non_negative
    check (gross_api_transaction_revenue_cents >= 0),
  constraint ck_developer_api_realization_applications_hosting_non_negative
    check (cloud_infrastructure_hosting_base_cents >= 0),
  constraint ck_developer_api_realization_applications_gate_non_negative
    check (payment_processing_gate_cut_cents >= 0),
  constraint ck_developer_api_realization_applications_sla_non_negative
    check (enterprise_sla_reserve_cents >= 0),
  constraint ck_developer_api_realization_applications_verdict_vocabulary
    check (verdict IN ('paid', 'held_negative_net')),
  constraint ck_developer_api_realization_applications_identity
    check (
      cloud_infrastructure_hosting_base_cents
      + payment_processing_gate_cut_cents
      + enterprise_sla_reserve_cents
      + net_code_usage_pool_cents
      = gross_api_transaction_revenue_cents
    )
);

comment on table public.developer_api_realization_applications is
  'The append-only Net API Realization of record per usage event (migration 0048), keyed on the founder-specified developer_id, api_endpoint_id, and sdk_package_hash columns: gross API transaction revenue − cloud infrastructure hosting base − payment processing gate cut − enterprise service level agreement reserves = the Net Code Usage Pool, the identity pinned in ck_developer_api_realization_applications_identity. A deduction set larger than the gross records the held_negative_net verdict — the money pauses, visible. UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- developer_api_micro_royalty_applications: the append-only tiered
-- micro-royalty per usage event.
-- ---------------------------------------------------------------------------
create table if not exists public.developer_api_micro_royalty_applications (
  id                        uuid primary key default gen_random_uuid(),
  source_event_id           text not null,
  feed                      text not null,
  developer_id              text not null,
  api_endpoint_id           text not null,
  sdk_package_hash          text not null,
  period                    text not null,
  currency                  text not null,
  payee_id                  text not null,
  royalty_mode              text not null,
  policy_ref                text not null,
  api_calls                 bigint not null,
  tier_legs                 text not null,
  usage_share_bps           bigint not null,
  royalty_basis_cents       bigint not null,
  royalty_micros            bigint not null,
  royalty_cents             bigint not null,
  monthly_calls_before      bigint not null,
  monthly_calls_after       bigint not null,
  created_at                timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_developer_api_micro_royalty_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_developer_api_micro_royalty_applications_feed_vocabulary
    check (feed IN ('gateway_usage', 'sdk_initialization', 'usage_billing_token')),
  constraint ck_developer_api_micro_royalty_applications_developer_present
    check (char_length(developer_id) > 0),
  constraint ck_developer_api_micro_royalty_applications_payee_present
    check (char_length(payee_id) > 0),
  constraint ck_developer_api_micro_royalty_applications_mode_vocabulary
    check (royalty_mode IN ('per_call', 'usage_share')),
  constraint ck_developer_api_micro_royalty_applications_calls_non_negative
    check (api_calls >= 0),
  constraint ck_developer_api_micro_royalty_applications_share_band
    check (usage_share_bps >= 0 AND usage_share_bps <= 10000),
  constraint ck_developer_api_micro_royalty_applications_basis_non_negative
    check (royalty_basis_cents >= 0),
  constraint ck_developer_api_micro_royalty_applications_micros_non_negative
    check (royalty_micros >= 0),
  constraint ck_developer_api_micro_royalty_applications_cents_floor
    check (royalty_cents = royalty_micros / 1000000),
  constraint ck_developer_api_micro_royalty_applications_position_before_non_negative
    check (monthly_calls_before >= 0),
  constraint ck_developer_api_micro_royalty_applications_position_tracks
    check (monthly_calls_after = monthly_calls_before + api_calls)
);

comment on table public.developer_api_micro_royalty_applications is
  'The append-only tiered developer micro-royalty of record per usage event (migration 0048): per-call mode walks the event''s API calls across the policy''s tier bands on the cumulative monthly position (the tier legs JSON records every band), usage-share mode floors the policy''s bps off the row''s Net Code Usage Pool. Royalty micros are bigint-exact; payable cents floor (never round up). UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- developer_marketplace_split_applications: the append-only marketplace
-- split per sale event.
-- ---------------------------------------------------------------------------
create table if not exists public.developer_marketplace_split_applications (
  id                  uuid primary key default gen_random_uuid(),
  source_event_id     text not null,
  marketplace         text not null,
  developer_id        text not null,
  sdk_package_hash    text not null,
  period              text not null,
  currency            text not null,
  gross_sale_cents    bigint not null,
  policy_ref          text not null,
  platform_share_bps  bigint not null,
  platform_cents      bigint not null,
  developer_net_cents bigint not null,
  created_at          timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_developer_marketplace_split_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_developer_marketplace_split_applications_marketplace_vocabulary
    check (marketplace IN ('apple_app_store', 'google_play', 'unity_asset_store', 'vscode_marketplace')),
  constraint ck_developer_marketplace_split_applications_developer_present
    check (char_length(developer_id) > 0),
  constraint ck_developer_marketplace_split_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_developer_marketplace_split_applications_gross_non_negative
    check (gross_sale_cents >= 0),
  constraint ck_developer_marketplace_split_applications_platform_band
    check (platform_share_bps >= 1500 AND platform_share_bps <= 3000),
  constraint ck_developer_marketplace_split_applications_platform_floor
    check (platform_cents = (gross_sale_cents * platform_share_bps) / 10000),
  constraint ck_developer_marketplace_split_applications_conserves
    check (platform_cents + developer_net_cents = gross_sale_cents)
);

comment on table public.developer_marketplace_split_applications is
  'The append-only marketplace split of record per sale event (migration 0048): the core platform''s 15–30% revenue share floors off the gross sale and the net 70–85% routes to the independent plugin or SDK developer — the split conserves the sale exactly (ck_developer_marketplace_split_applications_conserves). UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- developer_copackage_split_applications: the append-only co-authored
-- package split per revenue event.
-- ---------------------------------------------------------------------------
create table if not exists public.developer_copackage_split_applications (
  id                   uuid primary key default gen_random_uuid(),
  source_event_id      text not null,
  package_id           text not null,
  developer_id         text not null,
  revenue_kind         text not null,
  period               text not null,
  currency             text not null,
  gross_revenue_cents  bigint not null,
  split_legs           text not null,
  allocated_total_cents bigint not null,
  created_at           timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_developer_copackage_split_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_developer_copackage_split_applications_package_present
    check (char_length(package_id) > 0),
  constraint ck_developer_copackage_split_applications_revenue_kind_vocabulary
    check (revenue_kind IN ('subscription', 'sponsorship')),
  constraint ck_developer_copackage_split_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_developer_copackage_split_applications_gross_non_negative
    check (gross_revenue_cents >= 0),
  constraint ck_developer_copackage_split_applications_legs_present
    check (char_length(split_legs) > 0),
  constraint ck_developer_copackage_split_applications_conserves
    check (allocated_total_cents = gross_revenue_cents)
);

comment on table public.developer_copackage_split_applications is
  'The append-only co-authored package split of record per revenue event (migration 0048): incoming subscription and sponsorship revenue splits across the registered co-maintainers'' verified Git commit and PR contribution weightings, largest-remainder exact — the legs'' allocated shares conserve the revenue exactly (ck_developer_copackage_split_applications_conserves). UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- developer_dependency_fee_applications: the append-only SBOM dependency
-- micro-fee per scan event.
-- ---------------------------------------------------------------------------
create table if not exists public.developer_dependency_fee_applications (
  id                           uuid primary key default gen_random_uuid(),
  source_event_id              text not null,
  developer_id                 text not null,
  component_id                 text not null,
  scan_context                 text not null,
  period                       text not null,
  currency                     text not null,
  deploy_count                 bigint not null,
  active_instances             bigint not null,
  ledger_ref                   text not null,
  maintainer_payee_id          text not null,
  micros_per_deploy            bigint not null,
  micros_per_active_instance   bigint not null,
  fee_micros                   bigint not null,
  fee_cents                    bigint not null,
  created_at                   timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_developer_dependency_fee_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_developer_dependency_fee_applications_component_present
    check (char_length(component_id) > 0),
  constraint ck_developer_dependency_fee_applications_scan_context_vocabulary
    check (scan_context IN ('ci_deploy', 'runtime_fleet')),
  constraint ck_developer_dependency_fee_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_developer_dependency_fee_applications_deploys_non_negative
    check (deploy_count >= 0),
  constraint ck_developer_dependency_fee_applications_instances_non_negative
    check (active_instances >= 0),
  constraint ck_developer_dependency_fee_applications_payee_present
    check (char_length(maintainer_payee_id) > 0),
  constraint ck_developer_dependency_fee_applications_micros_non_negative
    check (fee_micros >= 0),
  constraint ck_developer_dependency_fee_applications_cents_floor
    check (fee_cents = fee_micros / 1000000)
);

comment on table public.developer_dependency_fee_applications is
  'The append-only SBOM dependency micro-fee of record per scan event (migration 0048): per-deploy and per-active-instance micro-fees route to the registered open-source maintainer ledger — fee micros are bigint-exact, payable cents floor (never round up). UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- developer_whitelabel_license_applications: the append-only white-label
-- settlement per license event.
-- ---------------------------------------------------------------------------
create table if not exists public.developer_whitelabel_license_applications (
  id                         uuid primary key default gen_random_uuid(),
  source_event_id            text not null,
  sdk_package_hash           text not null,
  licensor_id                text not null,
  event_kind                 text not null,
  quantity                   bigint not null,
  period                     text not null,
  currency                   text not null,
  deal_ref                   text not null,
  owner_payee_id             text not null,
  usage_micros               bigint not null,
  usage_cents                bigint not null,
  monthly_usage_before_cents bigint not null,
  monthly_usage_after_cents  bigint not null,
  mmg_cents                  bigint not null,
  recouped_cents             bigint not null,
  overage_cents              bigint not null,
  overage_royalty_bps        bigint not null,
  overage_royalty_cents      bigint not null,
  created_at                 timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_developer_whitelabel_license_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_developer_whitelabel_license_applications_package_present
    check (char_length(sdk_package_hash) > 0),
  constraint ck_developer_whitelabel_license_applications_licensor_present
    check (char_length(licensor_id) > 0),
  constraint ck_developer_whitelabel_license_applications_event_kind_vocabulary
    check (event_kind IN ('seat', 'deployment')),
  constraint ck_developer_whitelabel_license_applications_quantity_positive
    check (quantity > 0),
  constraint ck_developer_whitelabel_license_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_developer_whitelabel_license_applications_owner_present
    check (char_length(owner_payee_id) > 0),
  constraint ck_developer_whitelabel_license_applications_usage_micros_non_negative
    check (usage_micros >= 0),
  constraint ck_developer_whitelabel_license_applications_usage_cents_floor
    check (usage_cents = usage_micros / 1000000),
  constraint ck_developer_whitelabel_license_applications_position_tracks
    check (monthly_usage_after_cents = monthly_usage_before_cents + usage_cents),
  constraint ck_developer_whitelabel_license_applications_mmg_non_negative
    check (mmg_cents >= 0),
  constraint ck_developer_whitelabel_license_applications_recoup_position
    check (
      recouped_cents
      = least(mmg_cents, monthly_usage_after_cents)
        - least(mmg_cents, monthly_usage_before_cents)
    ),
  constraint ck_developer_whitelabel_license_applications_overage_identity
    check (overage_cents = usage_cents - recouped_cents),
  constraint ck_developer_whitelabel_license_applications_overage_band
    check (overage_royalty_bps >= 0 AND overage_royalty_bps <= 10000),
  constraint ck_developer_whitelabel_license_applications_overage_royalty_floor
    check (overage_royalty_cents = (overage_cents * overage_royalty_bps) / 10000)
);

comment on table public.developer_whitelabel_license_applications is
  'The append-only white-label SDK license settlement of record per enterprise seat or deployment event (migration 0048): usage accrues at the deal''s per-seat / per-deployment rates, the minimum monthly guarantee recoups against the month''s cumulative usage (the recoup position pinned in ck_developer_whitelabel_license_applications_recoup_position), and the overage royalties route directly to the SDK owner (floor-exact). UNIQUE (source_event_id) is the replay guard.';

-- ---------------------------------------------------------------------------
-- developer_whitelabel_usage_months: the cumulative monthly usage tracker
-- — the MMG recoupment's position per (package, licensor, month).
-- ---------------------------------------------------------------------------
create table if not exists public.developer_whitelabel_usage_months (
  id                     uuid primary key default gen_random_uuid(),
  sdk_package_hash       text not null,
  licensor_id            text not null,
  month                  text not null,
  cumulative_usage_cents bigint not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (sdk_package_hash, licensor_id, month),
  constraint ck_developer_whitelabel_usage_months_package_present
    check (char_length(sdk_package_hash) > 0),
  constraint ck_developer_whitelabel_usage_months_licensor_present
    check (char_length(licensor_id) > 0),
  constraint ck_developer_whitelabel_usage_months_period_shape
    check (month ~ '^\d{4}-\d{2}$'),
  constraint ck_developer_whitelabel_usage_months_usage_non_negative
    check (cumulative_usage_cents >= 0)
);

comment on table public.developer_whitelabel_usage_months is
  'The cumulative monthly usage tracker per (SDK package, licensor, month) (migration 0048) — the MMG recoupment''s position: usage recoups the minimum monthly guarantee month by month until the guarantee is met. UNIQUE (sdk_package_hash, licensor_id, month).';

-- ---------------------------------------------------------------------------
-- developer_agent_tool_call_applications: the append-only tool-call
-- micro-settlement per batch event.
-- ---------------------------------------------------------------------------
create table if not exists public.developer_agent_tool_call_applications (
  id               uuid primary key default gen_random_uuid(),
  source_event_id  text not null,
  agent_id         text not null,
  tool_id          text not null,
  call_count       bigint not null,
  period           text not null,
  currency         text not null,
  policy_ref       text not null,
  builder_payee_id text not null,
  micros_per_call  bigint not null,
  settlement_micros bigint not null,
  settlement_cents bigint not null,
  builder_share_bps bigint not null,
  builder_cents    bigint not null,
  platform_cents   bigint not null,
  created_at       timestamptz not null default now(),
  unique (source_event_id),
  constraint ck_developer_agent_tool_call_applications_event_present
    check (char_length(source_event_id) > 0),
  constraint ck_developer_agent_tool_call_applications_agent_present
    check (char_length(agent_id) > 0),
  constraint ck_developer_agent_tool_call_applications_tool_vocabulary
    check (tool_id IN ('web_search', 'database_query', 'payment_action')),
  constraint ck_developer_agent_tool_call_applications_calls_positive
    check (call_count > 0),
  constraint ck_developer_agent_tool_call_applications_period_shape
    check (period ~ '^\d{4}-\d{2}$'),
  constraint ck_developer_agent_tool_call_applications_builder_present
    check (char_length(builder_payee_id) > 0),
  constraint ck_developer_agent_tool_call_applications_rate_positive
    check (micros_per_call > 0),
  constraint ck_developer_agent_tool_call_applications_micros_non_negative
    check (settlement_micros >= 0),
  constraint ck_developer_agent_tool_call_applications_pot_floor
    check (settlement_cents = settlement_micros / 1000000),
  constraint ck_developer_agent_tool_call_applications_share_band
    check (builder_share_bps >= 0 AND builder_share_bps <= 10000),
  constraint ck_developer_agent_tool_call_applications_builder_floor
    check (builder_cents = (settlement_cents * builder_share_bps) / 10000),
  constraint ck_developer_agent_tool_call_applications_conserves
    check (builder_cents + platform_cents = settlement_cents)
);

comment on table public.developer_agent_tool_call_applications is
  'The append-only AI-agent tool-call micro-settlement of record per batch event (migration 0048): an autonomous agent''s paid third-party tool calls — a web search, database query, or payment action — price at the policy''s per-call micros and split (floor-exact, conserving the pot) between the tool builder''s ledger and the platform. UNIQUE (source_event_id) is the replay guard.';

-- The RLS deny-all posture — every developer table is lane-only (the
-- 0043–0047 discipline; the probes verify deny for authenticated).

alter table public.developer_api_royalty_policies enable row level security;
drop policy if exists developer_api_royalty_policies_service_role_all
  on public.developer_api_royalty_policies;
create policy developer_api_royalty_policies_service_role_all
  on public.developer_api_royalty_policies
  for all
  using (false)
  with check (false);

alter table public.developer_api_call_months enable row level security;
drop policy if exists developer_api_call_months_service_role_all
  on public.developer_api_call_months;
create policy developer_api_call_months_service_role_all
  on public.developer_api_call_months
  for all
  using (false)
  with check (false);

alter table public.developer_marketplace_split_policies enable row level security;
drop policy if exists developer_marketplace_split_policies_service_role_all
  on public.developer_marketplace_split_policies;
create policy developer_marketplace_split_policies_service_role_all
  on public.developer_marketplace_split_policies
  for all
  using (false)
  with check (false);

alter table public.developer_copackage_contribution_legs enable row level security;
drop policy if exists developer_copackage_contribution_legs_service_role_all
  on public.developer_copackage_contribution_legs;
create policy developer_copackage_contribution_legs_service_role_all
  on public.developer_copackage_contribution_legs
  for all
  using (false)
  with check (false);

alter table public.developer_dependency_maintainer_ledgers enable row level security;
drop policy if exists developer_dependency_maintainer_ledgers_service_role_all
  on public.developer_dependency_maintainer_ledgers;
create policy developer_dependency_maintainer_ledgers_service_role_all
  on public.developer_dependency_maintainer_ledgers
  for all
  using (false)
  with check (false);

alter table public.developer_whitelabel_license_deals enable row level security;
drop policy if exists developer_whitelabel_license_deals_service_role_all
  on public.developer_whitelabel_license_deals;
create policy developer_whitelabel_license_deals_service_role_all
  on public.developer_whitelabel_license_deals
  for all
  using (false)
  with check (false);

alter table public.developer_tool_royalty_policies enable row level security;
drop policy if exists developer_tool_royalty_policies_service_role_all
  on public.developer_tool_royalty_policies;
create policy developer_tool_royalty_policies_service_role_all
  on public.developer_tool_royalty_policies
  for all
  using (false)
  with check (false);

alter table public.developer_api_realization_applications enable row level security;
drop policy if exists developer_api_realization_applications_service_role_all
  on public.developer_api_realization_applications;
create policy developer_api_realization_applications_service_role_all
  on public.developer_api_realization_applications
  for all
  using (false)
  with check (false);

alter table public.developer_api_micro_royalty_applications enable row level security;
drop policy if exists developer_api_micro_royalty_applications_service_role_all
  on public.developer_api_micro_royalty_applications;
create policy developer_api_micro_royalty_applications_service_role_all
  on public.developer_api_micro_royalty_applications
  for all
  using (false)
  with check (false);

alter table public.developer_marketplace_split_applications enable row level security;
drop policy if exists developer_marketplace_split_applications_service_role_all
  on public.developer_marketplace_split_applications;
create policy developer_marketplace_split_applications_service_role_all
  on public.developer_marketplace_split_applications
  for all
  using (false)
  with check (false);

alter table public.developer_copackage_split_applications enable row level security;
drop policy if exists developer_copackage_split_applications_service_role_all
  on public.developer_copackage_split_applications;
create policy developer_copackage_split_applications_service_role_all
  on public.developer_copackage_split_applications
  for all
  using (false)
  with check (false);

alter table public.developer_dependency_fee_applications enable row level security;
drop policy if exists developer_dependency_fee_applications_service_role_all
  on public.developer_dependency_fee_applications;
create policy developer_dependency_fee_applications_service_role_all
  on public.developer_dependency_fee_applications
  for all
  using (false)
  with check (false);

alter table public.developer_whitelabel_license_applications enable row level security;
drop policy if exists developer_whitelabel_license_applications_service_role_all
  on public.developer_whitelabel_license_applications;
create policy developer_whitelabel_license_applications_service_role_all
  on public.developer_whitelabel_license_applications
  for all
  using (false)
  with check (false);

alter table public.developer_whitelabel_usage_months enable row level security;
drop policy if exists developer_whitelabel_usage_months_service_role_all
  on public.developer_whitelabel_usage_months;
create policy developer_whitelabel_usage_months_service_role_all
  on public.developer_whitelabel_usage_months
  for all
  using (false)
  with check (false);

alter table public.developer_agent_tool_call_applications enable row level security;
drop policy if exists developer_agent_tool_call_applications_service_role_all
  on public.developer_agent_tool_call_applications;
create policy developer_agent_tool_call_applications_service_role_all
  on public.developer_agent_tool_call_applications
  for all
  using (false)
  with check (false);

grant select, insert, update, delete on public.developer_api_royalty_policies to service_role;
grant select, insert, update, delete on public.developer_api_call_months to service_role;
grant select, insert, update, delete on public.developer_marketplace_split_policies to service_role;
grant select, insert, update, delete on public.developer_copackage_contribution_legs to service_role;
grant select, insert, update, delete on public.developer_dependency_maintainer_ledgers to service_role;
grant select, insert, update, delete on public.developer_whitelabel_license_deals to service_role;
grant select, insert, update, delete on public.developer_tool_royalty_policies to service_role;
grant select, insert, update, delete on public.developer_api_realization_applications to service_role;
grant select, insert, update, delete on public.developer_api_micro_royalty_applications to service_role;
grant select, insert, update, delete on public.developer_marketplace_split_applications to service_role;
grant select, insert, update, delete on public.developer_copackage_split_applications to service_role;
grant select, insert, update, delete on public.developer_dependency_fee_applications to service_role;
grant select, insert, update, delete on public.developer_whitelabel_license_applications to service_role;
grant select, insert, update, delete on public.developer_whitelabel_usage_months to service_role;
grant select, insert, update, delete on public.developer_agent_tool_call_applications to service_role;
