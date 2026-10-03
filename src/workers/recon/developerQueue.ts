/**
 * CVT recon worker — the developer lane's store-touching pass (PR 44, the
 * founder developer directive). The math and identity spaces live in
 * developer.ts, the profiles in developerProfiles.ts; THIS module is the
 * only place the lane touches the store — the same discipline as
 * serviceQueue.ts, foodQueue.ts, fitnessQueue.ts, and the other lanes'
 * queue modules.
 *
 * House rules, restated as the module's contract:
 * - FAIL-CLOSED — a walk the lane cannot fully price records its honest
 *   outcome: a negative realization net is a HELD verdict (visible, never
 *   dropped, never posted), and a developer without a royalty policy of
 *   record, a marketplace without a split policy, a co-authored package
 *   without registered weightings, an SBOM component without a maintainer
 *   ledger, an SDK package without a white-label deal, and a tool without
 *   a settlement policy are counted skips — the walk never guesses a rate
 *   or a weighting.
 * - REPLAY GUARDS — every application is UNIQUE per content-derived
 *   source_event_id (developerRowEventId, the ledger namespace riding the
 *   prefix): a re-shipped sheet replays as a counted no-op.
 * - THE POOL PRICES THE USAGE-SHARE ROYALTY; THE CALLS PRICE THE PER-CALL
 *   TIER WALK — the per-call royalty is per-unit pricing off the row's
 *   call count against the (developer, month) cumulative position; the
 *   usage-share royalty is the policy's bps floored off the row's Net
 *   Code Usage Pool (a HELD row's negative pool never reaches it — never
 *   a negative royalty). The realization and the royalty are separate
 *   ledgers of record.
 * - THE SPLITS CONSERVE — the marketplace, co-package, and tool-call
 *   splits route residual or largest-remainder shares whose sums pin to
 *   their basis at the database; the MMG recoupment walks the month's
 *   cumulative position.
 *
 * The eight senders' walks:
 *
 *   1. API GATEWAY USAGE LOGS (sender 'gateway_usage') — the Net API
 *      Realization (gross API transaction revenue − cloud infrastructure
 *      hosting base − payment processing gate cut − enterprise SLA
 *      reserves = the Net Code Usage Pool), then the developer's
 *      micro-royalty (per-call tier walk across the founder's monthly
 *      active developer tiers, or usage-share bps off the pool).
 *   2. SDK INITIALIZATION EVENTS (sender 'sdk_initialization') — the same
 *      two walks on the activation's own money legs (a per-call policy
 *      has no call leg to price on an activation — a counted skip).
 *   3. USAGE-BASED BILLING TOKENS (sender 'usage_billing_token') — the
 *      same two walks on the token redemption's own legs.
 *   4. APP STORE MARKETPLACE SALES (sender 'marketplace_sale') — the
 *      platform's 15–30% founder-band share deducts automatically; the
 *      residual routes to the plugin/SDK developer.
 *   5. CO-AUTHORED PACKAGE REVENUE (sender 'copackage_revenue') — the
 *      pot splits across the package's verified Git commit and PR
 *      contribution weightings (largest-remainder exact).
 *   6. SBOM SCANS (sender 'sbom_scan') — the per-deploy and
 *      per-active-instance micro-fees route to the component's
 *      registered open-source maintainer ledger.
 *   7. WHITE-LABEL LICENSE EVENTS (sender 'whitelabel_license') — the
 *      seat/deployment usage joins the (package, licensor, month)
 *      cumulative position and the MMG recoupment executes; the overage
 *      royalty routes directly to the SDK owner.
 *   8. AGENT TOOL-CALL BATCHES (sender 'agent_tool_call') — the batch's
 *      calls price at the policy's per-call micros and split instantly
 *      between the tool builder's ledger and the platform.
 *
 * Developer rows NEVER enter match_queue and NEVER touch the music split
 * machinery — the store applications are this lane's money of record.
 */

import type { Store } from "@/lib/server/store";
import {
  validateDeveloperCopackageLegs,
  validateDeveloperMarketplaceBps,
  validateDeveloperTierBands,
  type DeveloperCopackageLeg,
  type DeveloperRealizationFeed,
  type DeveloperTierBand,
} from "@/modules/developer/records";
import type { ParsedStatementLine, DeveloperLineDetail } from "./records";
import {
  agentToolCallSplit,
  copackageSplitCents,
  dependencyFeeMicros,
  developerMicrosToCents,
  developerRowEventId,
  developerTierWalk,
  marketplaceSplitCents,
  netApiRealizationCents,
  usageShareRoyaltyCents,
  whitelabelLicenseSettlement,
} from "./developer";

/** The developer lane's per-pass counters — the honest outcome summary. */
export interface DeveloperWriteCounts {
  /** Realization applications committed / counted replay no-ops / the
   * negative-net holds (the money pauses, visible). */
  realizationWritten: number;
  realizationReplayed: number;
  realizationHeldNegativeNet: number;
  /** Micro-royalties committed / counted replay no-ops / fail-closed
   * skips (no royalty policy of record for the developer; a per-call
   * policy on a call-free row; a policy whose tier ladder or mode fails
   * validation at read; a usage-share royalty on a HELD row). */
  microRoyaltiesWritten: number;
  microRoyaltiesReplayed: number;
  microRoyaltiesSkippedNoPolicy: number;
  /** Marketplace splits committed / counted replay no-ops / fail-closed
   * skips (no marketplace split policy of record, or one outside the
   * founder band at read). */
  marketplaceSplitsWritten: number;
  marketplaceSplitsReplayed: number;
  marketplaceSkippedNoPolicy: number;
  /** Co-package splits committed / counted replay no-ops / fail-closed
   * skips (no registered weightings, or weightings that fail validation
   * at read). */
  copackageSplitsWritten: number;
  copackageSplitsReplayed: number;
  copackageSkippedNoLegs: number;
  /** Dependency micro-fees committed / counted replay no-ops / fail-
   * closed skips (no registered maintainer ledger for the component). */
  dependencyFeesWritten: number;
  dependencyFeesReplayed: number;
  dependencySkippedNoLedger: number;
  /** White-label settlements committed / counted replay no-ops /
   * fail-closed skips (no registered deal for the SDK package). */
  whitelabelSettlementsWritten: number;
  whitelabelSettlementsReplayed: number;
  whitelabelSkippedNoDeal: number;
  /** Tool-call settlements committed / counted replay no-ops / fail-
   * closed skips (no registered settlement policy for the tool). */
  toolCallSettlementsWritten: number;
  toolCallSettlementsReplayed: number;
  toolCallSkippedNoPolicy: number;
  /** The committed money, integer cents. */
  netCodeUsagePoolCents: number;
  microRoyaltyCents: number;
  marketplacePlatformCents: number;
  marketplaceDeveloperNetCents: number;
  copackageAllocatedCents: number;
  dependencyFeeCents: number;
  whitelabelRecoupedCents: number;
  whitelabelOverageRoyaltyCents: number;
  toolCallBuilderCents: number;
  toolCallPlatformCents: number;
}

/**
 * The developer lane's one pass over a parsed statement's lines — the
 * seven application ledgers (realization, micro-royalty, marketplace
 * split, co-package split, dependency fee, white-label settlement, and
 * tool-call settlement) land in the store's developer tables. Throws
 * into the job's fail-closed error path on any store failure.
 */
export async function writeDeveloperRowsToStore(
  store: Store,
  lines: readonly ParsedStatementLine[],
): Promise<DeveloperWriteCounts> {
  const counts: DeveloperWriteCounts = {
    realizationWritten: 0,
    realizationReplayed: 0,
    realizationHeldNegativeNet: 0,
    microRoyaltiesWritten: 0,
    microRoyaltiesReplayed: 0,
    microRoyaltiesSkippedNoPolicy: 0,
    marketplaceSplitsWritten: 0,
    marketplaceSplitsReplayed: 0,
    marketplaceSkippedNoPolicy: 0,
    copackageSplitsWritten: 0,
    copackageSplitsReplayed: 0,
    copackageSkippedNoLegs: 0,
    dependencyFeesWritten: 0,
    dependencyFeesReplayed: 0,
    dependencySkippedNoLedger: 0,
    whitelabelSettlementsWritten: 0,
    whitelabelSettlementsReplayed: 0,
    whitelabelSkippedNoDeal: 0,
    toolCallSettlementsWritten: 0,
    toolCallSettlementsReplayed: 0,
    toolCallSkippedNoPolicy: 0,
    netCodeUsagePoolCents: 0,
    microRoyaltyCents: 0,
    marketplacePlatformCents: 0,
    marketplaceDeveloperNetCents: 0,
    copackageAllocatedCents: 0,
    dependencyFeeCents: 0,
    whitelabelRecoupedCents: 0,
    whitelabelOverageRoyaltyCents: 0,
    toolCallBuilderCents: 0,
    toolCallPlatformCents: 0,
  };

  for (const line of lines) {
    const detail = line.developerDetail;
    // The developer profiles always attach the detail; a line without one
    // is a lane bug — refuse, never silently skip.
    if (detail === undefined || detail === null) {
      throw new Error(`developer_detail_missing: line ${line.lineNumber} has no developer detail`);
    }

    switch (detail.sender) {
      case "gateway_usage":
      case "sdk_initialization":
      case "usage_billing_token": {
        const legs = developerRealizationLegs(detail);
        await walkDeveloperRealization(store, detail, legs, counts);
        await walkDeveloperMicroRoyalty(store, detail, counts, legs);
        continue;
      }
      case "marketplace_sale":
        await walkMarketplaceSplit(store, detail, counts);
        continue;
      case "copackage_revenue":
        await walkCopackageSplit(store, detail, counts);
        continue;
      case "sbom_scan":
        await walkDependencyFee(store, detail, counts);
        continue;
      case "whitelabel_license":
        await walkWhitelabelSettlement(store, detail, counts);
        continue;
      case "agent_tool_call":
        await walkToolCallSettlement(store, detail, counts);
        continue;
    }
  }

  return counts;
}

/** The realization's four legs of record — the three realizing senders
 * carry the same shape. A row whose sender prices no money legs (none in
 * the current vocabulary) reads zeros. */
function developerRealizationLegs(detail: DeveloperLineDetail): {
  gross: number;
  hosting: number;
  gateCut: number;
  slaReserve: number;
  apiCalls: number;
} {
  const zeroLegs = { gross: 0, hosting: 0, gateCut: 0, slaReserve: 0, apiCalls: 0 };
  switch (detail.sender) {
    case "gateway_usage":
      return {
        gross: detail.grossApiTransactionRevenueCents,
        hosting: detail.cloudInfrastructureHostingBaseCents,
        gateCut: detail.paymentProcessingGateCutCents,
        slaReserve: detail.enterpriseSlaReserveCents,
        apiCalls: detail.apiCalls,
      };
    case "sdk_initialization":
      return {
        gross: detail.grossApiTransactionRevenueCents,
        hosting: detail.cloudInfrastructureHostingBaseCents,
        gateCut: detail.paymentProcessingGateCutCents,
        slaReserve: detail.enterpriseSlaReserveCents,
        apiCalls: zeroLegs.apiCalls,
      };
    case "usage_billing_token":
      return {
        gross: detail.grossApiTransactionRevenueCents,
        hosting: detail.cloudInfrastructureHostingBaseCents,
        gateCut: detail.paymentProcessingGateCutCents,
        slaReserve: detail.enterpriseSlaReserveCents,
        apiCalls: zeroLegs.apiCalls,
      };
    default:
      // The walk's switch only routes realizing senders here.
      return zeroLegs;
  }
}

// ---------------------------------------------------------------------------
// Senders 1–3 — the Net API Realization: the founder's exact identity on
// the usage statement's own figures, keyed on the developer, endpoint,
// and package columns.
// ---------------------------------------------------------------------------

async function walkDeveloperRealization(
  store: Store,
  detail: Extract<DeveloperLineDetail, { sender: DeveloperRealizationFeed }>,
  legs: { gross: number; hosting: number; gateCut: number; slaReserve: number },
  counts: DeveloperWriteCounts,
): Promise<void> {
  const sourceEventId = developerRowEventId("realization", detail);

  // The replay guard's read — a re-shipped sheet is a counted no-op (the
  // UNIQUE constraint is the concurrent backstop behind this read).
  const existing = await store.getDeveloperRealizationApplication(sourceEventId);
  if (existing !== undefined) {
    counts.realizationReplayed += 1;
    return;
  }

  // THE NET API REALIZATION — the sender's own figures (never a rate
  // guess); the identity (hosting + gate cut + SLA reserves + net ===
  // gross) pins the math at the database.
  const realization = netApiRealizationCents({
    grossApiTransactionRevenueCents: legs.gross,
    cloudInfrastructureHostingBaseCents: legs.hosting,
    paymentProcessingGateCutCents: legs.gateCut,
    enterpriseSlaReserveCents: legs.slaReserve,
  });

  // A NEGATIVE NET — the deduction legs exceeded the gross revenue.
  // Recorded visible (the held row's truth); the money pauses, never
  // drops, never guesses into a route.
  const held = realization.netCodeUsagePoolCents < 0;

  await store.insertDeveloperRealizationApplication({
    source_event_id: sourceEventId,
    feed: detail.sender,
    developer_id: detail.developerId,
    api_endpoint_id: detail.apiEndpointId,
    sdk_package_hash: detail.sdkPackageHash,
    period: detail.period,
    currency: detail.currency,
    gross_api_transaction_revenue_cents: realization.grossApiTransactionRevenueCents,
    cloud_infrastructure_hosting_base_cents: legs.hosting,
    payment_processing_gate_cut_cents: legs.gateCut,
    enterprise_sla_reserve_cents: legs.slaReserve,
    net_code_usage_pool_cents: realization.netCodeUsagePoolCents,
    verdict: held ? "held_negative_net" : "paid",
  });
  counts.realizationWritten += 1;
  // The pool of record includes the held row's negative net — the pass
  // summary shows the truth (the spatial lane's precedent).
  counts.netCodeUsagePoolCents += realization.netCodeUsagePoolCents;
  if (held) {
    counts.realizationHeldNegativeNet += 1;
  }
}

// ---------------------------------------------------------------------------
// Senders 1–3 — the developer micro-royalty: the per-call tier walk
// across the founder's monthly active developer tiers (per-unit pricing,
// the (developer, month) cumulative tracker as the position), or the
// usage-share bps floored off the row's Net Code Usage Pool.
// ---------------------------------------------------------------------------

async function walkDeveloperMicroRoyalty(
  store: Store,
  detail: Extract<DeveloperLineDetail, { sender: DeveloperRealizationFeed }>,
  counts: DeveloperWriteCounts,
  legs: { gross: number; hosting: number; gateCut: number; slaReserve: number; apiCalls: number },
): Promise<void> {
  const sourceEventId = developerRowEventId("royalty", detail);

  const existing = await store.getDeveloperApiMicroRoyalty(sourceEventId);
  if (existing !== undefined) {
    counts.microRoyaltiesReplayed += 1;
    return;
  }

  // The royalty policy of record — no policy, no royalty (the walk never
  // guesses a rate).
  const policy = await store.getDeveloperApiRoyaltyPolicy(detail.developerId);
  if (policy === undefined) {
    counts.microRoyaltiesSkippedNoPolicy += 1;
    return;
  }

  // The policy of record re-validates at every read.
  if (policy.royalty_mode === "per_call") {
    let bands: DeveloperTierBand[];
    try {
      bands = JSON.parse(policy.tier_bands) as DeveloperTierBand[];
    } catch {
      bands = [];
    }
    if (!validateDeveloperTierBands(bands).ok) {
      counts.microRoyaltiesSkippedNoPolicy += 1;
      return;
    }
    // A per-call policy prices a CALL leg; the gateway usage rows carry
    // it. An activation or token redemption under a per-call policy has
    // no calls to price — a counted skip (never a zero-guess royalty).
    if (legs.apiCalls <= 0) {
      counts.microRoyaltiesSkippedNoPolicy += 1;
      return;
    }
    const tracker = await store.getDeveloperApiCallMonth(detail.developerId, detail.period);
    const monthlyCallsBefore = tracker?.cumulative_calls ?? 0;
    const walk = developerTierWalk({
      calls: legs.apiCalls,
      cumulativeBefore: monthlyCallsBefore,
      bands,
    });
    // The tracker advances BEFORE the application commits — the walk's
    // cumulative position is the month's of-record position (the fitness
    // lane's precedent; both passes are replay-guarded).
    await store.advanceDeveloperApiCallMonth(detail.developerId, detail.period, legs.apiCalls);
    const royaltyCents = developerMicrosToCents(walk.payoutMicros);
    await store.insertDeveloperApiMicroRoyalty({
      source_event_id: sourceEventId,
      feed: detail.sender,
      developer_id: detail.developerId,
      api_endpoint_id: detail.apiEndpointId,
      sdk_package_hash: detail.sdkPackageHash,
      period: detail.period,
      currency: detail.currency,
      payee_id: policy.payee_id,
      royalty_mode: "per_call",
      policy_ref: policy.id,
      api_calls: legs.apiCalls,
      tier_legs: JSON.stringify(walk.legs),
      usage_share_bps: 0,
      royalty_basis_cents: 0,
      royalty_micros: Number(walk.payoutMicros),
      royalty_cents: royaltyCents,
      monthly_calls_before: monthlyCallsBefore,
      monthly_calls_after: walk.cumulativeAfter,
    });
    counts.microRoyaltiesWritten += 1;
    counts.microRoyaltyCents += royaltyCents;
    return;
  }

  // THE USAGE-SHARE ROYALTY — the policy's bps floored off the row's Net
  // Code Usage Pool. A HELD row's negative pool never reaches the pricer
  // (fail-closed — never a negative royalty); the skip is counted.
  const pool =
    legs.gross - legs.hosting - legs.gateCut - legs.slaReserve;
  if (pool < 0) {
    counts.microRoyaltiesSkippedNoPolicy += 1;
    return;
  }
  const royaltyCents = usageShareRoyaltyCents({
    netCodeUsagePoolCents: pool,
    usageShareBps: policy.usage_share_bps,
  });
  await store.insertDeveloperApiMicroRoyalty({
    source_event_id: sourceEventId,
    feed: detail.sender,
    developer_id: detail.developerId,
    api_endpoint_id: detail.apiEndpointId,
    sdk_package_hash: detail.sdkPackageHash,
    period: detail.period,
    currency: detail.currency,
    payee_id: policy.payee_id,
    royalty_mode: "usage_share",
    policy_ref: policy.id,
    api_calls: 0,
    tier_legs: "[]",
    usage_share_bps: policy.usage_share_bps,
    royalty_basis_cents: pool,
    royalty_micros: royaltyCents * 1_000_000,
    royalty_cents: royaltyCents,
    monthly_calls_before: 0,
    monthly_calls_after: 0,
  });
  counts.microRoyaltiesWritten += 1;
  counts.microRoyaltyCents += royaltyCents;
}

// ---------------------------------------------------------------------------
// Sender 4 — the platform marketplace split: the founder-band share
// deducts automatically, the residual routes to the developer.
// ---------------------------------------------------------------------------

async function walkMarketplaceSplit(
  store: Store,
  detail: Extract<DeveloperLineDetail, { sender: "marketplace_sale" }>,
  counts: DeveloperWriteCounts,
): Promise<void> {
  const sourceEventId = developerRowEventId("marketplace", detail);

  const existing = await store.getDeveloperMarketplaceSplit(sourceEventId);
  if (existing !== undefined) {
    counts.marketplaceSplitsReplayed += 1;
    return;
  }

  // The marketplace split policy of record — no policy, no split (the
  // walk never guesses a rate).
  const policy = await store.getDeveloperMarketplacePolicy(detail.marketplace);
  if (policy === undefined || !validateDeveloperMarketplaceBps(policy.platform_share_bps).ok) {
    counts.marketplaceSkippedNoPolicy += 1;
    return;
  }

  // THE MARKETPLACE SPLIT — the platform share floors off the gross sale
  // and the developer routes the residual; the legs conserve the gross
  // exactly.
  const split = marketplaceSplitCents({
    grossSaleCents: detail.grossSaleCents,
    platformShareBps: policy.platform_share_bps,
  });

  await store.insertDeveloperMarketplaceSplit({
    source_event_id: sourceEventId,
    marketplace: detail.marketplace,
    developer_id: detail.developerId,
    sdk_package_hash: detail.sdkPackageHash,
    period: detail.period,
    currency: detail.currency,
    gross_sale_cents: detail.grossSaleCents,
    policy_ref: policy.id,
    platform_share_bps: policy.platform_share_bps,
    platform_cents: split.platformCents,
    developer_net_cents: split.developerNetCents,
  });
  counts.marketplaceSplitsWritten += 1;
  counts.marketplacePlatformCents += split.platformCents;
  counts.marketplaceDeveloperNetCents += split.developerNetCents;
}

// ---------------------------------------------------------------------------
// Sender 5 — the co-authored package split: the pot divides across the
// package's verified Git commit and PR contribution weightings.
// ---------------------------------------------------------------------------

async function walkCopackageSplit(
  store: Store,
  detail: Extract<DeveloperLineDetail, { sender: "copackage_revenue" }>,
  counts: DeveloperWriteCounts,
): Promise<void> {
  const sourceEventId = developerRowEventId("copackage", detail);

  const existing = await store.getDeveloperCopackageSplit(sourceEventId);
  if (existing !== undefined) {
    counts.copackageSplitsReplayed += 1;
    return;
  }

  // The contribution weightings of record — none registered (or a set
  // that fails validation at read), no split (the walk never guesses a
  // weighting).
  const legs: readonly DeveloperCopackageLeg[] = (await store.listDeveloperCopackageLegs(
    detail.packageId,
  )).map((leg) => ({
    maintainer_id: leg.maintainer_id,
    commits: leg.commits,
    pull_requests: leg.pull_requests,
  }));
  if (!validateDeveloperCopackageLegs(legs).ok) {
    counts.copackageSkippedNoLegs += 1;
    return;
  }

  // THE CO-PACKAGE SPLIT — largest-remainder exact; the legs' shares
  // conserve the pot exactly (pinned at the database).
  const split = copackageSplitCents({ potCents: detail.grossRevenueCents, legs });

  await store.insertDeveloperCopackageSplit({
    source_event_id: sourceEventId,
    package_id: detail.packageId,
    developer_id: detail.developerId,
    revenue_kind: detail.revenueKind,
    period: detail.period,
    currency: detail.currency,
    gross_revenue_cents: detail.grossRevenueCents,
    split_legs: JSON.stringify(split.legs),
    allocated_total_cents: split.allocatedTotalCents,
  });
  counts.copackageSplitsWritten += 1;
  counts.copackageAllocatedCents += split.allocatedTotalCents;
}

// ---------------------------------------------------------------------------
// Sender 6 — the SBOM dependency micro-fee: the per-deploy and
// per-active-instance fees route to the component's maintainer ledger.
// ---------------------------------------------------------------------------

async function walkDependencyFee(
  store: Store,
  detail: Extract<DeveloperLineDetail, { sender: "sbom_scan" }>,
  counts: DeveloperWriteCounts,
): Promise<void> {
  const sourceEventId = developerRowEventId("dependency", detail);

  const existing = await store.getDeveloperDependencyFee(sourceEventId);
  if (existing !== undefined) {
    counts.dependencyFeesReplayed += 1;
    return;
  }

  // The maintainer ledger of record — none registered, no fee (the walk
  // never guesses a payee or a rate).
  const ledger = await store.getDeveloperDependencyLedger(detail.componentId);
  if (ledger === undefined) {
    counts.dependencySkippedNoLedger += 1;
    return;
  }

  // THE DEPENDENCY MICRO-FEE — bigint-exact off the scan's own counts,
  // floored into payable cents.
  const feeMicros = dependencyFeeMicros({
    deployCount: detail.deployCount,
    activeInstances: detail.activeInstances,
    microsPerDeploy: ledger.micros_per_deploy,
    microsPerActiveInstance: ledger.micros_per_active_instance,
  });
  const feeCents = developerMicrosToCents(feeMicros);

  await store.insertDeveloperDependencyFee({
    source_event_id: sourceEventId,
    developer_id: detail.developerId,
    component_id: detail.componentId,
    scan_context: detail.scanContext,
    period: detail.period,
    currency: detail.currency,
    deploy_count: detail.deployCount,
    active_instances: detail.activeInstances,
    ledger_ref: ledger.id,
    maintainer_payee_id: ledger.maintainer_payee_id,
    micros_per_deploy: ledger.micros_per_deploy,
    micros_per_active_instance: ledger.micros_per_active_instance,
    fee_micros: Number(feeMicros),
    fee_cents: feeCents,
  });
  counts.dependencyFeesWritten += 1;
  counts.dependencyFeeCents += feeCents;
}

// ---------------------------------------------------------------------------
// Sender 7 — the white-label license settlement: the seat/deployment
// usage joins the (package, licensor, month) cumulative position and the
// MMG recoupment executes; the overage royalty routes to the SDK owner.
// ---------------------------------------------------------------------------

async function walkWhitelabelSettlement(
  store: Store,
  detail: Extract<DeveloperLineDetail, { sender: "whitelabel_license" }>,
  counts: DeveloperWriteCounts,
): Promise<void> {
  const sourceEventId = developerRowEventId("whitelabel", detail);

  const existing = await store.getDeveloperWhitelabelLicense(sourceEventId);
  if (existing !== undefined) {
    counts.whitelabelSettlementsReplayed += 1;
    return;
  }

  // The license deal of record — none registered, no settlement (the
  // walk never guesses a guarantee or a rate).
  const deal = await store.getDeveloperWhitelabelDeal(detail.sdkPackageHash);
  if (deal === undefined) {
    counts.whitelabelSkippedNoDeal += 1;
    return;
  }

  const monthlyUsageBeforeCents =
    (await store.getDeveloperWhitelabelUsageMonth(detail.sdkPackageHash, detail.licensorId, detail.period))
      ?.cumulative_usage_cents ?? 0;

  // THE MMG RECOUPMENT WALK — the event's usage prices at the deal's own
  // rate, joins the month's cumulative position, and the guarantee
  // recoups against it; the overage royalty routes to the owner.
  const settlement = whitelabelLicenseSettlement({
    quantity: detail.quantity,
    rateMicros:
      detail.eventKind === "seat"
        ? deal.seat_micros_per_seat
        : deal.deployment_micros_per_deployment,
    monthlyUsageBeforeCents,
    mmgCents: deal.minimum_monthly_guarantee_cents,
    overageRoyaltyBps: deal.overage_royalty_bps,
  });

  // The tracker advances before the application commits — the month's
  // cumulative position is the recoupment's of-record position (both
  // passes are replay-guarded).
  await store.advanceDeveloperWhitelabelUsageMonth(
    detail.sdkPackageHash,
    detail.licensorId,
    detail.period,
    settlement.usageCents,
  );

  await store.insertDeveloperWhitelabelLicense({
    source_event_id: sourceEventId,
    sdk_package_hash: detail.sdkPackageHash,
    licensor_id: detail.licensorId,
    event_kind: detail.eventKind,
    quantity: detail.quantity,
    period: detail.period,
    currency: detail.currency,
    deal_ref: deal.id,
    owner_payee_id: deal.owner_payee_id,
    usage_micros: Number(settlement.usageMicros),
    usage_cents: settlement.usageCents,
    monthly_usage_before_cents: monthlyUsageBeforeCents,
    monthly_usage_after_cents: settlement.monthlyUsageAfterCents,
    mmg_cents: deal.minimum_monthly_guarantee_cents,
    recouped_cents: settlement.recoupedCents,
    overage_cents: settlement.overageCents,
    overage_royalty_bps: deal.overage_royalty_bps,
    overage_royalty_cents: settlement.overageRoyaltyCents,
  });
  counts.whitelabelSettlementsWritten += 1;
  counts.whitelabelRecoupedCents += settlement.recoupedCents;
  counts.whitelabelOverageRoyaltyCents += settlement.overageRoyaltyCents;
}

// ---------------------------------------------------------------------------
// Sender 8 — the agent tool-call micro-settlement: the batch's calls
// price at the policy's per-call micros and split between the tool
// builder's ledger and the platform.
// ---------------------------------------------------------------------------

async function walkToolCallSettlement(
  store: Store,
  detail: Extract<DeveloperLineDetail, { sender: "agent_tool_call" }>,
  counts: DeveloperWriteCounts,
): Promise<void> {
  const sourceEventId = developerRowEventId("toolcall", detail);

  const existing = await store.getDeveloperToolCallApplication(sourceEventId);
  if (existing !== undefined) {
    counts.toolCallSettlementsReplayed += 1;
    return;
  }

  // The tool settlement policy of record — none registered, no
  // settlement (the walk never guesses a payee or a rate).
  const policy = await store.getDeveloperToolPolicy(detail.toolId);
  if (policy === undefined) {
    counts.toolCallSkippedNoPolicy += 1;
    return;
  }

  // THE TOOL-CALL MICRO-SETTLEMENT — the pot prices per call and the
  // builder's share floors off it; the legs conserve the pot exactly.
  const settlement = agentToolCallSplit({
    callCount: detail.callCount,
    microsPerCall: policy.micros_per_call,
    builderShareBps: policy.builder_share_bps,
  });

  await store.insertDeveloperToolCallApplication({
    source_event_id: sourceEventId,
    agent_id: detail.agentId,
    tool_id: detail.toolId,
    call_count: detail.callCount,
    period: detail.period,
    currency: detail.currency,
    policy_ref: policy.id,
    builder_payee_id: policy.builder_payee_id,
    micros_per_call: policy.micros_per_call,
    settlement_micros: Number(settlement.settlementMicros),
    settlement_cents: settlement.settlementCents,
    builder_share_bps: policy.builder_share_bps,
    builder_cents: settlement.builderCents,
    platform_cents: settlement.platformCents,
  });
  counts.toolCallSettlementsWritten += 1;
  counts.toolCallBuilderCents += settlement.builderCents;
  counts.toolCallPlatformCents += settlement.platformCents;
}
