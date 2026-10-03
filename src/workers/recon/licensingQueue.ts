/**
 * CVT recon worker — the brand-licensing lane's match_queue writer (PR 32,
 * the founder Net Sales + tiered royalties + sub-license cascade directive).
 *
 * Every statement row is ONE sale's sheet keyed on the addendum 12 triple
 * (license_id, category_code, territory_iso). The Net Sales realization is
 * computed HERE at write time from the row's recorded legs (the books
 * writer's fail-closed ordering; the cascade and posting passes read the
 * outcome, never recompute):
 *
 *   Net Licensed Sales = gross revenue − approved trade discounts
 *                        − returned goods allowances
 *                        − standard shipping and freight deductions
 *                        − value added taxes
 *
 * The deduction legs ride platform_commission_micros (the total recorded
 * deductions — the art/theatrical discipline for aggregate off-the-top
 * legs); the addendum 12 triple rides the row's license_id/category_code/
 * territory_iso columns (migration 0011 already ships them). sale_type
 * stays null: the licensing lane sells no catalog sale (the art
 * licensing/audit precedent), and migration 0011's match_queue sale_type
 * check admits only the music vocabulary.
 *
 * The queue's UNIQUE event_id is the dedup arbiter across ingests — one
 * event per sale identity in the content-derived `licensing:{sender}:`
 * spaces; a re-shipped report replays as counted no-ops.
 *
 * Negative Net Licensed Sales (a row whose deduction legs outrun its
 * gross) is WRITTEN but dispositioned `held_negative_net` — visible, never
 * dropped, never posted (the books/merch/art/theatrical held space's
 * posture): a row that loses money is an operator quarantine, never a
 * negative royalty basis.
 */

import type { MatchQueueRecord } from "@/modules/sdk/records";
import type { Store } from "@/lib/server/store";
import type { LicensingLineDetail, ParsedStatementLine } from "./records";
import { buildMatchQueueRow, isUniqueViolation } from "./matchQueue";
import {
  licensingRowEventId,
  netLicensedSalesCents,
  type LicensingNetSalesLegsMicros,
} from "./licensing";
import { licensingLegsMicros } from "./licensingProfiles";

/** The licensing row's write-time disposition — the cascade's input. */
export type LicensingDisposition = "money" | "held_negative_net" | "zero_net";

/** Per-line licensing write outcome — the cascade and posting passes' input. */
export interface LicensingLineOutcome {
  line: ParsedStatementLine;
  /** The content-derived `licensing:{sender}:` event id — the replay,
   * walk, and post identity. */
  eventId: string;
  disposition: LicensingDisposition;
  /** The write-time Net Licensed Sales, whole cents (0 on quarantined
   * dispositions) — the tier walk's basis, never recomputed. */
  netCents: number;
  /** The write-time Net Licensed Sales BEFORE whole-cent truncation,
   * exact micros text — the provenance of record (never recomputed). */
  netMicros: string;
  /** The row's recorded total deduction legs, verbatim micros text. */
  deductionMicros: string;
  detail: LicensingLineDetail;
}

/** Write counts for one licensing ingest — the honest completion report's inputs. */
export interface LicensingWriteCounts {
  written: number;
  alreadyPresent: number;
  /** Negative-net quarantine rows — visible, never walked, never posted. */
  heldNegativeNet: number;
  /** Sub-cent/zero net — recorded, never walked. */
  zeroNet: number;
  /** Rows written WITH the addendum 12 triple the lane's money hangs on —
   * every validated row carries one (the profiles require it), so the
   * lane's honest matched classification is total. */
  matched: number;
  unmatched: number;
  /** The deduction legs recorded across rows, verbatim (the Net Sales gap). */
  netSalesDeductionMicros: bigint;
  lineOutcomes: LicensingLineOutcome[];
}

/**
 * Writes the licensing lane's rows through the shared queue seam (all
 * three backends), one row per sale line, idempotent per event id: a
 * re-processed ingest is a counted no-op per row, never a duplicate.
 */
export async function writeLicensingLinesToMatchQueue(
  store: Store,
  ingestId: string,
  lines: readonly ParsedStatementLine[],
): Promise<LicensingWriteCounts> {
  const counts: LicensingWriteCounts = {
    written: 0,
    alreadyPresent: 0,
    heldNegativeNet: 0,
    zeroNet: 0,
    matched: 0,
    unmatched: 0,
    netSalesDeductionMicros: 0n,
    lineOutcomes: [],
  };

  for (const line of lines) {
    const detail = line.licensingDetail;
    if (detail === null || detail === undefined) continue; // Not this lane's row — the dispatcher owns routing.

    // The lane's matched/unmatched classification: the License ID is the
    // identity the money hangs on — every validated row carries one.
    counts.matched += 1;

    // THE NET SALES REALIZATION — computed HERE at write time from the
    // row's own recorded legs, exact bigint micros. The disposition keys
    // on the exact-cent net (the sheet's conservation identity); the
    // micros delta rides the outcome as provenance.
    const eventId = licensingRowEventId(detail);
    const legs = licensingLegsMicros(line);
    const realization = netLicensedSalesCents(legs);
    const deductionMicros = netSalesLegsDeductionMicros(legs);
    counts.netSalesDeductionMicros += BigInt(deductionMicros);

    const row = licensingRow(ingestId, line, eventId, detail, deductionMicros);
    await insertOrCountReplay(store, row, counts);

    if (realization.netSalesCents < 0) {
      // A negative net — the deduction legs outran the gross. Write the
      // row (visible, auditable), never walk or post a negative basis.
      counts.heldNegativeNet += 1;
      counts.lineOutcomes.push({
        line,
        eventId,
        disposition: "held_negative_net",
        netCents: 0,
        netMicros: (BigInt(detail.grossRevenueMicros) - BigInt(deductionMicros)).toString(),
        deductionMicros,
        detail,
      });
      continue;
    }

    const netMicros = BigInt(detail.grossRevenueMicros) - BigInt(deductionMicros);
    const disposition: LicensingDisposition =
      realization.netSalesCents === 0 ? "zero_net" : "money";
    if (disposition === "zero_net") counts.zeroNet += 1;
    counts.lineOutcomes.push({
      line,
      eventId,
      disposition,
      netCents: realization.netSalesCents,
      netMicros: netMicros.toString(),
      deductionMicros,
      detail,
    });
  }
  return counts;
}

/** The row's recorded deduction total, exact micros (the Net Sales legs). */
function netSalesLegsDeductionMicros(legs: LicensingNetSalesLegsMicros): string {
  return (
    legs.tradeDiscountMicros +
    legs.returnedGoodsMicros +
    legs.shippingFreightMicros +
    legs.vatMicros
  ).toString();
}

/** The licensing queue row — the generic builder plus the lane's overrides. */
function licensingRow(
  ingestId: string,
  line: ParsedStatementLine,
  eventId: string,
  detail: LicensingLineDetail,
  deductionMicros: string,
): Omit<MatchQueueRecord, "id"> {
  const base = buildMatchQueueRow(
    line,
    eventId,
    `recon:licensing:${line.profile}:line:${line.lineNumber}:${ingestId}`,
  );
  return {
    ...base,
    // The licensing lane sells no catalog sale — the art licensing/audit
    // precedent; migration 0011's check admits only the music vocabulary.
    sale_type: null,
    jurisdiction_code: null,
    artwork_id: null,
    cogs_per_unit_micros: null,
    // The total Net Sales deduction legs (trade discounts, returned goods,
    // shipping/freight, VAT) — the aggregate off-the-top discipline.
    platform_commission_micros: deductionMicros,
    usage_unit: "units",
    usage_quantity: "1",
    // THE ADDENDUM 12 TRIPLE — the deal-of-record key. The row's license
    // identity is what the royalty cascade's deal lookup keys on.
    license_id: detail.licenseId,
    category_code: detail.categoryCode,
    territory_iso: detail.territoryIso,
  } satisfies Omit<MatchQueueRecord, "id"> & {
    license_id: string;
    category_code: string;
    territory_iso: string;
  };
}

/** The idempotent insert — a unique violation is a replay (a counted
 * no-op), anything else throws (never swallowed). */
async function insertOrCountReplay(
  store: Store,
  row: Omit<MatchQueueRecord, "id">,
  counts: LicensingWriteCounts,
): Promise<void> {
  try {
    await store.insertMatchQueueEntry(row);
    counts.written += 1;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    counts.alreadyPresent += 1;
  }
}
