/**
 * CVT recon worker — the book/magazine lane's match_queue writer (PR 26,
 * founder publishing directive: the book POD print parser + editorial split
 * ledger).
 *
 * Five row kinds share one writer, in the fail-closed order every lane uses
 * (vault cross-reference first, then the idempotent queue write; the
 * posting pass reads the computed net off the outcome, never recomputes —
 * the merch writer's ordering):
 *
 *   1. POD PRINT SALE ROWS — the print deduction equation computed HERE at
 *      write time from the row's recorded legs (gross retail − printing
 *      COGS × units − distribution fee − channel discount). The addendum 9
 *      isbn column rides the row, and the deduction legs ride
 *      cogs_per_unit_micros (the base printing COGS the FIFO amortization
 *      key matches) plus platform_commission_micros (the total recorded
 *      deductions). format_type is 'print'.
 *
 *   2. E-BOOK AGENCY ROWS — the 70/35 royalty computed HERE from the row's
 *      recorded list price (inclusive $2.99–$9.99 tier); the platform's
 *      agency share is the recorded deduction. format_type is null — the
 *      queue's publication-format CHECK carries no e-book value, and the
 *      profile + detail are the discriminator (no vocabulary fork).
 *
 *   3. MAGAZINE ISSUE-SALE ROWS — the issue's gross posts; the editorial
 *      cut schedule (the cascade module) designates the cuts downstream.
 *
 *   4. MAGAZINE SUBSCRIPTION ROWS — same posting posture; the percentage
 *      cuts key on these funding events.
 *
 *   5. AUDIOBOOK SALE ROWS — units × the recorded per-unit royalty is the
 *      net; the row feeds ONLY the audiobook pool class (the isolation
 *      firewall in the cascade apply).
 *
 * The queue's UNIQUE event_id is the dedup arbiter across ingests — one
 * event per (order, isbn, format) in the content-derived `book:*:` spaces;
 * a re-shipped report replays as counted no-ops.
 *
 * Negative nets (a print row whose cost legs outrun its retail) are
 * WRITTEN but dispositioned `held_negative_net` — visible, never dropped,
 * never posted (the merch/webtoon held space's posture): a row that loses
 * money is an operator quarantine, never a negative holding credit.
 */

import type { MatchQueueRecord } from "@/modules/sdk/records";
import type { Store } from "@/lib/server/store";
import type { BookLineDetail, ParsedStatementLine } from "./records";
import { buildMatchQueueRow, isUniqueViolation, type VaultLookup } from "./matchQueue";
import {
  bookAudiobookEventId,
  bookEbookEventId,
  bookMagazineEventId,
  bookPrintEventId,
  ebookAgencyRoyaltyMicros,
  podPrintDeductionMicros,
  podPrintNetRoyaltyMicros,
} from "./books";
import { microsToWholeCents } from "./posting";

/** Per-line book write outcome — the posting and split passes' input. */
export interface BookLineOutcome {
  line: ParsedStatementLine;
  eventId: string;
  matchedCbtCode: string | null;
  /**
   * The row's disposition — the posting pass's discriminator: `money` (a
   * postable net), `held_negative_net` (the row's cost legs exceed its
   * gross — visible quarantine, never posts), `zero_net` (sub-cent or
   * zero net — integer cents or nothing, never rounded up).
   */
  disposition: "money" | "held_negative_net" | "zero_net";
  /** The integer-cent net the posting pass credits (0 when held/zero). */
  netCents: number;
  /** The total deductions recorded on the row, exact micros as text. */
  deductionMicros: string;
  /** The row's lane context — the recoupment/split passes' input. */
  detail: BookLineDetail;
}

/** Aggregate book write counts — the completion result's book block. */
export interface BookWriteCounts {
  written: number;
  alreadyPresent: number;
  matched: number;
  unmatched: number;
  /** Rows written into the negative-net quarantine this pass. */
  heldNegativeNet: number;
  /** Sub-cent/zero nets — recorded, never posted. */
  zeroNet: number;
  /** Sum of the print rows' recorded deductions, exact micros. */
  printDeductionMicros: bigint;
  lineOutcomes: BookLineOutcome[];
}

/**
 * Writes one book ingest's lines. The ISBN is the lane's vault identifier
 * kind (the publishing identity the book reports key on): first hit wins,
 * a miss stays honestly unmatched — and unattributable money never posts.
 * Magazine rows key on the issue identity and stay honestly unmatched.
 */
export async function writeBookLinesToMatchQueue(
  store: Store,
  ingestId: string,
  lines: readonly ParsedStatementLine[],
  vault: VaultLookup | null,
): Promise<BookWriteCounts> {
  const counts: BookWriteCounts = {
    written: 0,
    alreadyPresent: 0,
    matched: 0,
    unmatched: 0,
    heldNegativeNet: 0,
    zeroNet: 0,
    printDeductionMicros: 0n,
    lineOutcomes: [],
  };

  for (const line of lines) {
    const detail = line.bookDetail;
    if (detail === null || detail === undefined) continue; // Not this lane's row — the dispatcher owns routing.

    let matchedCbtCode: string | null = null;
    const isbn = line.identifiers["ISBN"];
    if (vault !== null && isbn !== undefined) {
      const asset = await vault.findByIdentifier("ISBN", isbn);
      if (asset !== null) matchedCbtCode = asset.cbtCode;
    }
    if (matchedCbtCode !== null) counts.matched += 1;
    else counts.unmatched += 1;

    // The net — computed HERE at write time from the row's own recorded
    // legs, exact bigint micros (the merch writer's fail-closed ordering;
    // the posting pass reads the outcome, never recomputes).
    const eventId = bookEventId(detail);
    const { netMicros, deductionMicros } = bookNetMicros(detail);
    if (detail.kind === "print_sale") {
      counts.printDeductionMicros += podPrintDeductionMicros(detail);
    }

    if (netMicros < 0n) {
      // A negative net — the cost legs outran the retail. Write the row
      // (visible, auditable), never post a negative holding credit.
      const row = bookRow(ingestId, line, eventId, detail, matchedCbtCode, deductionMicros);
      await insertOrCountReplay(store, row, counts);
      counts.heldNegativeNet += 1;
      counts.lineOutcomes.push({
        line,
        eventId,
        matchedCbtCode,
        disposition: "held_negative_net",
        netCents: 0,
        deductionMicros,
        detail,
      });
      continue;
    }

    const netCents = microsToWholeCents(netMicros);
    const disposition = netCents === 0 ? "zero_net" : "money";
    if (disposition === "zero_net") counts.zeroNet += 1;

    const row = bookRow(ingestId, line, eventId, detail, matchedCbtCode, deductionMicros);
    await insertOrCountReplay(store, row, counts);
    counts.lineOutcomes.push({
      line,
      eventId,
      matchedCbtCode,
      disposition,
      netCents,
      deductionMicros,
      detail,
    });
  }
  return counts;
}

/** The content-derived event id per book row kind (identity, never money). */
function bookEventId(detail: BookLineDetail): string {
  switch (detail.kind) {
    case "print_sale":
      return bookPrintEventId(detail);
    case "ebook_sale":
      return bookEbookEventId(detail);
    case "audiobook_sale":
      return bookAudiobookEventId(detail);
    default:
      return bookMagazineEventId(detail);
  }
}

/** The row's net and recorded deduction, exact micros. */
function bookNetMicros(detail: BookLineDetail): { netMicros: bigint; deductionMicros: string } {
  if (detail.kind === "print_sale") {
    return {
      netMicros: podPrintNetRoyaltyMicros(detail),
      deductionMicros: podPrintDeductionMicros(detail).toString(),
    };
  }
  if (detail.kind === "ebook_sale") {
    // The agency royalty is the author's net; the platform's agency share
    // (gross − royalty) is the recorded deduction leg.
    const grossMicros = BigInt(detail.listPriceMicros) * BigInt(detail.units);
    const { royaltyMicros } = ebookAgencyRoyaltyMicros(detail);
    return {
      netMicros: royaltyMicros,
      deductionMicros: (grossMicros - royaltyMicros).toString(),
    };
  }
  if (detail.kind === "audiobook_sale") {
    // The recorded per-unit royalty IS the net — no agency tier applies.
    return {
      netMicros: BigInt(detail.grossMicros),
      deductionMicros: "0",
    };
  }
  // Magazine rows: the gross posts; the editorial cuts are designations
  // downstream (the cascade's accrual pass), never write-time deductions.
  return {
    netMicros: BigInt(detail.grossMicros),
    deductionMicros: "0",
  };
}

/** The book queue row — the generic builder plus the lane's overrides. */
function bookRow(
  ingestId: string,
  line: ParsedStatementLine,
  eventId: string,
  detail: BookLineDetail,
  matchedCbtCode: string | null,
  deductionMicros: string,
): Omit<MatchQueueRecord, "id"> {
  const base = buildMatchQueueRow(
    line,
    eventId,
    `recon:book:${line.profile}:line:${line.lineNumber}`,
  );
  // The addendum 9 columns: the title's ISBN and the publication format —
  // print rows are 'print' (paperback/hardcover rides the detail and the
  // raw row), audiobook rows are 'audio'; the queue's format CHECK carries
  // no e-book or magazine value and the profile is the discriminator.
  const formatType =
    detail.kind === "print_sale" ? "print" : detail.kind === "audiobook_sale" ? "audio" : null;
  const isMagazineRow = detail.kind === "magazine_issue" || detail.kind === "magazine_subscription";
  return {
    ...base,
    matched_cbt_code: matchedCbtCode,
    isbn: isMagazineRow ? null : detail.isbn,
    format_type: formatType,
    // The base printing COGS per unit — the FIFO amortization key's book
    // analogue (the merch addendum 8 discipline).
    cogs_per_unit_micros:
      detail.kind === "print_sale" ? detail.printingCostPerUnitMicros : null,
    platform_commission_micros: deductionMicros,
    usage_unit: "units",
    usage_quantity: detail.units.toString(),
  };
}

/** The idempotent insert — a unique violation is a replay (a counted
 * no-op), anything else throws (never swallowed). */
async function insertOrCountReplay(
  store: Store,
  row: Omit<MatchQueueRecord, "id">,
  counts: BookWriteCounts,
): Promise<void> {
  try {
    await store.insertMatchQueueEntry(row);
    counts.written += 1;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    counts.alreadyPresent += 1;
  }
}
