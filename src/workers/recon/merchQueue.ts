/**
 * CVT recon worker — the merch lane's match_queue writer (PR 22, founder
 * merchandise directive).
 *
 * Four row kinds share one writer, in the fail-closed order every lane uses
 * (vault cross-reference first, then the idempotent queue write; the
 * posting pass reads the computed net off the outcome, never recomputes):
 *
 *   1. SHOPIFY DTC ORDER ROWS — the net realized profit equation computed
 *      HERE at write time from the row's recorded legs (gross − COGS×units
 *      − shipping − fulfillment − gateway − designer royalty), the gaming
 *      writer's fail-closed ordering. The addendum 8 columns ride the row:
 *      sku_id and the per-unit production COGS micros (the FIFO
 *      amortization key the collaboration waterfall's release consumes).
 *
 *   2. PRINTFUL/GELATO POD ROWS — the printing cost deducts from the gross
 *      FIRST; the collaborator's split share (bps of the after-printing
 *      remainder, floored) is what posts. The brand residual stays
 *      unposted — it is the brand's own inventory margin, not a payout
 *      obligation.
 *
 *   3. WHOLESALE CONSIGNMENT PAYOUT ROWS — the payout report's exact
 *      reconciliation is enforced at parse (the profiles); the net payout
 *      (the shrinkage allowance already offset against it) is what posts.
 *
 *   4. SQUARE POS SALE ROWS — the net (gross − processing fee) posts.
 *
 * The queue's UNIQUE event_id is the dedup arbiter across ingests — one
 * fulfillment event per (order, sku) in the content-derived `merch:*:`
 * spaces; a re-shipped dump replays as counted no-ops.
 *
 * Negative nets (a row whose cost legs exceed its gross) are WRITTEN but
 * dispositioned `held_negative_net` — visible, never dropped, never posted
 * (the webtoon held space's posture): a dump row that loses money is an
 * operator quarantine, never a negative holding credit.
 */

import type { MatchQueueRecord } from "@/modules/sdk/records";
import type { Store } from "@/lib/server/store";
import type { ParsedStatementLine } from "./records";
import { buildMatchQueueRow, isUniqueViolation, type VaultLookup } from "./matchQueue";
import {
  dtcNetRealizedProfitMicros,
  merchConsignmentEventId,
  merchDtcEventId,
  merchPodEventId,
  merchPosEventId,
  podSplitShareMicros,
  posNetMicros,
} from "./merch";
import { microsToWholeCents } from "./posting";

/** Per-line merch write outcome — the posting pass's input. */
export interface MerchLineOutcome {
  line: ParsedStatementLine;
  eventId: string;
  matchedCbtCode: string | null;
  /**
   * The row's disposition — the posting pass's discriminator:
   * `money` (a postable net), `held_negative_net` (the row's cost legs
   * exceed its gross — visible quarantine, never posts), `zero_net`
   * (sub-cent or zero net — integer cents or nothing, never rounded up).
   */
  disposition: "money" | "held_negative_net" | "zero_net";
  /** The integer-cent net the posting pass credits (0 when held/zero). */
  netCents: number;
  /** The total deductions recorded on the row, exact micros as text. */
  deductionMicros: string;
  /** Consignment rows: the shrinkage allowance that offset the payout. */
  shrinkageOffsetMicros: string | null;
}

/** Aggregate merch write counts — the completion result's merch block. */
export interface MerchWriteCounts {
  written: number;
  alreadyPresent: number;
  matched: number;
  unmatched: number;
  /** Rows written into the negative-net quarantine this pass. */
  heldNegativeNet: number;
  /** Sub-cent/zero nets — recorded, never posted. */
  zeroNet: number;
  /** Sum of production COGS (DTC) / printing cost (POD) deducted, micros. */
  cogsMicrosDeducted: bigint;
  /** Sum of consignment shrinkage allowances offset this pass, micros. */
  shrinkageOffsetMicros: bigint;
  lineOutcomes: MerchLineOutcome[];
}

/**
 * Writes one merch ingest's lines. The UPC is the lane's only vault
 * identifier kind (a physical product's barcode): first hit wins, a miss
 * stays honestly unmatched — and unattributable money never posts.
 */
export async function writeMerchLinesToMatchQueue(
  store: Store,
  ingestId: string,
  lines: readonly ParsedStatementLine[],
  vault: VaultLookup | null,
): Promise<MerchWriteCounts> {
  const counts: MerchWriteCounts = {
    written: 0,
    alreadyPresent: 0,
    matched: 0,
    unmatched: 0,
    heldNegativeNet: 0,
    zeroNet: 0,
    cogsMicrosDeducted: 0n,
    shrinkageOffsetMicros: 0n,
    lineOutcomes: [],
  };

  for (const line of lines) {
    const detail = line.merchDetail;
    if (detail === null) continue; // Not this lane's row — the dispatcher owns routing.

    let matchedCbtCode: string | null = null;
    const upc = line.identifiers["UPC"];
    if (vault !== null && upc !== undefined) {
      const asset = await vault.findByIdentifier("UPC", upc);
      if (asset !== null) matchedCbtCode = asset.cbtCode;
    }
    if (matchedCbtCode !== null) counts.matched += 1;
    else counts.unmatched += 1;

    // The net — computed HERE at write time from the row's own recorded
    // legs, exact bigint micros (the gaming writer's fail-closed ordering;
    // the posting pass reads the outcome, never recomputes).
    const eventId = merchEventId(detail);
    const { netMicros, deductionMicros } = merchNetMicros(detail, line.grossMicros);
    if (detail.kind === "dtc_order" || detail.kind === "pod_fulfillment") {
      const perUnit =
        detail.kind === "dtc_order"
          ? detail.unitProductionCogsMicros
          : detail.printingCostPerUnitMicros;
      counts.cogsMicrosDeducted += BigInt(perUnit) * BigInt(detail.units);
    }
    if (detail.kind === "consignment_payout") {
      counts.shrinkageOffsetMicros += BigInt(detail.shrinkageAllowanceMicros);
    }

    if (netMicros < 0n) {
      // A negative net — the cost legs outran the gross. Write the row
      // (visible, auditable), never post a negative holding credit.
      const row = merchRow(ingestId, line, eventId, detail, matchedCbtCode, deductionMicros);
      await insertOrCountReplay(store, row, counts);
      counts.heldNegativeNet += 1;
      counts.lineOutcomes.push({
        line,
        eventId,
        matchedCbtCode,
        disposition: "held_negative_net",
        netCents: 0,
        deductionMicros,
        shrinkageOffsetMicros:
          detail.kind === "consignment_payout" ? detail.shrinkageAllowanceMicros : null,
      });
      continue;
    }

    const netCents = microsToWholeCents(netMicros);
    const disposition = netCents === 0 ? "zero_net" : "money";
    if (disposition === "zero_net") counts.zeroNet += 1;

    const row = merchRow(ingestId, line, eventId, detail, matchedCbtCode, deductionMicros);
    await insertOrCountReplay(store, row, counts);
    counts.lineOutcomes.push({
      line,
      eventId,
      matchedCbtCode,
      disposition,
      netCents,
      deductionMicros,
      shrinkageOffsetMicros:
        detail.kind === "consignment_payout" ? detail.shrinkageAllowanceMicros : null,
    });
  }
  return counts;
}

/** The content-derived event id per merch row kind. */
function merchEventId(detail: NonNullable<ParsedStatementLine["merchDetail"]>): string {
  if (detail.kind === "dtc_order") return merchDtcEventId(detail);
  if (detail.kind === "pod_fulfillment") return merchPodEventId(detail);
  if (detail.kind === "consignment_payout") return merchConsignmentEventId(detail);
  return merchPosEventId(detail);
}

/** The row's net and recorded deduction, exact micros. */
function merchNetMicros(
  detail: NonNullable<ParsedStatementLine["merchDetail"]>,
  grossMicros: bigint,
): { netMicros: bigint; deductionMicros: string } {
  if (detail.kind === "dtc_order") {
    return {
      netMicros: dtcNetRealizedProfitMicros(detail, grossMicros),
      deductionMicros: (
        BigInt(detail.unitProductionCogsMicros) * BigInt(detail.units) +
        BigInt(detail.shippingFeeMicros) +
        BigInt(detail.fulfillmentFeeMicros) +
        BigInt(detail.gatewayFeeMicros) +
        BigInt(detail.designerRoyaltyMicros) * BigInt(detail.units)
      ).toString(),
    };
  }
  if (detail.kind === "pod_fulfillment") {
    // The collaborator's split share of the AFTER-printing remainder is
    // what posts; the printing cost is the recorded deduction.
    const { splitShareMicros } = podSplitShareMicros(detail, grossMicros);
    return {
      netMicros: splitShareMicros,
      deductionMicros: (
        BigInt(detail.printingCostPerUnitMicros) * BigInt(detail.units)
      ).toString(),
    };
  }
  if (detail.kind === "consignment_payout") {
    return {
      netMicros: BigInt(detail.reportedNetPayoutMicros),
      deductionMicros: (
        BigInt(detail.commissionMicros) + BigInt(detail.shrinkageAllowanceMicros)
      ).toString(),
    };
  }
  return {
    netMicros: posNetMicros(detail, grossMicros),
    deductionMicros: BigInt(detail.processingFeeMicros).toString(),
  };
}

/** The merch queue row — the generic builder plus the lane's overrides. */
function merchRow(
  ingestId: string,
  line: ParsedStatementLine,
  eventId: string,
  detail: NonNullable<ParsedStatementLine["merchDetail"]>,
  matchedCbtCode: string | null,
  deductionMicros: string,
): Omit<MatchQueueRecord, "id"> {
  const base = buildMatchQueueRow(
    line,
    eventId,
    `recon:merch:${line.profile}:line:${line.lineNumber}`,
  );
  // The addendum 8 columns: the physical inventory SKU and the per-unit
  // COGS the FIFO amortization keys on, plus the recorded deduction legs.
  const perUnitCogsMicros =
    detail.kind === "dtc_order"
      ? detail.unitProductionCogsMicros
      : detail.kind === "pod_fulfillment"
        ? detail.printingCostPerUnitMicros
        : null;
  return {
    ...base,
    matched_cbt_code: matchedCbtCode,
    sku_id: detail.skuId,
    cogs_per_unit_micros: perUnitCogsMicros,
    platform_commission_micros: deductionMicros,
    usage_unit: "units",
    usage_quantity:
      detail.kind === "consignment_payout"
        ? detail.unitsSold.toString()
        : detail.units.toString(),
  };
}

/** The idempotent insert — a unique violation is a replay (a counted
 * no-op), anything else throws (never swallowed). */
async function insertOrCountReplay(
  store: Store,
  row: Omit<MatchQueueRecord, "id">,
  counts: MerchWriteCounts,
): Promise<void> {
  try {
    await store.insertMatchQueueEntry(row);
    counts.written += 1;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    counts.alreadyPresent += 1;
  }
}
