/**
 * The developer revenue record vocabulary (PR 44, migration 0048) — the
 * founder developer directive's durable facts of record for API provider
 * and developer platform reconciliation:
 *
 *   developer_api_royalty_policies        — one developer's micro-royalty
 *                                           policy of record: the royalty
 *                                           mode ('per_call' or
 *                                           'usage_share'), the payee
 *                                           (the third-party data
 *                                           provider), the per-call tier
 *                                           bands, and the usage-share
 *                                           bps.
 *   developer_api_call_months             — the cumulative monthly API-call
 *                                           tracker the tier walk prices
 *                                           from.
 *   developer_marketplace_split_policies  — one marketplace's platform
 *                                           revenue share of record (the
 *                                           founder band 1500–3000 bps).
 *   developer_copackage_contribution_legs — one co-maintainer's verified
 *                                           Git commit and pull-request
 *                                           contribution weighting per
 *                                           co-authored package.
 *   developer_dependency_maintainer_ledgers — one SBOM component's
 *                                           open-source maintainer ledger
 *                                           of record (payee + per-deploy
 *                                           and per-active-instance
 *                                           micro-fees).
 *   developer_whitelabel_license_deals    — one white-labeled SDK
 *                                           package's enterprise license
 *                                           deal of record (owner payee,
 *                                           seat/deployment micro rates,
 *                                           the MMG, overage bps).
 *   developer_tool_royalty_policies       — one AI-agent tool's per-call
 *                                           micro-settlement policy of
 *                                           record (builder payee, per-
 *                                           call micros, builder share).
 *   developer_api_realization_applications      — the append-only Net API
 *                                           Realization per usage event.
 *   developer_api_micro_royalty_applications     — the append-only tiered
 *                                           micro-royalty per usage
 *                                           event.
 *   developer_marketplace_split_applications     — the append-only
 *                                           marketplace split per sale
 *                                           event.
 *   developer_copackage_split_applications       — the append-only
 *                                           co-authored package split per
 *                                           revenue event.
 *   developer_dependency_fee_applications        — the append-only SBOM
 *                                           dependency micro-fee per scan
 *                                           event.
 *   developer_whitelabel_license_applications    — the append-only
 *                                           white-label settlement per
 *                                           license event.
 *   developer_whitelabel_usage_months     — the cumulative monthly usage
 *                                           tracker the MMG recoupment
 *                                           prices from.
 *   developer_agent_tool_call_applications       — the append-only tool-
 *                                           call micro-settlement per
 *                                           batch event.
 *
 * Money is integer cents throughout; per-call royalty rates are statement
 * micros (1 dollar = 1e8 micros — $0.0001 per API call = 10000 micros) so
 * sub-cent per-call pricing stays bigint-exact. Rates are basis points
 * where they price a share of a money basis. No foreign keys by design —
 * the tables key on content-derived event ids, the feed's
 * developer/endpoint/package identifiers, and reporting months (the
 * 0036–0047 discipline).
 */

// ---------------------------------------------------------------------------
// Vocabulary — the bounded sets, byte-identical to the SQL CHECKs where a
// column carries both (the PR 129/130 lesson: drift between the engine's
// union and the schema's CHECK is a production rejection waiting to fire).
// ---------------------------------------------------------------------------

/** The API gateway usage logs' gateways of record — the directive's three
 * named gateway senders. Profile-side vocabulary only; the platform never
 * constrains a column in SQL for this set. */
export const DEVELOPER_GATEWAYS = ["kong", "aws_api_gateway", "cloudflare_workers"] as const;
export type DeveloperGateway = (typeof DEVELOPER_GATEWAYS)[number];

/** The SDK initialization events' platforms of record. Profile-side
 * vocabulary only. */
export const DEVELOPER_SDK_PLATFORMS = ["ios", "android", "web", "server"] as const;
export type DeveloperSdkPlatform = (typeof DEVELOPER_SDK_PLATFORMS)[number];

/** The usage-based billing tokens' kinds of record. Profile-side
 * vocabulary only. */
export const DEVELOPER_TOKEN_KINDS = [
  "compute_credit",
  "inference_token",
  "storage_gb_hour",
  "egress_gb",
] as const;
export type DeveloperTokenKind = (typeof DEVELOPER_TOKEN_KINDS)[number];

/** The realization applications' feed families of record — the three
 * realizing senders (marketplace sales split instead of realizing).
 * Byte-identical to the realization and royalty applications' SQL CHECK. */
export const DEVELOPER_REALIZATION_FEEDS = [
  "gateway_usage",
  "sdk_initialization",
  "usage_billing_token",
] as const;
export type DeveloperRealizationFeed = (typeof DEVELOPER_REALIZATION_FEEDS)[number];

/** The developer micro-royalty's two pricing modes of record — the
 * founder's "usage-based and per-call splits". Byte-identical to the
 * royalty policy and royalty applications' SQL CHECK. */
export const DEVELOPER_ROYALTY_MODES = ["per_call", "usage_share"] as const;
export type DeveloperRoyaltyMode = (typeof DEVELOPER_ROYALTY_MODES)[number];

/** The developer lane's application verdict of record. `paid` — the pool
 * or split priced and committed; `held_negative_net` — the realization's
 * deduction legs exceeded the gross revenue, the money pauses visible
 * (never dropped, never guessed into a route). Byte-identical to the
 * realization applications' SQL CHECK. */
export const DEVELOPER_APPLICATION_VERDICTS = ["paid", "held_negative_net"] as const;
export type DeveloperApplicationVerdict = (typeof DEVELOPER_APPLICATION_VERDICTS)[number];

/** The app store marketplaces of record — the directive's marketplace
 * sales feed families. Byte-identical to the marketplace split policies
 * and applications' SQL CHECK. */
export const DEVELOPER_MARKETPLACES = [
  "apple_app_store",
  "google_play",
  "unity_asset_store",
  "vscode_marketplace",
] as const;
export type DeveloperMarketplace = (typeof DEVELOPER_MARKETPLACES)[number];

/** The co-authored package revenue's kinds of record — the incoming
 * subscription and sponsorship revenue the directive names.
 * Byte-identical to the copackage split applications' SQL CHECK. */
export const DEVELOPER_COPACKAGE_REVENUE_KINDS = ["subscription", "sponsorship"] as const;
export type DeveloperCopackageRevenueKind =
  (typeof DEVELOPER_COPACKAGE_REVENUE_KINDS)[number];

/** The SBOM scan contexts of record — a CI deploy scan or a runtime fleet
 * scan. Byte-identical to the dependency fee applications' SQL CHECK. */
export const DEVELOPER_SCAN_CONTEXTS = ["ci_deploy", "runtime_fleet"] as const;
export type DeveloperScanContext = (typeof DEVELOPER_SCAN_CONTEXTS)[number];

/** The white-label license events' kinds of record — enterprise seats and
 * deployments. Byte-identical to the license applications' SQL CHECK. */
export const DEVELOPER_LICENSE_EVENT_KINDS = ["seat", "deployment"] as const;
export type DeveloperLicenseEventKind = (typeof DEVELOPER_LICENSE_EVENT_KINDS)[number];

/** The AI agent tool-calling tools of record — the directive's three paid
 * third-party tool families (a web search, a database query, a payment
 * action). Byte-identical to the tool royalty policies and tool call
 * applications' SQL CHECK. */
export const DEVELOPER_AGENT_TOOLS = ["web_search", "database_query", "payment_action"] as const;
export type DeveloperAgentTool = (typeof DEVELOPER_AGENT_TOOLS)[number];

/** The founder marketplace band — the platform revenue share deducts
 * within 1500–3000 bps (15–30%) before the net 70–85% routes to the
 * independent plugin or SDK developer. Enforced in the SQL CHECKs, the
 * registration validator, and again at use. */
export const DEVELOPER_MARKETPLACE_MIN_BPS = 1500;
export const DEVELOPER_MARKETPLACE_MAX_BPS = 3000;

// ---------------------------------------------------------------------------
// Validators — every policy, deal, and weighting of record re-validated at
// read; an unvalidated record is a counted fail-closed skip, never a
// guessed rate.
// ---------------------------------------------------------------------------

/** One per-call royalty tier band. `up_to` is the band's exclusive upper
 * bound on the developer's CUMULATIVE MONTHLY API CALLS — null marks the
 * open top band. Exactly one band carries `up_to: null`, and it is the
 * LAST band. The founder's example: $0.0001 per API call (10000 micros)
 * scaling up by monthly active developer tiers. */
export type DeveloperTierBand = {
  readonly up_to: number | null;
  /** The band's per-call royalty, statement micros (bigint-exact). */
  readonly micros_per_call: number;
};

/**
 * Validates a per-call tier ladder at registration and re-validates at
 * every read — non-empty, ascending strictly-increasing bounds, exactly
 * one open top band in the final position, every per-call rate a positive
 * integer micros value. A ladder that fails any clause is a hostile
 * registration, refused (the walk never guesses a rate).
 */
export function validateDeveloperTierBands(
  bands: readonly DeveloperTierBand[],
): { ok: true } | { ok: false; reason: string } {
  if (bands.length === 0) return { ok: false, reason: "empty_schedule" };
  let previousBound = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index] as DeveloperTierBand;
    const isLast = index === bands.length - 1;
    if (band.up_to === null) {
      if (!isLast) {
        return { ok: false, reason: `band_${index}:open_top_before_last` };
      }
    } else {
      if (!Number.isInteger(band.up_to) || band.up_to <= previousBound) {
        return { ok: false, reason: `band_${index}:bound_not_ascending` };
      }
      previousBound = band.up_to;
    }
    if (!Number.isInteger(band.micros_per_call) || band.micros_per_call <= 0) {
      return { ok: false, reason: `band_${index}:micros_per_call_out_of_range` };
    }
    if (!isLast && band.up_to === null) {
      return { ok: false, reason: `band_${index}:open_top_not_last` };
    }
  }
  if (bands[bands.length - 1]?.up_to !== null) {
    return { ok: false, reason: "no_open_top_band" };
  }
  return { ok: true };
}

/**
 * Validates a marketplace's platform revenue share at registration — the
 * founder band 1500–3000 bps (15–30%). A policy out of band is a hostile
 * registration, refused (the split never guesses a rate).
 */
export function validateDeveloperMarketplaceBps(platformShareBps: number): { ok: true } | {
  ok: false;
  reason: string;
} {
  if (
    !Number.isInteger(platformShareBps) ||
    platformShareBps < DEVELOPER_MARKETPLACE_MIN_BPS ||
    platformShareBps > DEVELOPER_MARKETPLACE_MAX_BPS
  ) {
    return { ok: false, reason: "platform_share_bps_out_of_founder_band" };
  }
  return { ok: true };
}

/** One co-maintainer's contribution weighting of record — the verified
 * Git commit and pull-request counts. */
export type DeveloperCopackageLeg = {
  readonly maintainer_id: string;
  readonly commits: number;
  readonly pull_requests: number;
};

/**
 * Validates a co-authored package's contribution weightings at read —
 * non-empty, unique maintainer ids, every count a non-negative integer,
 * and the contribution units (commits + pull requests) summing past zero
 * (a package nobody contributed to cannot split). An unvalidated or
 * absent weighting set is a counted fail-closed skip; the split never
 * guesses a share.
 */
export function validateDeveloperCopackageLegs(
  legs: readonly DeveloperCopackageLeg[],
): { ok: true } | { ok: false; reason: string } {
  if (legs.length === 0) return { ok: false, reason: "empty_weightings" };
  const seen = new Set<string>();
  let units = 0;
  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index] as DeveloperCopackageLeg;
    if (leg.maintainer_id === "") {
      return { ok: false, reason: `leg_${index}:maintainer_empty` };
    }
    if (seen.has(leg.maintainer_id)) {
      return { ok: false, reason: `leg_${index}:duplicate_maintainer` };
    }
    seen.add(leg.maintainer_id);
    if (!Number.isInteger(leg.commits) || leg.commits < 0) {
      return { ok: false, reason: `leg_${index}:commits_out_of_range` };
    }
    if (!Number.isInteger(leg.pull_requests) || leg.pull_requests < 0) {
      return { ok: false, reason: `leg_${index}:pull_requests_out_of_range` };
    }
    units += leg.commits + leg.pull_requests;
  }
  if (units <= 0) {
    return { ok: false, reason: "contribution_units_zero" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The records.
// ---------------------------------------------------------------------------

/** One developer's micro-royalty policy of record — the royalty mode, the
 * payee (the third-party data provider), the per-call tier ladder, and
 * the usage-share bps (validated at registration and re-validated at
 * every read). */
export type DeveloperApiRoyaltyPolicyRecord = {
  id: string;
  developer_id: string;
  royalty_mode: DeveloperRoyaltyMode;
  payee_id: string;
  /** The per-call tier ladder as JSON text (validated at read). */
  tier_bands: string;
  /** The usage-share mode's bps of the row's Net Code Usage Pool. */
  usage_share_bps: number;
  created_at: string;
  updated_at: string;
};

/** The cumulative monthly API-call tracker of record per (developer,
 * month) — the tier walk's position. */
export type DeveloperApiCallMonthRecord = {
  id: string;
  developer_id: string;
  month: string;
  cumulative_calls: number;
  created_at: string;
  updated_at: string;
};

/** One marketplace's platform revenue share of record — the founder band
 * 1500–3000 bps (15–30%), the net routing to the plugin/SDK developer. */
export type DeveloperMarketplaceSplitPolicyRecord = {
  id: string;
  marketplace: DeveloperMarketplace;
  platform_share_bps: number;
  created_at: string;
  updated_at: string;
};

/** One co-maintainer's verified Git contribution weighting of record per
 * co-authored package. */
export type DeveloperCopackageContributionLegRecord = {
  id: string;
  package_id: string;
  maintainer_id: string;
  commits: number;
  pull_requests: number;
  created_at: string;
  updated_at: string;
};

/** One SBOM component's open-source maintainer ledger of record — the
 * payee and the per-deploy / per-active-instance micro-fees. */
export type DeveloperDependencyMaintainerLedgerRecord = {
  id: string;
  component_id: string;
  maintainer_payee_id: string;
  micros_per_deploy: number;
  micros_per_active_instance: number;
  created_at: string;
  updated_at: string;
};

/** One white-labeled SDK package's enterprise license deal of record —
 * the owner payee, the per-seat and per-deployment micro rates, the
 * minimum monthly guarantee, and the overage royalty bps. */
export type DeveloperWhitelabelLicenseDealRecord = {
  id: string;
  sdk_package_hash: string;
  owner_payee_id: string;
  seat_micros_per_seat: number;
  deployment_micros_per_deployment: number;
  minimum_monthly_guarantee_cents: number;
  overage_royalty_bps: number;
  created_at: string;
  updated_at: string;
};

/** One AI-agent tool's per-call micro-settlement policy of record — the
 * tool builder payee, the per-call micros, and the builder's share bps. */
export type DeveloperToolRoyaltyPolicyRecord = {
  id: string;
  tool_id: DeveloperAgentTool;
  builder_payee_id: string;
  micros_per_call: number;
  builder_share_bps: number;
  created_at: string;
  updated_at: string;
};

/** The per-event Net API Realization of record — the founder's exact
 * identity keyed on the developer_id, api_endpoint_id, and
 * sdk_package_hash columns:
 *
 *   Net Code Usage Pool =
 *     gross API transaction revenue
 *     − cloud infrastructure hosting base
 *     − payment processing gate cut
 *     − enterprise service level agreement reserves
 */
export type DeveloperApiRealizationApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  /** The realizing feed family whose sheet the row came from. */
  feed: DeveloperRealizationFeed;
  developer_id: string;
  api_endpoint_id: string;
  sdk_package_hash: string;
  period: string;
  currency: string;
  gross_api_transaction_revenue_cents: number;
  cloud_infrastructure_hosting_base_cents: number;
  payment_processing_gate_cut_cents: number;
  enterprise_sla_reserve_cents: number;
  /** gross − hosting − gate cut − SLA reserves — the identity pinned in a
   * CHECK. */
  net_code_usage_pool_cents: number;
  verdict: DeveloperApplicationVerdict;
  created_at: string;
};

/** One tier-walk band leg of a per-call royalty application — the band
 * window's calls and their bigint-exact payout. */
export type DeveloperTierWalkLeg = {
  readonly band_from: number;
  readonly band_to: number | null;
  readonly micros_per_call: number;
  readonly band_calls: number;
  readonly band_payout_micros: number;
};

/** The per-event tiered developer micro-royalty of record — the
 * developer's per-call tier walk (with the cumulative monthly position)
 * or usage-share bps priced off the row's Net Code Usage Pool. */
export type DeveloperApiMicroRoyaltyApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  /** The realizing feed family whose sheet the row came from. */
  feed: DeveloperRealizationFeed;
  developer_id: string;
  api_endpoint_id: string;
  sdk_package_hash: string;
  period: string;
  currency: string;
  /** The royalty payee of record (the third-party data provider). */
  payee_id: string;
  royalty_mode: DeveloperRoyaltyMode;
  /** The policy of record the royalty priced at. */
  policy_ref: string;
  /** The row's call count (0 on non-gateway feeds). */
  api_calls: number;
  /** The per-call mode's committed tier legs — JSON-encoded
   * DeveloperTierWalkLeg[]. */
  tier_legs: string;
  /** The usage-share mode's bps of record (0 on per-call rows). */
  usage_share_bps: number;
  /** The royalty's money basis of record — the row's Net Code Usage Pool
   * on usage-share rows, 0 on per-call rows. */
  royalty_basis_cents: number;
  /** The bigint-exact royalty, statement micros. */
  royalty_micros: number;
  /** floor(micros / 1e6) — the payable cents (pinned in a CHECK). */
  royalty_cents: number;
  /** The cumulative monthly position the walk priced from. */
  monthly_calls_before: number;
  /** before + api_calls (pinned in a CHECK). */
  monthly_calls_after: number;
  created_at: string;
};

/** The per-event marketplace split of record — the core platform's 15–30%
 * revenue share deducted automatically before the net 70–85% routes to
 * the independent plugin or SDK developer. */
export type DeveloperMarketplaceSplitApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  marketplace: DeveloperMarketplace;
  developer_id: string;
  sdk_package_hash: string;
  period: string;
  currency: string;
  /** The gross sale of record — the split's basis. */
  gross_sale_cents: number;
  /** The policy of record the split priced at. */
  policy_ref: string;
  platform_share_bps: number;
  /** floor(gross × bps / 10000) — pinned in a CHECK. */
  platform_cents: number;
  /** The residual route — gross − platform share (pinned in a CHECK). */
  developer_net_cents: number;
  created_at: string;
};

/** One split leg of a co-authored package's committed routing — the
 * maintainer's weighting and their allocated share (largest-remainder
 * exact). */
export type DeveloperCopackageSplitLeg = {
  readonly maintainer_id: string;
  readonly commits: number;
  readonly pull_requests: number;
  /** The leg's allocated share, integer cents. */
  readonly allocated_cents: number;
};

/** The per-event co-authored package split of record — incoming
 * subscription and sponsorship revenue split across the co-maintainers'
 * verified Git commit and PR contribution weightings. */
export type DeveloperCopackageSplitApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  package_id: string;
  developer_id: string;
  revenue_kind: DeveloperCopackageRevenueKind;
  period: string;
  currency: string;
  /** The revenue of record — the split's pot. */
  gross_revenue_cents: number;
  /** The committed routing — JSON-encoded DeveloperCopackageSplitLeg[]. */
  split_legs: string;
  /** The legs' allocated shares conserve the revenue exactly (pinned in a
   * CHECK). */
  allocated_total_cents: number;
  created_at: string;
};

/** The per-event SBOM dependency micro-fee of record — per-deploy and
 * per-active-instance micro-fees routed to the registered open-source
 * maintainer ledger. */
export type DeveloperDependencyFeeApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  developer_id: string;
  component_id: string;
  scan_context: DeveloperScanContext;
  period: string;
  currency: string;
  deploy_count: number;
  active_instances: number;
  /** The maintainer ledger of record the fee priced at. */
  ledger_ref: string;
  maintainer_payee_id: string;
  micros_per_deploy: number;
  micros_per_active_instance: number;
  /** The bigint-exact fee, statement micros. */
  fee_micros: number;
  /** floor(micros / 1e6) — the payable cents (pinned in a CHECK). */
  fee_cents: number;
  created_at: string;
};

/** The per-event white-label SDK license settlement of record — the
 * enterprise seat or deployment usage, the MMG recoupment position, and
 * the overage royalty routed directly to the SDK owner. */
export type DeveloperWhitelabelLicenseApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  sdk_package_hash: string;
  /** The enterprise licensee of record (the seat/deployment log's
   * subject). */
  licensor_id: string;
  event_kind: DeveloperLicenseEventKind;
  /** The event's seat or deployment count. */
  quantity: number;
  period: string;
  currency: string;
  /** The deal of record the settlement priced at. */
  deal_ref: string;
  owner_payee_id: string;
  /** The bigint-exact usage, statement micros. */
  usage_micros: number;
  /** floor(micros / 1e6) — the payable usage cents (pinned in a CHECK). */
  usage_cents: number;
  /** The cumulative monthly usage the recoupment priced from. */
  monthly_usage_before_cents: number;
  /** before + usage (pinned in a CHECK). */
  monthly_usage_after_cents: number;
  /** The deal's MMG snapshot of record. */
  mmg_cents: number;
  /** The MMG recoupment this event executed (pinned in a CHECK against
   * the month's position and the guarantee). */
  recouped_cents: number;
  /** usage − recouped — the overage (pinned in a CHECK). */
  overage_cents: number;
  overage_royalty_bps: number;
  /** floor(overage × bps / 10000) — pinned in a CHECK. */
  overage_royalty_cents: number;
  created_at: string;
};

/** The cumulative monthly usage tracker of record per (SDK package,
 * licensor, month) — the MMG recoupment's position. */
export type DeveloperWhitelabelUsageMonthRecord = {
  id: string;
  sdk_package_hash: string;
  licensor_id: string;
  month: string;
  cumulative_usage_cents: number;
  created_at: string;
  updated_at: string;
};

/** The per-event AI-agent tool-call micro-settlement of record — the
 * paid third-party tool calls price at the policy's per-call micros and
 * split between the tool builder's ledger and the platform. */
export type DeveloperAgentToolCallApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  /** The autonomous agent of record (provenance). */
  agent_id: string;
  tool_id: DeveloperAgentTool;
  /** The batch's call count. */
  call_count: number;
  period: string;
  currency: string;
  /** The policy of record the settlement priced at. */
  policy_ref: string;
  builder_payee_id: string;
  micros_per_call: number;
  /** The bigint-exact settlement pot, statement micros. */
  settlement_micros: number;
  /** floor(micros / 1e6) — the pot in payable cents (pinned in a
   * CHECK). */
  settlement_cents: number;
  builder_share_bps: number;
  /** floor(pot × bps / 10000) — the tool builder's instant post (pinned
   * in a CHECK). */
  builder_cents: number;
  /** The residual route — pot − builder share (pinned in a CHECK). */
  platform_cents: number;
  created_at: string;
};
