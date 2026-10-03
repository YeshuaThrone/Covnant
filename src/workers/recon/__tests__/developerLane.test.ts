/**
 * The developer lane's worker-path test (PR 44, the founder developer
 * directive) — the full pass over the eight senders' sheets through the
 * real dispatch (profiles) and the real store walk (developerQueue) on
 * the in-memory backend: the exact founder math (the Net API Realization
 * identity, the $0.0001-per-call tier walk across the monthly active
 * developer tiers with cumulative tracking, the 15–30% marketplace band,
 * the commit-weighted co-package splits, the SBOM dependency micro-fees,
 * the white-label MMG recoupment with overage royalties, and the agent
 * tool-call settlement splits), the replay no-ops, and the fail-closed
 * skips — plus the pure calculators' boundary tests and the profiles'
 * strict-parser rejections.
 */
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { dispatchStatementProfile } from "../profiles";
import {
  agentToolCallSplit,
  copackageSplitCents,
  dependencyFeeMicros,
  developerRowEventId,
  developerTierWalk,
  marketplaceSplitCents,
  netApiRealizationCents,
  usageShareRoyaltyCents,
  whitelabelLicenseSettlement,
  type DeveloperSenderCode,
} from "../developer";
import { writeDeveloperRowsToStore } from "../developerQueue";
import type { ParsedStatementLine, DeveloperLineDetail } from "../records";
import { loadFixture } from "./fixtures";

/** Dispatches and parses one raw CSV through the pinned registry (the
 * worker's own two-step). */
function parseCsv(content: string): readonly ParsedStatementLine[] {
  const profile = dispatchStatementProfile(content);
  if (profile === null) throw new Error("content matched no profile");
  return profile.parse(content);
}

/** Finds one fixture row's detail by its sender and row id. */
function findDetail(
  lines: readonly ParsedStatementLine[],
  sender: DeveloperSenderCode,
  senderRowId: string,
): DeveloperLineDetail {
  for (const line of lines) {
    const detail = line.developerDetail;
    if (
      detail !== undefined &&
      detail !== null &&
      detail.sender === sender &&
      detail.senderRowId === senderRowId
    ) {
      return detail;
    }
  }
  throw new Error(`no ${sender} row ${senderRowId}`);
}

/** The founder's example ladder — $0.0001 per API call scaling up by
 * monthly active developer tiers (10,000 / 20,000 / 30,000 / 40,000
 * statement micros per call at 100K / 1M / 10M call boundaries). */
const FOUNDER_BANDS = [
  { up_to: 100_000, micros_per_call: 10_000 },
  { up_to: 1_000_000, micros_per_call: 20_000 },
  { up_to: 10_000_000, micros_per_call: 30_000 },
  { up_to: null, micros_per_call: 40_000 },
];

/** Registers every policy of record the lane's walks read. */
function registerPolicies(store: InMemoryStore): void {
  // The per-call tier policies — the third-party data providers'
  // payees ride the founder's ladder.
  for (const developer of ["dev-nova", "dev-quasar"]) {
    store.upsertDeveloperApiRoyaltyPolicy({
      developer_id: developer,
      royalty_mode: "per_call",
      payee_id: "data-provider-atlas",
      tier_bands: JSON.stringify(FOUNDER_BANDS),
      usage_share_bps: 0,
    });
  }
  // The usage-share policies — dev-apollo's tokens split 12% of the
  // pool; dev-mono's gateway row is the HELD-row exercise (its negative
  // pool must never reach the pricer).
  for (const [developer, bps] of [
    ["dev-mono", 1500],
    ["dev-apollo", 1200],
  ] as const) {
    store.upsertDeveloperApiRoyaltyPolicy({
      developer_id: developer,
      royalty_mode: "usage_share",
      payee_id: "data-provider-atlas",
      tier_bands: "[]",
      usage_share_bps: bps,
    });
  }
  // The marketplace split policies of record — the founder band's two
  // anchors and its top. vscode_marketplace stays unregistered (the
  // fail-closed skip exercise).
  store.upsertDeveloperMarketplacePolicy({ marketplace: "apple_app_store", platform_share_bps: 1500 });
  store.upsertDeveloperMarketplacePolicy({ marketplace: "google_play", platform_share_bps: 1500 });
  store.upsertDeveloperMarketplacePolicy({ marketplace: "unity_asset_store", platform_share_bps: 3000 });
  // The co-authored package's verified Git contribution weightings —
  // nova 340 commits + 12 PRs, quasar 90 + 8. proj-helios-ui stays
  // unregistered (the fail-closed skip exercise).
  store.upsertDeveloperCopackageLeg({ package_id: "proj-lumina-core", maintainer_id: "dev-nova", commits: 340, pull_requests: 12 });
  store.upsertDeveloperCopackageLeg({ package_id: "proj-lumina-core", maintainer_id: "dev-quasar", commits: 90, pull_requests: 8 });
  // The SBOM components' maintainer ledgers — comp-unregistered stays
  // unregistered (the fail-closed skip exercise).
  store.upsertDeveloperDependencyLedger({
    component_id: "comp-left-pad",
    maintainer_payee_id: "maintainer-pad",
    micros_per_deploy: 1_000_000,
    micros_per_active_instance: 2_500_000,
  });
  store.upsertDeveloperDependencyLedger({
    component_id: "comp-tiny-uuid",
    maintainer_payee_id: "maintainer-uuid",
    micros_per_deploy: 200_000,
    micros_per_active_instance: 500_000,
  });
  // The white-label deal of record — $0.25/seat, $1.00/deployment, a
  // $15.00 monthly guarantee, 10% overage royalty to the SDK owner.
  store.upsertDeveloperWhitelabelDeal({
    sdk_package_hash: "sha256:orbit-sdk-v2",
    owner_payee_id: "sdk-owner-orbit",
    seat_micros_per_seat: 25_000_000,
    deployment_micros_per_deployment: 100_000_000,
    minimum_monthly_guarantee_cents: 1500,
    overage_royalty_bps: 1000,
  });
  // The tool settlement policies of record — payment_action stays
  // unregistered (the fail-closed skip exercise).
  store.upsertDeveloperToolPolicy({
    tool_id: "web_search",
    builder_payee_id: "tool-builder-scout",
    micros_per_call: 400_000,
    builder_share_bps: 9500,
  });
  store.upsertDeveloperToolPolicy({
    tool_id: "database_query",
    builder_payee_id: "tool-builder-quest",
    micros_per_call: 200_000,
    builder_share_bps: 9000,
  });
}

/** Parses the eight senders' checked-in fixtures. */
function parseFixtures(): ParsedStatementLine[] {
  return [
    "developer_gateway_usage.csv",
    "developer_sdk_initializations.csv",
    "developer_usage_billing_tokens.csv",
    "developer_marketplace_sales.csv",
    "developer_copackage_revenue.csv",
    "developer_sbom_scans.csv",
    "developer_whitelabel_licenses.csv",
    "developer_agent_tool_calls.csv",
  ].flatMap((name) => parseCsv(loadFixture(name)));
}

describe("the developer lane's full pass over the eight senders", () => {
  it("commits every ledger with the exact founder math and advances the walks", async () => {
    const store = new InMemoryStore();
    registerPolicies(store);

    // 11 realizing rows (4 gateway + 3 SDK + 4 tokens): 11
    // realizations (2 held negative), 5 micro-royalties (6 fail-closed
    // skips: the two held rows' usage-share pools and the per-call
    // policies' call-free SDK/token rows). 4 marketplace rows: 3 splits
    // (1 no-policy skip).
    // 4 co-package rows: 2 splits (2 no-weighting skips). 3 SBOM rows:
    // 2 fees (1 no-ledger skip). 2 license rows: 2 settlements. 3
    // tool-call rows: 2 settlements (1 no-policy skip). Nothing
    // replayed.
    const counts = await writeDeveloperRowsToStore(store, parseFixtures());

    expect(counts.realizationWritten).toBe(11);
    expect(counts.realizationReplayed).toBe(0);
    expect(counts.realizationHeldNegativeNet).toBe(2);
    expect(counts.microRoyaltiesWritten).toBe(5);
    expect(counts.microRoyaltiesReplayed).toBe(0);
    expect(counts.microRoyaltiesSkippedNoPolicy).toBe(6);
    expect(counts.marketplaceSplitsWritten).toBe(3);
    expect(counts.marketplaceSplitsReplayed).toBe(0);
    expect(counts.marketplaceSkippedNoPolicy).toBe(1);
    expect(counts.copackageSplitsWritten).toBe(2);
    expect(counts.copackageSplitsReplayed).toBe(0);
    expect(counts.copackageSkippedNoLegs).toBe(2);
    expect(counts.dependencyFeesWritten).toBe(2);
    expect(counts.dependencyFeesReplayed).toBe(0);
    expect(counts.dependencySkippedNoLedger).toBe(1);
    expect(counts.whitelabelSettlementsWritten).toBe(2);
    expect(counts.whitelabelSettlementsReplayed).toBe(0);
    expect(counts.whitelabelSkippedNoDeal).toBe(0);
    expect(counts.toolCallSettlementsWritten).toBe(2);
    expect(counts.toolCallSettlementsReplayed).toBe(0);
    expect(counts.toolCallSkippedNoPolicy).toBe(1);

    // The pass's money of record, exact to the cent (the two held
    // negative pools are recorded, so they sum in):
    // pools 425000 + 204688 + 106423 − 10150 (held) + 0 + 21750 − 1000
    //   (held) + 65272 + 26970 + 7691 + 3663 = 850307;
    // royalties 19000 + 15000 (the tier walk, third band from the
    //   1M position) + 14000 + 922 + 439 (the usage shares);
    // marketplace 15000 + 10500 + 7500 platform, 85000 + 59500 + 17500
    //   developer net (the VS Code row split nowhere — no policy);
    // co-package 400000 + 100000 (largest-remainder exact);
    // dependency 1005 + 3 (the unregistered component's scan priced
    //   nowhere);
    // white-label recoupment 1000 + 500, overage royalty 150;
    // tool calls 456 + 144 builder, 24 + 16 platform.
    expect(counts.netCodeUsagePoolCents).toBe(850_307);
    expect(counts.microRoyaltyCents).toBe(49_361);
    expect(counts.marketplacePlatformCents).toBe(33_000);
    expect(counts.marketplaceDeveloperNetCents).toBe(162_000);
    expect(counts.copackageAllocatedCents).toBe(500_000);
    expect(counts.dependencyFeeCents).toBe(1_008);
    expect(counts.whitelabelRecoupedCents).toBe(1_500);
    expect(counts.whitelabelOverageRoyaltyCents).toBe(150);
    expect(counts.toolCallBuilderCents).toBe(600);
    expect(counts.toolCallPlatformCents).toBe(40);

    const lines = parseFixtures();

    // THE NET API REALIZATION — exact to the cent on the usage row's own
    // figures: 5000.00 − 500.00 − 150.00 − 100.00 = 4250.00.
    const gateway1 = findDetail(lines, "gateway_usage", "GW-2026-03-0001");
    const realization1 = await store.getDeveloperRealizationApplication(
      developerRowEventId("realization", gateway1),
    );
    expect(realization1).toMatchObject({
      feed: "gateway_usage",
      developer_id: "dev-nova",
      api_endpoint_id: "ep-nova-1",
      sdk_package_hash: "sha256:nova-sdk-v3",
      period: "2026-03",
      currency: "USD",
      gross_api_transaction_revenue_cents: 500_000,
      cloud_infrastructure_hosting_base_cents: 50_000,
      payment_processing_gate_cut_cents: 15_000,
      enterprise_sla_reserve_cents: 10_000,
      net_code_usage_pool_cents: 425_000,
      verdict: "paid",
    });

    // THE NEGATIVE-NET HOLD — the deduction legs exceeded the gross
    // (400.00 − 500.00 − 1.50 = −101.50): recorded visible, the money
    // pauses, never drops, never guesses into a route.
    const gateway4 = findDetail(lines, "gateway_usage", "GW-2026-03-0004");
    const realization4 = await store.getDeveloperRealizationApplication(
      developerRowEventId("realization", gateway4),
    );
    expect(realization4).toMatchObject({
      developer_id: "dev-mono",
      net_code_usage_pool_cents: -10_150,
      verdict: "held_negative_net",
    });

    // THE TIER WALK — the founder's $0.0001 per call: the row's million
    // calls cross the 100K boundary, 100000 × $0.0001 + 900000 × $0.0002
    // = $190.00, and the (developer, month) tracker is the position.
    const royalty1 = await store.getDeveloperApiMicroRoyalty(
      developerRowEventId("royalty", gateway1),
    );
    expect(royalty1).toMatchObject({
      developer_id: "dev-nova",
      royalty_mode: "per_call",
      api_calls: 1_000_000,
      royalty_cents: 19_000,
      monthly_calls_before: 0,
      monthly_calls_after: 1_000_000,
    });
    const tierLegs1 = JSON.parse(royalty1?.tier_legs ?? "[]") as {
      band_calls: number;
      band_from: number;
      band_to: number | null;
      micros_per_call: number;
      band_payout_micros: number;
    }[];
    expect(tierLegs1).toEqual([
      {
        band_from: 0,
        band_to: 100_000,
        band_calls: 100_000,
        micros_per_call: 10_000,
        band_payout_micros: 1_000_000_000,
      },
      {
        band_from: 100_000,
        band_to: 1_000_000,
        band_calls: 900_000,
        micros_per_call: 20_000,
        band_payout_micros: 18_000_000_000,
      },
    ]);

    // CUMULATIVE MONTHLY TRACKING — the same developer's second gateway
    // (a different endpoint, same month) prices from the tracker's
    // position: 1,000,000 sits at the END of the second band, so its
    // 500000 calls walk the third tier: 500000 × $0.0003 = $150.00.
    const gateway3 = findDetail(lines, "gateway_usage", "GW-2026-03-0003");
    const royalty3 = await store.getDeveloperApiMicroRoyalty(
      developerRowEventId("royalty", gateway3),
    );
    expect(royalty3).toMatchObject({
      api_calls: 500_000,
      royalty_cents: 15_000,
      monthly_calls_before: 1_000_000,
      monthly_calls_after: 1_500_000,
    });
    const tracker = await store.getDeveloperApiCallMonth("dev-nova", "2026-03");
    expect(tracker?.cumulative_calls).toBe(1_500_000);

    // THE USAGE-SHARE ROYALTY — the pool's bps, floored: 7691 × 12% =
    // 922.92 → 922.
    const token3 = findDetail(lines, "usage_billing_token", "TOK-2026-03-0003");
    const royaltyTok3 = await store.getDeveloperApiMicroRoyalty(
      developerRowEventId("royalty", token3),
    );
    expect(royaltyTok3).toMatchObject({
      royalty_mode: "usage_share",
      usage_share_bps: 1200,
      royalty_basis_cents: 7_691,
      royalty_cents: 922,
    });

    // THE MARKETPLACE SPLIT — the 15% anchor deducts automatically, the
    // net routes to the developer: 1000.00 → 150.00 + 850.00.
    const sale1 = findDetail(lines, "marketplace_sale", "MKT-2026-03-0001");
    const split1 = await store.getDeveloperMarketplaceSplit(
      developerRowEventId("marketplace", sale1),
    );
    expect(split1).toMatchObject({
      marketplace: "apple_app_store",
      platform_share_bps: 1500,
      gross_sale_cents: 100_000,
      platform_cents: 15_000,
      developer_net_cents: 85_000,
    });
    // The 30% top of the founder band: 250.00 → 75.00 + 175.00.
    const sale3 = findDetail(lines, "marketplace_sale", "MKT-2026-03-0003");
    const split3 = await store.getDeveloperMarketplaceSplit(
      developerRowEventId("marketplace", sale3),
    );
    expect(split3).toMatchObject({
      platform_share_bps: 3000,
      platform_cents: 7_500,
      developer_net_cents: 17_500,
    });

    // THE CO-PACKAGE SPLIT — commit/PR weightings, largest-remainder
    // exact: the 4000.00 pot splits 352:98 units → 3128.89 + 871.11,
    // floored 3128 + 871, the dust cent to the largest remainder.
    const copkg1 = findDetail(lines, "copackage_revenue", "CPK-2026-03-0001");
    const coSplit1 = await store.getDeveloperCopackageSplit(
      developerRowEventId("copackage", copkg1),
    );
    expect(JSON.parse(coSplit1?.split_legs ?? "[]")).toEqual([
      { maintainer_id: "dev-nova", commits: 340, pull_requests: 12, allocated_cents: 312_889 },
      { maintainer_id: "dev-quasar", commits: 90, pull_requests: 8, allocated_cents: 87_111 },
    ]);
    expect(coSplit1?.allocated_total_cents).toBe(400_000);
    // The second pot's dust cent routes to the larger fractional
    // remainder (quasar's): 782.22 + 217.78 → 78222 + 21778.
    const copkg2 = findDetail(lines, "copackage_revenue", "CPK-2026-03-0002");
    const coSplit2 = await store.getDeveloperCopackageSplit(
      developerRowEventId("copackage", copkg2),
    );
    expect(JSON.parse(coSplit2?.split_legs ?? "[]")).toEqual([
      { maintainer_id: "dev-nova", commits: 340, pull_requests: 12, allocated_cents: 78_222 },
      { maintainer_id: "dev-quasar", commits: 90, pull_requests: 8, allocated_cents: 21_778 },
    ]);

    // THE SBOM DEPENDENCY MICRO-FEES — per-deploy and per-instance
    // accrual off the scan's own counts: 1000 × $0.01 + 2 × $0.025 =
    // $10.05.
    const scan1 = findDetail(lines, "sbom_scan", "SBM-2026-03-0001");
    const fee1 = await store.getDeveloperDependencyFee(
      developerRowEventId("dependency", scan1),
    );
    expect(fee1).toMatchObject({
      component_id: "comp-left-pad",
      maintainer_payee_id: "maintainer-pad",
      deploy_count: 1000,
      active_instances: 2,
      fee_cents: 1_005,
    });

    // THE WHITE-LABEL MMG RECOUPMENT — the month's seats accrue $10.00
    // of the $15.00 guarantee (recouped 1000, overage 0); the
    // deployments then cross it: recouped 500, overage 1500, and the
    // 10% overage royalty routes $1.50 to the SDK owner.
    const license1 = findDetail(lines, "whitelabel_license", "WHL-2026-03-0001");
    const settlement1 = await store.getDeveloperWhitelabelLicense(
      developerRowEventId("whitelabel", license1),
    );
    expect(settlement1).toMatchObject({
      event_kind: "seat",
      usage_cents: 1_000,
      monthly_usage_before_cents: 0,
      monthly_usage_after_cents: 1_000,
      mmg_cents: 1500,
      recouped_cents: 1_000,
      overage_cents: 0,
      overage_royalty_cents: 0,
    });
    const license2 = findDetail(lines, "whitelabel_license", "WHL-2026-03-0002");
    const settlement2 = await store.getDeveloperWhitelabelLicense(
      developerRowEventId("whitelabel", license2),
    );
    expect(settlement2).toMatchObject({
      event_kind: "deployment",
      usage_cents: 2_000,
      monthly_usage_before_cents: 1_000,
      monthly_usage_after_cents: 3_000,
      recouped_cents: 500,
      overage_cents: 1_500,
      overage_royalty_bps: 1000,
      overage_royalty_cents: 150,
    });
    const usageMonth = await store.getDeveloperWhitelabelUsageMonth(
      "sha256:orbit-sdk-v2",
      "ent-nimbus-games",
      "2026-03",
    );
    expect(usageMonth?.cumulative_usage_cents).toBe(3_000);

    // THE AGENT TOOL-CALL MICRO-SETTLEMENT — the batch prices per call
    // and splits instantly: 1200 × $0.004 = $4.80 → builder 95% =
    // $4.56, platform $0.24.
    const batch1 = findDetail(lines, "agent_tool_call", "ATC-2026-03-0001");
    const tool1 = await store.getDeveloperToolCallApplication(
      developerRowEventId("toolcall", batch1),
    );
    expect(tool1).toMatchObject({
      tool_id: "web_search",
      agent_id: "agent-scout-7",
      call_count: 1200,
      settlement_cents: 480,
      builder_share_bps: 9500,
      builder_cents: 456,
      platform_cents: 24,
    });
  });

  it("replays the same sheets as counted no-ops with zero new money", async () => {
    const store = new InMemoryStore();
    registerPolicies(store);
    const lines = parseFixtures();
    await writeDeveloperRowsToStore(store, lines);
    const counts = await writeDeveloperRowsToStore(store, lines);

    // Every application's replay guard caught its re-shipped row —
    // counted no-ops, and the money of record never moved.
    expect(counts.realizationWritten).toBe(0);
    expect(counts.realizationReplayed).toBe(11);
    expect(counts.realizationHeldNegativeNet).toBe(0);
    expect(counts.microRoyaltiesWritten).toBe(0);
    expect(counts.microRoyaltiesReplayed).toBe(5);
    expect(counts.microRoyaltiesSkippedNoPolicy).toBe(6);
    expect(counts.marketplaceSplitsWritten).toBe(0);
    expect(counts.marketplaceSplitsReplayed).toBe(3);
    expect(counts.marketplaceSkippedNoPolicy).toBe(1);
    expect(counts.copackageSplitsWritten).toBe(0);
    expect(counts.copackageSplitsReplayed).toBe(2);
    expect(counts.copackageSkippedNoLegs).toBe(2);
    expect(counts.dependencyFeesWritten).toBe(0);
    expect(counts.dependencyFeesReplayed).toBe(2);
    expect(counts.dependencySkippedNoLedger).toBe(1);
    expect(counts.whitelabelSettlementsWritten).toBe(0);
    expect(counts.whitelabelSettlementsReplayed).toBe(2);
    expect(counts.toolCallSettlementsWritten).toBe(0);
    expect(counts.toolCallSettlementsReplayed).toBe(2);
    expect(counts.toolCallSkippedNoPolicy).toBe(1);

    // The skips re-walk fail-closed on every pass (no policy, no split —
    // the counted skip is honest on every replay).
    expect(counts.netCodeUsagePoolCents).toBe(0);
    expect(counts.microRoyaltyCents).toBe(0);
    expect(counts.marketplacePlatformCents).toBe(0);
    expect(counts.copackageAllocatedCents).toBe(0);
    expect(counts.dependencyFeeCents).toBe(0);
    expect(counts.whitelabelRecoupedCents).toBe(0);
    expect(counts.whitelabelOverageRoyaltyCents).toBe(0);
    expect(counts.toolCallBuilderCents).toBe(0);
  });
});

describe("the developer lane's calculators", () => {
  it("prices the Net API Realization identity exactly and refuses hostile legs", () => {
    const exact = netApiRealizationCents({
      grossApiTransactionRevenueCents: 500_000,
      cloudInfrastructureHostingBaseCents: 50_000,
      paymentProcessingGateCutCents: 15_000,
      enterpriseSlaReserveCents: 10_000,
    });
    expect(exact.netCodeUsagePoolCents).toBe(425_000);
    // The identity pins: hosting + gate cut + SLA + net === gross.
    expect(
      50_000 + 15_000 + 10_000 + exact.netCodeUsagePoolCents,
    ).toBe(exact.grossApiTransactionRevenueCents);
    // A negative net records honestly (the caller holds it).
    expect(
      netApiRealizationCents({
        grossApiTransactionRevenueCents: 40_000,
        cloudInfrastructureHostingBaseCents: 50_000,
        paymentProcessingGateCutCents: 150,
        enterpriseSlaReserveCents: 0,
      }).netCodeUsagePoolCents,
    ).toBe(-10_150);
    expect(() =>
      netApiRealizationCents({
        grossApiTransactionRevenueCents: -1,
        cloudInfrastructureHostingBaseCents: 0,
        paymentProcessingGateCutCents: 0,
        enterpriseSlaReserveCents: 0,
      }),
    ).toThrow(/developer_realization_invalid_leg/);
  });

  it("prices the tier walk's boundary calls exactly", () => {
    const bands = FOUNDER_BANDS;
    // The 100,000th call prices at the FIRST band's rate (the boundary
    // call is the band's last, not the next band's first).
    const atBoundary = developerTierWalk({ calls: 100_000, cumulativeBefore: 0, bands });
    expect(atBoundary.payoutMicros).toBe(1_000_000_000n);
    // The 100,001st call prices at the SECOND band's rate.
    const pastBoundary = developerTierWalk({ calls: 100_001, cumulativeBefore: 0, bands });
    expect(pastBoundary.payoutMicros).toBe(1_000_020_000n);
    expect(pastBoundary.legs).toHaveLength(2);
    // The 1,000,000-call month: 100000 × $0.0001 + 900000 × $0.0002.
    const tierTwo = developerTierWalk({ calls: 1_000_000, cumulativeBefore: 0, bands });
    expect(tierTwo.payoutMicros).toBe(19_000_000_000n);
    // A row straddling the 1M boundary splits exactly.
    const straddle = developerTierWalk({ calls: 2, cumulativeBefore: 999_999, bands });
    expect(straddle.payoutMicros).toBe(50_000n);
    expect(straddle.legs).toEqual([
      {
        band_from: 100_000,
        band_to: 1_000_000,
        micros_per_call: 20_000,
        band_calls: 1,
        band_payout_micros: 20_000,
      },
      {
        band_from: 1_000_000,
        band_to: 10_000_000,
        micros_per_call: 30_000,
        band_calls: 1,
        band_payout_micros: 30_000,
      },
    ]);
    expect(() => developerTierWalk({ calls: 0, cumulativeBefore: 0, bands })).toThrow(
      /developer_walk_invalid_calls/,
    );
  });

  it("prices the usage-share royalty and the marketplace band exactly", () => {
    expect(usageShareRoyaltyCents({ netCodeUsagePoolCents: 7_691, usageShareBps: 1200 })).toBe(922);
    expect(() =>
      usageShareRoyaltyCents({ netCodeUsagePoolCents: -1, usageShareBps: 1200 }),
    ).toThrow(/developer_usage_share_invalid_pool/);

    // The founder band's anchors: 15% and 30% of the same gross.
    const low = marketplaceSplitCents({ grossSaleCents: 100_000, platformShareBps: 1500 });
    expect(low).toEqual({ platformCents: 15_000, developerNetCents: 85_000 });
    const high = marketplaceSplitCents({ grossSaleCents: 100_000, platformShareBps: 3000 });
    expect(high).toEqual({ platformCents: 30_000, developerNetCents: 70_000 });
    // Sub-cent platform shares floor (never round up) and the legs
    // always conserve the gross.
    const dust = marketplaceSplitCents({ grossSaleCents: 3, platformShareBps: 1500 });
    expect(dust.platformCents).toBe(0);
    expect(dust.platformCents + dust.developerNetCents).toBe(3);
  });

  it("splits co-package pots by commit weightings, conserving exactly", () => {
    const split = copackageSplitCents({
      potCents: 100,
      legs: [
        { maintainer_id: "a", commits: 1, pull_requests: 0 },
        { maintainer_id: "b", commits: 2, pull_requests: 0 },
      ],
    });
    // 100 × 1/3 and 100 × 2/3 floor to 33 + 66; the dust cent routes to
    // the larger fractional remainder.
    expect(split.legs.map((leg) => leg.allocated_cents)).toEqual([33, 67]);
    expect(split.allocatedTotalCents).toBe(100);
    expect(() =>
      copackageSplitCents({
        potCents: 100,
        legs: [{ maintainer_id: "a", commits: 0, pull_requests: 0 }],
      }),
    ).toThrow(/developer_copackage_no_weightings/);
  });

  it("accrues SBOM micro-fees bigint-exact", () => {
    const fee = dependencyFeeMicros({
      deployCount: 1000,
      activeInstances: 2,
      microsPerDeploy: 1_000_000,
      microsPerActiveInstance: 2_500_000,
    });
    expect(fee).toBe(1_005_000_000n);
    expect(() =>
      dependencyFeeMicros({
        deployCount: -1,
        activeInstances: 0,
        microsPerDeploy: 0,
        microsPerActiveInstance: 0,
      }),
    ).toThrow(/developer_dependency_invalid_deploys/);
  });

  it("recoups the MMG against the month's position and routes the overage", () => {
    // Deep under the guarantee: every usage cent recoups.
    const under = whitelabelLicenseSettlement({
      quantity: 40,
      rateMicros: 25_000_000,
      monthlyUsageBeforeCents: 0,
      mmgCents: 1500,
      overageRoyaltyBps: 1000,
    });
    expect(under).toMatchObject({
      usageCents: 1_000,
      monthlyUsageAfterCents: 1_000,
      recoupedCents: 1_000,
      overageCents: 0,
      overageRoyaltyCents: 0,
    });
    // Crossing the guarantee mid-month: the recoupment stops AT the
    // MMG, the residual is the overage, and the owner's royalty floors
    // off the overage.
    const over = whitelabelLicenseSettlement({
      quantity: 20,
      rateMicros: 100_000_000,
      monthlyUsageBeforeCents: 1_000,
      mmgCents: 1500,
      overageRoyaltyBps: 1000,
    });
    expect(over).toMatchObject({
      usageCents: 2_000,
      monthlyUsageAfterCents: 3_000,
      recoupedCents: 500,
      overageCents: 1_500,
      overageRoyaltyCents: 150,
    });
    // Already past the guarantee: nothing recoups, everything overages.
    const past = whitelabelLicenseSettlement({
      quantity: 1,
      rateMicros: 100_000_000,
      monthlyUsageBeforeCents: 1500,
      mmgCents: 1500,
      overageRoyaltyBps: 1000,
    });
    expect(past).toMatchObject({ recoupedCents: 0, overageCents: 100, overageRoyaltyCents: 10 });
  });

  it("settles agent tool-call batches with conserving splits", () => {
    const split = agentToolCallSplit({
      callCount: 1200,
      microsPerCall: 400_000,
      builderShareBps: 9500,
    });
    expect(split.settlementCents).toBe(480);
    expect(split.builderCents).toBe(456);
    expect(split.platformCents).toBe(24);
    expect(split.builderCents + split.platformCents).toBe(split.settlementCents);
    // A sub-cent pot settles zero exactly — never a rounded-up cent.
    const dust = agentToolCallSplit({
      callCount: 1,
      microsPerCall: 1,
      builderShareBps: 9500,
    });
    expect(dust.settlementCents).toBe(0);
    expect(dust.builderCents).toBe(0);
    expect(dust.platformCents).toBe(0);
    expect(() =>
      agentToolCallSplit({ callCount: 0, microsPerCall: 400_000, builderShareBps: 9500 }),
    ).toThrow(/developer_toolcall_invalid_calls/);
  });
});

describe("the developer lane's strict parsers", () => {
  it("dispatches every sender's sheet by its exact header", () => {
    const kinds = [
      ["developer_gateway_usage.csv", "developer_api_gateway_usage_csv"],
      ["developer_sdk_initializations.csv", "developer_sdk_initializations_csv"],
      ["developer_usage_billing_tokens.csv", "developer_usage_billing_tokens_csv"],
      ["developer_marketplace_sales.csv", "developer_marketplace_sales_csv"],
      ["developer_copackage_revenue.csv", "developer_copackage_revenue_csv"],
      ["developer_sbom_scans.csv", "developer_sbom_scans_csv"],
      ["developer_whitelabel_licenses.csv", "developer_whitelabel_licenses_csv"],
      ["developer_agent_tool_calls.csv", "developer_agent_tool_calls_csv"],
    ] as const;
    for (const [fixture, kind] of kinds) {
      const profile = dispatchStatementProfile(loadFixture(fixture));
      expect(profile?.kind).toBe(kind);
    }
  });

  it("rejects whole files whose layout or vocabulary drifts", () => {
    const fixture = loadFixture("developer_gateway_usage.csv");
    const headerLine = fixture.split("\n")[0] ?? "";

    // A reordered column is a different layout — no profile matches.
    const columns = headerLine.split(",");
    const swapped = [...columns];
    [swapped[1], swapped[2]] = [swapped[2] as string, swapped[1] as string];
    const reordered =
      swapped.join(",") + "\n" + fixture.split("\n").slice(1).join("\n");
    expect(dispatchStatementProfile(reordered)).toBeNull();

    // A cell outside its bounded vocabulary rejects the file.
    expect(() => parseCsv(fixture.replace("kong", "envoy"))).toThrow(/invalid_vocabulary/);
    expect(() =>
      parseCsv(loadFixture("developer_usage_billing_tokens.csv").replace("inference_token", "exposure_coin")),
    ).toThrow(/invalid_vocabulary/);
    // A marketplace outside the vocabulary rejects too.
    expect(() =>
      parseCsv(loadFixture("developer_marketplace_sales.csv").replace("apple_app_store", "sideload_shack")),
    ).toThrow(/invalid_vocabulary/);
  });

  it("rejects missing cells, negative money, zero-priced and call-free usage rows", () => {
    const fixture = loadFixture("developer_gateway_usage.csv");
    const rows = fixture.split("\n");

    // A short row's required cell is missing — the file rejects.
    const shortRow = rows[1]?.split(",").slice(0, -1).join(",") ?? "";
    expect(() => parseCsv([...rows.slice(0, 1), shortRow].join("\n"))).toThrow();

    // A negative money leg — a refund has no vocabulary on this lane.
    expect(() => parseCsv(fixture.replace("5000.00", "-5000.00"))).toThrow(/negative_money/);

    // A usage row pricing zero gross rejects (no royalty leg to walk).
    expect(() => parseCsv(fixture.replace("5000.00", "0.00"))).toThrow(
      /developer_row_prices_nothing/,
    );

    // A gateway row with zero calls rejects — nothing to price per call.
    expect(() => parseCsv(fixture.replace("1000000", "0"))).toThrow(
      /developer_row_counts_nothing/,
    );

    // A malformed period rejects at parse (the walk re-checks). The
    // comma anchors the hit to the trailing period cell — the bare
    // string also lives inside the row ids.
    expect(() => parseCsv(fixture.replace(",2026-03", ",2026/03"))).toThrow(/invalid_period/);
  });
});
