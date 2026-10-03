/**
 * CVT recon worker — the art-market lane's match_queue writer (PR 28, the
 * founder art directive: the ARR resale calculator + gallery and fabrication
 * waterfalls).
 *
 * Five row kinds share one writer, in the fail-closed order every lane uses
 * (the idempotent queue write first; the posting pass reads the computed
 * net off the outcome, never recomputes — the books writer's ordering):
 *
 *   1. GALLERY PRIMARY SALE ROWS — the founder equation computed HERE at
 *      write time from the row's recorded legs (sale price − gallery
 *      commission − production − framing − shipping COGS). The addendum 10
 *      artwork_id column and sale_type 'primary' ride the row, and the
 *      deduction legs ride cogs_per_unit_micros (the production COGS — the
 *      fabrication-cost key's books analogue) plus
 *      platform_commission_micros (the commission and the total recorded
 *      cost legs).
 *
 *   2. AUCTION SECONDARY RESALE ROWS — the statutory sliding-scale royalty
 *      computed HERE from the row's jurisdiction and recorded legs (the
 *      basis is the price net of cross-border VAT; the duty offsets the
 *      royalty before the release). sale_type 'secondary_resale' and the
 *      addendum 10 jurisdiction_code column ride the row; the tax legs ride
 *      platform_commission_micros. A non-ARR jurisdiction computes a zero
 *      royalty — disposition `no_arr`, recorded, never released.
 *
 *   3. PRINT SHOP EDITION SALE ROWS — the gross sale posts; the edition's
 *      fabrication pools (the cascade module) recoup downstream and the
 *      schedule splits the excess.
 *
 *   4. MUSEUM LICENSING ROWS — the license fee net of the agency's
 *      collection fee posts through the Don Ledger's holding seam in its
 *      own `art:licensing:` event space — never mixed with piece sales,
 *      never recouped from fabrication pools.
 *
 *   5. FOUNDATION/ESTATE AUDIT ROWS — attestation facts of record:
 *      disposition `audit_recorded`, written, never posted.
 *
 * The queue's UNIQUE event_id is the dedup arbiter across ingests — one
 * event per row identity in the content-derived `art:*:` spaces; a
 * re-shipped report replays as counted no-ops.
 *
 * Negative nets (a gallery row whose cost legs outrun its price) are
 * WRITTEN but dispositioned `held_negative_net` — visible, never dropped,
 * never posted (the books/merch held space's posture): a row that loses
 * money is an operator quarantine, never a negative holding credit.
 */

import type { MatchQueueRecord } from "@/modules/sdk/records";
import type { Store } from "@/lib/server/store";
import type { ArtLineDetail, ParsedStatementLine } from "./records";
import { buildMatchQueueRow, isUniqueViolation } from "./matchQueue";
import {
  arrNetReleaseMicros,
  artEventId,
  galleryPrimarySaleNetMicros,
  isArrJurisdictionCode,
  museumLicensingNetMicros,
} from "./art";
import { microsToWholeCents } from "./posting";

/** The art row's write-time disposition — the posting pass's input. */
export type ArtDisposition =
  | "money"
  | "held_negative_net"
  | "zero_net"
  | "no_arr"
  | "audit_recorded";

/** Per-line art write outcome — the posting and waterfall passes' input. */
export interface ArtLineOutcome {
  line: ParsedStatementLine;
  /** The content-derived `art:*:` event id — the replay and post identity. */
  eventId: string;
  disposition: ArtDisposition;
  /** The write-time net, whole cents (0 on quarantined dispositions). */
  netCents: number;
  /** The write-time net BEFORE whole-cent truncation, exact micros text —
   * the waterfall pass's recoupment basis (never recomputed). */
  netMicros: string;
  /** The row's recorded total deduction legs, verbatim micros text: the
   * commission and cost legs (gallery), the VAT+duty legs (resale), the
   * agency fee (licensing), "0" (print shop, audit). */
  deductionMicros: string;
  detail: ArtLineDetail;
}

/** Write counts for one art ingest — the honest completion report's inputs. */
export interface ArtWriteCounts {
  written: number;
  alreadyPresent: number;
  /** Negative-net quarantine rows — visible, never posted. */
  heldNegativeNet: number;
  /** Sub-cent/zero nets — recorded, never posted. */
  zeroNet: number;
  /** Secondary resales in non-ARR jurisdictions — recorded, never released. */
  noArr: number;
  /** Audit attestation rows — recorded, never posted. */
  auditRows: number;
  /** The duty legs recorded across resale rows, verbatim (the offset's size). */
  resaleDutyOffsetMicros: bigint;
  /** Rows written WITH the artwork identity the lane's money hangs on
   * (Artwork ID) vs rows written without one (cost-only audit rows) —
   * the lane's honest matched/unmatched classification. */
  matched: number;
  unmatched: number;
  lineOutcomes: ArtLineOutcome[];
}

/**
 * Writes the art lane's rows through the shared queue seam (all three
 * backends), one row per line, idempotent per event id: a re-processed
 * ingest is a counted no-op per row, never a duplicate.
 */
export async function writeArtLinesToMatchQueue(
  store: Store,
  ingestId: string,
  lines: readonly ParsedStatementLine[],
): Promise<ArtWriteCounts> {
  const counts: ArtWriteCounts = {
    written: 0,
    alreadyPresent: 0,
    heldNegativeNet: 0,
    zeroNet: 0,
    noArr: 0,
    auditRows: 0,
    resaleDutyOffsetMicros: 0n,
    matched: 0,
    unmatched: 0,
    lineOutcomes: [],
  };

  for (const line of lines) {
    const detail = line.artDetail;
    if (detail === null || detail === undefined) continue; // Not this lane's row — the dispatcher owns routing.

    // The lane's matched/unmatched classification: the Artwork ID is the
    // identity the money hangs on — audits may legitimately lack one.
    if (detail.kind !== "foundation_estate_audit" || detail.artworkId !== null) {
      counts.matched += 1;
    } else {
      counts.unmatched += 1;
    }

    // The net — computed HERE at write time from the row's own recorded
    // legs, exact bigint micros (the books writer's fail-closed ordering;
    // the posting pass reads the outcome, never recomputes).
    const eventId = artEventId(detail);
    const { netMicros, deductionMicros } = artNetMicros(detail);
    if (detail.kind === "auction_resale") {
      counts.resaleDutyOffsetMicros += BigInt(detail.importExportDutyMicros);
    }

    const row = artRow(ingestId, line, eventId, detail, deductionMicros);
    await insertOrCountReplay(store, row, counts);

    if (detail.kind === "foundation_estate_audit") {
      counts.auditRows += 1;
      counts.lineOutcomes.push({
        line,
        eventId,
        disposition: "audit_recorded",
        netCents: 0,
        netMicros: "0",
        deductionMicros,
        detail,
      });
      continue;
    }

    if (netMicros < 0n) {
      // A negative net — the cost legs outran the price. Write the row
      // (visible, auditable), never post a negative holding credit.
      counts.heldNegativeNet += 1;
      counts.lineOutcomes.push({
        line,
        eventId,
        disposition: "held_negative_net",
        netCents: 0,
        netMicros: netMicros.toString(),
        deductionMicros,
        detail,
      });
      continue;
    }

    const netCents = microsToWholeCents(netMicros);
    // A non-ARR resale's zero is a DIFFERENT fact from a sub-cent zero —
    // the jurisdiction has no statutory resale right, so nothing was ever
    // owed; disposition it in its own space (never confounded with money).
    const disposition: ArtDisposition =
      detail.kind === "auction_resale" && !isArrJurisdictionCode(detail.jurisdictionCode)
        ? "no_arr"
        : netCents === 0
          ? "zero_net"
          : "money";
    if (disposition === "zero_net") counts.zeroNet += 1;
    if (disposition === "no_arr") counts.noArr += 1;
    counts.lineOutcomes.push({
      line,
      eventId,
      disposition,
      netCents,
      netMicros: netMicros.toString(),
      deductionMicros,
      detail,
    });
  }
  return counts;
}

/** The row's net and recorded deduction, exact micros. */
function artNetMicros(detail: ArtLineDetail): {
  netMicros: bigint;
  deductionMicros: string;
} {
  if (detail.kind === "gallery_primary_sale") {
    const salePriceMicros = BigInt(detail.salePriceMicros);
    const commissionMicros =
      (salePriceMicros * BigInt(detail.galleryCommissionBps)) / 10_000n;
    const costLegsMicros =
      BigInt(detail.productionCogsMicros) +
      BigInt(detail.framingCogsMicros) +
      BigInt(detail.shippingCogsMicros);
    return {
      netMicros: galleryPrimarySaleNetMicros(detail),
      deductionMicros: (commissionMicros + costLegsMicros).toString(),
    };
  }
  if (detail.kind === "auction_resale") {
    // A non-ARR jurisdiction has no statutory resale right in this system —
    // the royalty is zero: recorded, never released (the row is honest).
    if (!isArrJurisdictionCode(detail.jurisdictionCode)) {
      return { netMicros: 0n, deductionMicros: "0" };
    }
    const { releaseMicros } = arrNetReleaseMicros(detail);
    const taxLegsMicros =
      BigInt(detail.crossBorderVatMicros) + BigInt(detail.importExportDutyMicros);
    return { netMicros: releaseMicros, deductionMicros: taxLegsMicros.toString() };
  }
  if (detail.kind === "print_shop_sale") {
    // The gross sale IS the net — the edition's fabrication pools recoup
    // downstream (the cascade's apply pass), never write-time deductions.
    return { netMicros: BigInt(detail.grossSaleMicros), deductionMicros: "0" };
  }
  if (detail.kind === "museum_licensing") {
    const { netMicros, agencyFeeMicros } = museumLicensingNetMicros(detail);
    return { netMicros, deductionMicros: agencyFeeMicros.toString() };
  }
  // Audit rows: attestation facts, never money (the disposition is final).
  return { netMicros: 0n, deductionMicros: "0" };
}

/** The art queue row — the generic builder plus the lane's overrides. */
function artRow(
  ingestId: string,
  line: ParsedStatementLine,
  eventId: string,
  detail: ArtLineDetail,
  deductionMicros: string,
): Omit<MatchQueueRecord, "id"> {
  const base = buildMatchQueueRow(
    line,
    eventId,
    `recon:art:${line.profile}:line:${line.lineNumber}`,
  );
  // The addendum 10 columns: the piece's artwork identity, the resale
  // jurisdiction, and the sale class — primary money (gallery, print shop),
  // secondary money (auction), and non-sale money (licensing, audit) never
  // share a sale_type value.
  const saleType =
    detail.kind === "museum_licensing" || detail.kind === "foundation_estate_audit"
      ? null
      : detail.kind === "auction_resale"
        ? "secondary_resale"
        : "primary";
  return {
    ...base,
    sale_type: saleType,
    // The resale-right jurisdiction of record — distinct from tax and
    // localization codes by addendum 10.
    jurisdiction_code: detail.kind === "auction_resale" ? detail.jurisdictionCode : null,
    artwork_id: detail.artworkId,
    // The production COGS — the fabrication-cost key's books analogue (the
    // merch addendum 8 discipline); the other rows carry no per-unit COGS.
    cogs_per_unit_micros:
      detail.kind === "gallery_primary_sale" ? detail.productionCogsMicros : null,
    platform_commission_micros: deductionMicros,
    usage_unit: usageUnit(detail),
    usage_quantity: usageQuantity(detail),
  };
}

/** The metering unit per row kind — pieces, edition copies, licenses, audits. */
function usageUnit(detail: ArtLineDetail): string | null {
  switch (detail.kind) {
    case "gallery_primary_sale":
      return "pieces";
    case "auction_resale":
      return "pieces";
    case "print_shop_sale":
      return "units";
    case "museum_licensing":
      return "licenses";
    case "foundation_estate_audit":
      return "audits";
  }
}

/** The metered usage amount as exact decimal text. */
function usageQuantity(detail: ArtLineDetail): string {
  switch (detail.kind) {
    case "print_shop_sale":
      return detail.units.toString();
    case "gallery_primary_sale":
    case "auction_resale":
    case "museum_licensing":
    case "foundation_estate_audit":
      return "1";
  }
}

/** The idempotent insert — a unique violation is a replay (a counted
 * no-op), anything else throws (never swallowed). */
async function insertOrCountReplay(
  store: Store,
  row: Omit<MatchQueueRecord, "id">,
  counts: ArtWriteCounts,
): Promise<void> {
  try {
    await store.insertMatchQueueEntry(row);
    counts.written += 1;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    counts.alreadyPresent += 1;
  }
}
