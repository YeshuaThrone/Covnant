/**
 * CVT recon worker — the developer lane's pure engine (PR 44, the founder
 * developer directive): the identity spaces, THE NET API REALIZATION
 * CALCULATOR (gross API transaction revenue − cloud infrastructure hosting
 * base − payment processing gate cut − enterprise service level agreement
 * reserves = the Net Code Usage Pool), the tiered developer micro-royalty
 * (the per-call tier walk on the cumulative monthly position and the
 * usage-share bps priced off the realized pool), the platform marketplace
 * split (the founder's 15–30% band deducting before the net 70–85% routes
 * to the developer), the co-authored package split (verified Git commit
 * and PR contribution weightings, largest-remainder exact), the SBOM
 * dependency micro-fees (per-deploy and per-active-instance), the
 * white-label SDK licensing settlement (MMG recoupment against the
 * month's cumulative usage, overage royalties to the SDK owner), and the
 * AI agent tool-calling micro-settlement split.
 *
 * Every function here is pure — no store, no I/O — and exact to the cent:
 * deductions and splits floor per leg (never round up — the house money
 * discipline), the calculators' identities hold on every input, and every
 * micro-royalty is bigint-exact statement micros floored into payable
 * cents. The queue writer consumes these; the profiles parse into them.
 */

import { createHash } from "node:crypto";

import type {
  DeveloperCopackageLeg,
  DeveloperTierBand,
} from "@/modules/developer/records";

/** The developer lane's statement senders — the eight strict layouts'
 * families. */
export type DeveloperSenderCode =
  | "gateway_usage"
  | "sdk_initialization"
  | "marketplace_sale"
  | "usage_billing_token"
  | "copackage_revenue"
  | "sbom_scan"
  | "whitelabel_license"
  | "agent_tool_call";

function developerFingerprint(...fields: readonly string[]): string {
  return createHash("sha256").update(fields.join("|")).digest("hex");
}

/**
 * The row's event id — one per (ledger, sender, developer, endpoint,
 * package, period, sender row id). The sender's row id of record is the
 * identity core: a re-shipped sheet replays as a counted no-op, and two
 * senders' sheets for the same developer stay distinct identities. The
 * ledger namespace rides the prefix — one source event can appear in
 * several ledgers (a gateway usage row walks the realization and royalty
 * ledgers) without colliding. Absent optional fields fingerprint as "".
 */
export function developerRowEventId(
  ledger:
    | "realization"
    | "royalty"
    | "marketplace"
    | "copackage"
    | "dependency"
    | "whitelabel"
    | "toolcall",
  detail: {
    sender: DeveloperSenderCode;
    developerId: string;
    apiEndpointId: string;
    sdkPackageHash: string;
    period: string;
    senderRowId: string;
  },
): string {
  return `developer:${ledger}:${detail.sender}:${developerFingerprint(
    detail.developerId,
    detail.apiEndpointId,
    detail.sdkPackageHash,
    detail.period,
    detail.senderRowId,
  )}`;
}

/** Floors micros to integer cents — the application ledgers' pricing pin
 * (cents = micros / 1,000,000, never rounded up). Accepts the micro
 * royalty's bigint natively. */
export function developerMicrosToCents(micros: number | bigint): number {
  return Math.floor(Number(micros) / 1_000_000);
}

/** The reporting period's shape of record (YYYY-MM) — the tracking is
 * monthly. */
export function isDeveloperPeriod(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

/** Floors a basis-points share of a cents amount — per-leg exact, never
 * rounds up (the founder's cent-exact canon). */
export function developerBpsShareCents(amountCents: number, bps: number): number {
  return Math.floor((amountCents * bps) / 10_000);
}

/**
 * THE NET API REALIZATION CALCULATOR (the founder directive's exact
 * identity, keyed on the row's developer_id, api_endpoint_id, and
 * sdk_package_hash columns — the identity legs ride the application):
 *
 *   Net Code Usage Pool =
 *     gross API transaction revenue
 *     − cloud infrastructure hosting base
 *     − payment processing gate cut
 *     − enterprise service level agreement reserves
 *
 * Every leg is a recorded money amount (the usage statement's own figures
 * — never a rate guess). The identity (hosting + gate cut + SLA reserves
 * + net === gross) pins the math. A deduction set larger than the gross
 * yields a negative net — the CALLER holds that application
 * (held_negative_net); this function records the arithmetic honestly
 * either way.
 */
export function netApiRealizationCents(input: {
  grossApiTransactionRevenueCents: number;
  cloudInfrastructureHostingBaseCents: number;
  paymentProcessingGateCutCents: number;
  enterpriseSlaReserveCents: number;
}): {
  grossApiTransactionRevenueCents: number;
  netCodeUsagePoolCents: number;
} {
  const legs = [
    input.grossApiTransactionRevenueCents,
    input.cloudInfrastructureHostingBaseCents,
    input.paymentProcessingGateCutCents,
    input.enterpriseSlaReserveCents,
  ];
  for (const leg of legs) {
    if (!Number.isInteger(leg) || leg < 0) {
      throw new Error(`developer_realization_invalid_leg:${leg}`);
    }
  }
  const netCodeUsagePoolCents =
    input.grossApiTransactionRevenueCents -
    input.cloudInfrastructureHostingBaseCents -
    input.paymentProcessingGateCutCents -
    input.enterpriseSlaReserveCents;
  return {
    grossApiTransactionRevenueCents: input.grossApiTransactionRevenueCents,
    netCodeUsagePoolCents,
  };
}

/**
 * THE PER-CALL TIER WALK — the row's API calls cross the (developer,
 * month) cumulative position, and the calls split across the tier bands
 * they occupy (the founder's $0.0001 per call scaling up by monthly
 * active developer tiers), each band's payout exactly band_calls × band
 * micros (bigint-exact, per-unit pricing — no remainder allocation):
 *
 *   band payout = band_calls × band_micros_per_call
 *
 * A row entirely inside the first band prices wholly at that band's rate;
 * a row straddling a boundary splits exactly — the cumulative position
 * tracks monthly calls across every call-bearing row of the month (the
 * tracker advances per developer, the founder's monthly active developer
 * tier). Requires calls > 0; the position must be non-negative.
 */
export function developerTierWalk(input: {
  calls: number;
  cumulativeBefore: number;
  bands: readonly DeveloperTierBand[];
}): {
  legs: {
    band_from: number;
    band_to: number | null;
    micros_per_call: number;
    band_calls: number;
    band_payout_micros: number;
  }[];
  payoutMicros: bigint;
  cumulativeAfter: number;
} {
  const { calls, cumulativeBefore, bands } = input;
  if (!Number.isInteger(calls) || calls <= 0) {
    throw new Error(`developer_walk_invalid_calls:${calls}`);
  }
  if (!Number.isInteger(cumulativeBefore) || cumulativeBefore < 0) {
    throw new Error(`developer_walk_invalid_position:${cumulativeBefore}`);
  }
  const cumulativeAfter = cumulativeBefore + calls;

  // The calls each band holds: band window ∩ (before, after].
  type BandSlot = { band: DeveloperTierBand; lower: number; calls: number };
  const slots: BandSlot[] = [];
  {
    let lower = 0;
    for (const band of bands) {
      const upper = band.up_to;
      const bandLow = Math.max(cumulativeBefore, lower);
      const bandHigh = upper === null ? cumulativeAfter : Math.min(cumulativeAfter, upper);
      slots.push({ band, lower, calls: Math.max(0, bandHigh - bandLow) });
      if (upper === null) break;
      lower = upper;
    }
  }

  const legs: {
    band_from: number;
    band_to: number | null;
    micros_per_call: number;
    band_calls: number;
    band_payout_micros: number;
  }[] = [];
  let payoutMicros = 0n;
  for (const slot of slots) {
    if (slot.calls <= 0) continue;
    const bandPayoutMicros = BigInt(slot.calls) * BigInt(slot.band.micros_per_call);
    legs.push({
      band_from: slot.lower,
      band_to: slot.band.up_to,
      micros_per_call: slot.band.micros_per_call,
      band_calls: slot.calls,
      band_payout_micros: Number(bandPayoutMicros),
    });
    payoutMicros += bandPayoutMicros;
  }

  return { legs, payoutMicros, cumulativeAfter };
}

/**
 * THE USAGE-SHARE ROYALTY — the usage-based split mode: the policy's bps
 * floor off the row's Net Code Usage Pool. A negative pool never reaches
 * this pricer (held rows skip fail-closed — never a negative royalty).
 */
export function usageShareRoyaltyCents(input: {
  netCodeUsagePoolCents: number;
  usageShareBps: number;
}): number {
  const { netCodeUsagePoolCents, usageShareBps } = input;
  if (!Number.isInteger(netCodeUsagePoolCents) || netCodeUsagePoolCents < 0) {
    throw new Error(`developer_usage_share_invalid_pool:${netCodeUsagePoolCents}`);
  }
  if (!Number.isInteger(usageShareBps) || usageShareBps < 0 || usageShareBps > 10_000) {
    throw new Error(`developer_usage_share_invalid_bps:${usageShareBps}`);
  }
  return developerBpsShareCents(netCodeUsagePoolCents, usageShareBps);
}

/**
 * THE PLATFORM MARKETPLACE SPLIT — the core platform's 15–30% revenue
 * share deducts automatically before the net 70–85% routes to the
 * independent plugin or SDK developer:
 *
 *   platform share   = floor(gross × platform bps / 10000)
 *   developer net    = gross − platform share
 *
 * The legs conserve the gross EXACTLY (the developer routes the residual;
 * the policy of record validates the bps within the founder band). A
 * gross below zero is hostile upstream; this function never sees one.
 */
export function marketplaceSplitCents(input: {
  grossSaleCents: number;
  platformShareBps: number;
}): { platformCents: number; developerNetCents: number } {
  const { grossSaleCents, platformShareBps } = input;
  if (!Number.isInteger(grossSaleCents) || grossSaleCents < 0) {
    throw new Error(`developer_marketplace_invalid_gross:${grossSaleCents}`);
  }
  if (!Number.isInteger(platformShareBps) || platformShareBps < 0 || platformShareBps > 10_000) {
    throw new Error(`developer_marketplace_invalid_bps:${platformShareBps}`);
  }
  const platformCents = developerBpsShareCents(grossSaleCents, platformShareBps);
  return {
    platformCents,
    developerNetCents: grossSaleCents - platformCents,
  };
}

/**
 * THE CO-AUTHORED PACKAGE SPLIT (largest-remainder exact) — incoming
 * subscription and sponsorship revenue divides across the co-maintainers'
 * verified Git contribution weightings: each maintainer's weighting units
 * are their commits plus pull requests, each leg floors pot × units /
 * total_units, then the leftover dust distributes one cent at a time to
 * the legs with the largest fractional remainders (ties break by the
 * legs' registration order). The legs' allocated shares conserve the pot
 * EXACTLY — the identity the split application pins.
 */
export function copackageSplitCents(input: {
  potCents: number;
  legs: readonly DeveloperCopackageLeg[];
}): { legs: { maintainer_id: string; commits: number; pull_requests: number; allocated_cents: number }[]; allocatedTotalCents: number } {
  const { potCents, legs } = input;
  if (!Number.isInteger(potCents) || potCents < 0) {
    throw new Error(`developer_copackage_invalid_pot:${potCents}`);
  }
  const totalUnits = legs.reduce((sum, leg) => sum + leg.commits + leg.pull_requests, 0);
  if (legs.length === 0 || totalUnits <= 0) {
    throw new Error("developer_copackage_no_weightings");
  }
  // Floor every leg off its exact weighting, track the fractional
  // remainder, then distribute the dust largest-remainder-first (ties by
  // registration order).
  const floored = legs.map((leg, index) => {
    const units = leg.commits + leg.pull_requests;
    const exact = (potCents * units) / totalUnits;
    return {
      index,
      maintainer_id: leg.maintainer_id,
      commits: leg.commits,
      pull_requests: leg.pull_requests,
      allocated: Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });
  const dust = potCents - floored.reduce((sum, leg) => sum + leg.allocated, 0);
  const byRemainder = [...floored].sort(
    (a, b) => b.remainder - a.remainder || a.index - b.index,
  );
  for (let index = 0; index < dust; index += 1) {
    const leg = byRemainder[index % byRemainder.length] as { allocated: number };
    leg.allocated += 1;
  }
  const splitLegs = floored.map((leg) => ({
    maintainer_id: leg.maintainer_id,
    commits: leg.commits,
    pull_requests: leg.pull_requests,
    allocated_cents: leg.allocated,
  }));
  const allocatedTotalCents = splitLegs.reduce((sum, leg) => sum + leg.allocated_cents, 0);
  if (allocatedTotalCents !== potCents) {
    throw new Error(
      `developer_copackage_not_conserving:${allocatedTotalCents} != ${potCents}`,
    );
  }
  return { legs: splitLegs, allocatedTotalCents };
}

/**
 * THE SBOM DEPENDENCY MICRO-FEE — the per-deploy and per-active-instance
 * micro-fees accrue bigint-exact off the scan's own counts (never a rate
 * guess), floored into payable cents by the caller.
 */
export function dependencyFeeMicros(input: {
  deployCount: number;
  activeInstances: number;
  microsPerDeploy: number;
  microsPerActiveInstance: number;
}): bigint {
  const { deployCount, activeInstances, microsPerDeploy, microsPerActiveInstance } = input;
  if (!Number.isInteger(deployCount) || deployCount < 0) {
    throw new Error(`developer_dependency_invalid_deploys:${deployCount}`);
  }
  if (!Number.isInteger(activeInstances) || activeInstances < 0) {
    throw new Error(`developer_dependency_invalid_instances:${activeInstances}`);
  }
  if (!Number.isInteger(microsPerDeploy) || microsPerDeploy < 0) {
    throw new Error(`developer_dependency_invalid_deploy_rate:${microsPerDeploy}`);
  }
  if (!Number.isInteger(microsPerActiveInstance) || microsPerActiveInstance < 0) {
    throw new Error(`developer_dependency_invalid_instance_rate:${microsPerActiveInstance}`);
  }
  return (
    BigInt(deployCount) * BigInt(microsPerDeploy) +
    BigInt(activeInstances) * BigInt(microsPerActiveInstance)
  );
}

/**
 * THE WHITE-LABEL SDK LICENSE SETTLEMENT — the enterprise seat or
 * deployment event accrues usage at the deal's own rates (bigint-exact
 * micros, floored into payable cents), the usage joins the month's
 * cumulative position, and the MINIMUM MONTHLY GUARANTEE RECOUPMENT
 * executes against it:
 *
 *   recouped = min(MMG, position + usage) − min(MMG, position)
 *   overage  = usage − recouped
 *   overage royalty = floor(overage × owner bps / 10000)
 *
 * The overage royalties route directly to the SDK owner; the recouped
 * leg settles the guarantee already paid. Every leg is non-negative — a
 * usage below zero is hostile upstream; this function never sees one.
 */
export function whitelabelLicenseSettlement(input: {
  quantity: number;
  rateMicros: number;
  monthlyUsageBeforeCents: number;
  mmgCents: number;
  overageRoyaltyBps: number;
}): {
  usageMicros: bigint;
  usageCents: number;
  monthlyUsageAfterCents: number;
  recoupedCents: number;
  overageCents: number;
  overageRoyaltyCents: number;
} {
  const { quantity, rateMicros, monthlyUsageBeforeCents, mmgCents, overageRoyaltyBps } = input;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`developer_whitelabel_invalid_quantity:${quantity}`);
  }
  if (!Number.isInteger(rateMicros) || rateMicros < 0) {
    throw new Error(`developer_whitelabel_invalid_rate:${rateMicros}`);
  }
  if (!Number.isInteger(monthlyUsageBeforeCents) || monthlyUsageBeforeCents < 0) {
    throw new Error(`developer_whitelabel_invalid_position:${monthlyUsageBeforeCents}`);
  }
  if (!Number.isInteger(mmgCents) || mmgCents < 0) {
    throw new Error(`developer_whitelabel_invalid_mmg:${mmgCents}`);
  }
  if (
    !Number.isInteger(overageRoyaltyBps) ||
    overageRoyaltyBps < 0 ||
    overageRoyaltyBps > 10_000
  ) {
    throw new Error(`developer_whitelabel_invalid_overage_bps:${overageRoyaltyBps}`);
  }
  const usageMicros = BigInt(quantity) * BigInt(rateMicros);
  const usageCents = developerMicrosToCents(usageMicros);
  const monthlyUsageAfterCents = monthlyUsageBeforeCents + usageCents;
  const recoupedCents =
    Math.min(mmgCents, monthlyUsageAfterCents) - Math.min(mmgCents, monthlyUsageBeforeCents);
  const overageCents = usageCents - recoupedCents;
  return {
    usageMicros,
    usageCents,
    monthlyUsageAfterCents,
    recoupedCents,
    overageCents,
    overageRoyaltyCents: developerBpsShareCents(overageCents, overageRoyaltyBps),
  };
}

/**
 * THE AI AGENT TOOL-CALLING MICRO-SETTLEMENT — an autonomous agent's paid
 * third-party tool calls price at the policy's per-call micros (bigint
 * exact), and the pot splits floor-exact between the tool builder's
 * ledger and the platform:
 *
 *   pot             = calls × micros_per_call (floored into cents)
 *   builder share   = floor(pot × builder bps / 10000)
 *   platform share  = pot − builder share
 *
 * The legs conserve the pot EXACTLY — the identity the settlement
 * application pins.
 */
export function agentToolCallSplit(input: {
  callCount: number;
  microsPerCall: number;
  builderShareBps: number;
}): {
  settlementMicros: bigint;
  settlementCents: number;
  builderCents: number;
  platformCents: number;
} {
  const { callCount, microsPerCall, builderShareBps } = input;
  if (!Number.isInteger(callCount) || callCount <= 0) {
    throw new Error(`developer_toolcall_invalid_calls:${callCount}`);
  }
  if (!Number.isInteger(microsPerCall) || microsPerCall <= 0) {
    throw new Error(`developer_toolcall_invalid_rate:${microsPerCall}`);
  }
  if (!Number.isInteger(builderShareBps) || builderShareBps < 0 || builderShareBps > 10_000) {
    throw new Error(`developer_toolcall_invalid_bps:${builderShareBps}`);
  }
  const settlementMicros = BigInt(callCount) * BigInt(microsPerCall);
  const settlementCents = developerMicrosToCents(settlementMicros);
  const builderCents = developerBpsShareCents(settlementCents, builderShareBps);
  return {
    settlementMicros,
    settlementCents,
    builderCents,
    platformCents: settlementCents - builderCents,
  };
}
