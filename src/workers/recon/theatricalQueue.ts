/**
 * CVT recon worker — the AGBOR box office lane's match_queue writer (PR 30,
 * the founder live-theater/touring/comedy directive).
 *
 * Every venue settlement row is ONE stop's sheet keyed on the addendum 11
 * triple (production_id, venue_id, show_date). The AGBOR equation is
 * computed HERE at write time from the row's recorded legs (the books
 * writer's fail-closed ordering; the posting pass reads the outcome, never
 * recomputes):
 *
 *   AGBOR = GBOR − local sales taxes − card processing fees
 *           − facility maintenance & FF&E fees − group sales discounts
 *
 * The deduction legs ride platform_commission_micros (the total recorded
 * deductions — the art lane's discipline for aggregate off-the-top legs);
 * the reconciliation triple rides the row's production_id/venue_id/
 * show_date columns. sale_type stays null: the live-event lane sells no
 * catalog sale (the art licensing/audit precedent), and migration 0011's
 * match_queue sale_type check admits only the music vocabulary.
 *
 * The queue's UNIQUE event_id is the dedup arbiter across ingests — one
 * event per stop identity in the content-derived `theatrical:{sender}:`
 * spaces; a re-shipped report replays as counted no-ops.
 *
 * Negative AGBOR (a stop whose deduction legs outrun its gross) is WRITTEN
 * but dispositioned `held_negative_net` — visible, never dropped, never
 * posted (the books/merch/art held space's posture): a row that loses money
 * is an operator quarantine, never a negative holding credit.
 */

import type { MatchQueueRecord } from "@/modules/sdk/records";
import type { Store } from "@/lib/server/store";
import type { ParsedStatementLine, TheatricalLineDetail } from "./records";
import { buildMatchQueueRow, isUniqueViolation } from "./matchQueue";
import { agborCents, theatricalStopEventId, type TheatricalStopLegsMicros } from "./theatrical";
import { theatricalLegsMicros } from "./theatricalProfiles";

/** The theatrical row's write-time disposition — the posting pass's input. */
export type TheatricalDisposition = "money" | "held_negative_net" | "zero_net";

/** Per-line theatrical write outcome — the posting and waterfall passes' input. */
export interface TheatricalLineOutcome {
  line: ParsedStatementLine;
  /** The content-derived `theatrical:{sender}:` event id — the replay and
   * post identity. */
  eventId: string;
  disposition: TheatricalDisposition;
  /** The write-time AGBOR, whole cents (0 on quarantined dispositions). */
  netCents: number;
  /** The write-time AGBOR BEFORE whole-cent truncation, exact micros text —
   * the waterfall pass's basis (never recomputed). */
  netMicros: string;
  /** The row's recorded total AGBOR deduction legs, verbatim micros text. */
  deductionMicros: string;
  detail: TheatricalLineDetail;
}

/** Write counts for one theatrical ingest — the honest completion report's inputs. */
export interface TheatricalWriteCounts {
  written: number;
  alreadyPresent: number;
  /** Negative-AGBOR quarantine rows — visible, never posted. */
  heldNegativeNet: number;
  /** Sub-cent/zero AGBOR — recorded, never posted. */
  zeroNet: number;
  /** Rows written WITH the production identity the lane's money hangs on —
   * every validated row carries one (the profiles require it), so the lane's
   * honest matched classification is total. */
  matched: number;
  unmatched: number;
  /** The deduction legs recorded across rows, verbatim (the AGBOR gap). */
  agborDeductionMicros: bigint;
  lineOutcomes: TheatricalLineOutcome[];
}

/**
 * Writes the theatrical lane's rows through the shared queue seam (all
 * three backends), one row per stop line, idempotent per event id: a
 * re-processed ingest is a counted no-op per row, never a duplicate.
 */
export async function writeTheatricalLinesToMatchQueue(
  store: Store,
  ingestId: string,
  lines: readonly ParsedStatementLine[],
): Promise<TheatricalWriteCounts> {
  const counts: TheatricalWriteCounts = {
    written: 0,
    alreadyPresent: 0,
    heldNegativeNet: 0,
    zeroNet: 0,
    matched: 0,
    unmatched: 0,
    agborDeductionMicros: 0n,
    lineOutcomes: [],
  };

  for (const line of lines) {
    const detail = line.theatricalDetail;
    if (detail === null || detail === undefined) continue; // Not this lane's row — the dispatcher owns routing.

    // The lane's matched/unmatched classification: the Production ID is the
    // identity the money hangs on — every validated row carries one.
    counts.matched += 1;

    // The AGBOR equation — computed HERE at write time from the row's own
    // recorded legs, exact bigint micros. The disposition keys on the
    // exact-cent AGBOR (the sheet's conservation identity); the micros
    // delta rides the outcome as provenance.
    const eventId = theatricalStopEventId(detail);
    const legs = theatricalLegsMicros(line);
    const stopLegs = agborCents(legs);
    const deductionMicros = stopLegsDeductionMicros(legs);
    counts.agborDeductionMicros += BigInt(deductionMicros);

    const row = theatricalRow(ingestId, line, eventId, detail, deductionMicros);
    await insertOrCountReplay(store, row, counts);

    if (stopLegs.agborCents < 0) {
      // A negative AGBOR — the deduction legs outran the gross. Write the
      // row (visible, auditable), never post a negative holding credit.
      counts.heldNegativeNet += 1;
      counts.lineOutcomes.push({
        line,
        eventId,
        disposition: "held_negative_net",
        netCents: 0,
        netMicros: (BigInt(detail.gborMicros) - BigInt(deductionMicros)).toString(),
        deductionMicros,
        detail,
      });
      continue;
    }

    const netMicros = BigInt(detail.gborMicros) - BigInt(deductionMicros);
    const disposition: TheatricalDisposition = stopLegs.agborCents === 0 ? "zero_net" : "money";
    if (disposition === "zero_net") counts.zeroNet += 1;
    counts.lineOutcomes.push({
      line,
      eventId,
      disposition,
      netCents: stopLegs.agborCents,
      netMicros: netMicros.toString(),
      deductionMicros,
      detail,
    });
  }
  return counts;
}

/** The row's recorded deduction total, exact micros (the AGBOR equation's legs). */
function stopLegsDeductionMicros(legs: TheatricalStopLegsMicros): string {
  return (
    legs.salesTaxMicros +
    legs.cardProcessingMicros +
    legs.facilityMaintenanceMicros +
    legs.ffeMicros +
    legs.groupDiscountMicros
  ).toString();
}

/** The theatrical queue row — the generic builder plus the lane's overrides. */
function theatricalRow(
  ingestId: string,
  line: ParsedStatementLine,
  eventId: string,
  detail: TheatricalLineDetail,
  deductionMicros: string,
): Omit<MatchQueueRecord, "id"> {
  const base = buildMatchQueueRow(
    line,
    eventId,
    `recon:theatrical:${line.profile}:line:${line.lineNumber}`,
  );
  return {
    ...base,
    // The live-event lane sells no catalog sale — the art licensing/audit
    // precedent; migration 0011's check admits only the music vocabulary.
    sale_type: null,
    jurisdiction_code: null,
    artwork_id: null,
    cogs_per_unit_micros: null,
    // The total AGBOR deduction legs (taxes, card fees, facility/FF&E,
    // group discounts) — the art lane's aggregate off-the-top discipline.
    platform_commission_micros: deductionMicros,
    usage_unit: "stops",
    usage_quantity: "1",
    // THE ADDENDUM 11 TRIPLE — the multi-city reconciliation key. The row
    // writer's triple populated the film receipt lane; the theatrical lane
    // populates it from the settlement sheet's identity columns.
    production_id: detail.productionId,
    venue_id: detail.venueId,
    show_date: detail.showDate,
  } satisfies Omit<MatchQueueRecord, "id"> & {
    production_id: string;
    venue_id: string;
    show_date: string;
  };
}

/** The idempotent insert — a unique violation is a replay (a counted
 * no-op), anything else throws (never swallowed). */
async function insertOrCountReplay(
  store: Store,
  row: Omit<MatchQueueRecord, "id">,
  counts: TheatricalWriteCounts,
): Promise<void> {
  try {
    await store.insertMatchQueueEntry(row);
    counts.written += 1;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    counts.alreadyPresent += 1;
  }
}
