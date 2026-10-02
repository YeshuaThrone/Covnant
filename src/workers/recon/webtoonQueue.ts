/**
 * CVT recon worker — the webtoon lane's match_queue writer (PR 19, founder
 * webtoon + serialized-publishing directive).
 *
 * Three row kinds share one writer, in the fail-closed order every lane
 * uses (vault cross-reference first, then the idempotent queue write; the
 * posting pass re-derives nothing):
 *
 *   1. READER-LOG MONTHLY-PASS CLAIMS — the all-access pass read, written
 *      as a ZERO-GROSS queue row in the `webtoon:read:` event space. The
 *      claim is the deduplication's first mover: a pass claim in the queue
 *      quarantines any pay-per-chapter payout row for the same reading
 *      event that arrives later.
 *
 *   2. READER-LOG COIN-ACCESS FACTS — paid coin unlock / Fast-Pass reads,
 *      written zero-gross in the `webtoon:consumed:` space. Deliberately
 *      NOT in the reading-event money space: a reader-log fact must never
 *      block the payout statement's legitimate money — only a PASS claim
 *      (a read the subscription already paid for) can.
 *
 *   3. COIN-PAYOUT MONEY — the per-reader pay-per-chapter conversion,
 *      written into the `webtoon:read:` space over the reading-event
 *      fingerprint (access type excluded — identity is what was read,
 *      never how it was monetized, the podcast cross-feed principle).
 *      THE DEDUP: before writing, the writer checks the reading-event
 *      space — a monthly-pass claim there means the subscription already
 *      paid for this read, so the payout row is the platform's
 *      double-report attempt: it is quarantined into the `webtoon:held:`
 *      space (visible, never dropped, never posted, never counted as
 *      revenue) and counted as a dedup hit. A prior MONEY row there is a
 *      replay — a counted no-op.
 *
 *   4. KENP POOL MONEY — pages × the period's recorded pool rate, written
 *      content-derived per (period, marketplace, title) so a re-shipped
 *      Global Fund report replays as counted no-ops.
 *
 * The queue's UNIQUE event_id is the dedup arbiter across ingests — one
 * payout per reading event, structurally, in either arrival order, with no
 * new table: the reader-log pass claim landing first quarantines the
 * payout (the founder's rule); a payout landing first makes the later pass
 * row an honestly-counted consumption fact.
 *
 * The deductions are computed HERE at write time so the queue row records
 * the layered shares (pinned store cut + platform split) before any
 * posting happens — the gaming writer's fail-closed ordering; the posting
 * pass reads the recorded layers off the outcome, never recomputes.
 */

import type { MatchQueueRecord } from "@/modules/sdk/records";
import type { Store } from "@/lib/server/store";
import type { ParsedStatementLine } from "./records";
import { buildMatchQueueRow, isUniqueViolation, type VaultLookup } from "./matchQueue";
import {
  layeredShareDeductions,
  webtoonConsumedEventId,
  webtoonHeldEventId,
  webtoonKenpLineEventId,
  webtoonReadingEventId,
} from "./webtoon";

/** Per-line webtoon write outcome — the posting pass's input. */
export interface WebtoonLineOutcome {
  line: ParsedStatementLine;
  eventId: string;
  matchedCbtCode: string | null;
  /** false = the row already existed (a replay wrote nothing). */
  written: boolean;
  /**
   * The row's disposition — the posting pass's discriminator:
   * `money` (coin conversion or KENP pool revenue), `consumption` (a
   * reader-log fact or pass claim — never money), `held_double_dip` (a
   * pay-per-chapter row a pass claim quarantined — never posts).
   */
  disposition: "money" | "consumption" | "held_double_dip";
  /** The layered deductions recorded on money rows, exact micros as text. */
  storeCutMicros: string;
  platformSplitMicros: string;
  /** For a held row: the quarantine reason (the founder's audit trail). */
  holdReason: string | null;
}

/** Aggregate webtoon write counts — the completion result's webtoon block. */
export interface WebtoonWriteCounts {
  written: number;
  alreadyPresent: number;
  matched: number;
  unmatched: number;
  /** Reader-log monthly-pass claims written this pass (the dedup claims). */
  passClaims: number;
  /** Pay-per-chapter payout rows quarantined by a pass claim this pass. */
  passDeduped: number;
  /** Pass reads whose reading event was already paid as a coin payout —
   * honestly visible, never double-counted. */
  paidAsCoin: number;
  /** Per-line detail, in write order — the posting pass's input. */
  lineOutcomes: WebtoonLineOutcome[];
}

/**
 * Writes the webtoon lane's rows through the shared queue seam (all three
 * backends), one row per line, idempotent per event id: a re-processed
 * ingest is a counted no-op per row, never a duplicate. A vault miss
 * leaves the row honestly unmatched — the lane's money never posts
 * unattributed (the posting pass checks the match).
 */
export async function writeWebtoonLinesToMatchQueue(
  store: Store,
  ingestId: string,
  lines: readonly ParsedStatementLine[],
  vault: VaultLookup | null,
): Promise<WebtoonWriteCounts> {
  const counts: WebtoonWriteCounts = {
    written: 0,
    alreadyPresent: 0,
    matched: 0,
    unmatched: 0,
    passClaims: 0,
    passDeduped: 0,
    paidAsCoin: 0,
    lineOutcomes: [],
  };

  for (const line of lines) {
    const detail = line.webtoonDetail;
    if (detail === null) continue; // Not this lane's row — the dispatcher owns routing.

    // The lane's only identifier kind is the Catalog DOI (the gaming/
    // livestream posture): first hit wins, a miss stays honestly unmatched.
    let matchedCbtCode: string | null = null;
    const doi = line.identifiers["DOI"];
    if (vault !== null && doi !== undefined) {
      const asset = await vault.findByIdentifier("DOI", doi);
      if (asset !== null) matchedCbtCode = asset.cbtCode;
    }
    if (matchedCbtCode !== null) counts.matched += 1;
    else counts.unmatched += 1;

    if (detail.kind === "reader_log") {
      const outcome = await writeReaderLogRow(
        store,
        ingestId,
        line,
        detail,
        matchedCbtCode,
        counts,
      );
      counts.lineOutcomes.push(outcome);
      continue;
    }
    if (detail.kind === "coin_payout") {
      const outcome = await writeCoinPayoutRow(
        store,
        ingestId,
        line,
        detail,
        matchedCbtCode,
        counts,
      );
      counts.lineOutcomes.push(outcome);
      continue;
    }
    const outcome = await writeKenpPoolRow(store, ingestId, line, detail, matchedCbtCode, counts);
    counts.lineOutcomes.push(outcome);
  }
  return counts;
}

/**
 * A reader-log row — zero-gross consumption facts. The monthly-pass read
 * is the CLAIM: it takes the reading-event id space, so a later
 * pay-per-chapter payout row for the same read is quarantined. Coin-access
 * reads are facts in their own space — they never block money.
 */
async function writeReaderLogRow(
  store: Store,
  ingestId: string,
  line: ParsedStatementLine,
  detail: NonNullable<ParsedStatementLine["webtoonDetail"]>,
  matchedCbtCode: string | null,
  counts: WebtoonWriteCounts,
): Promise<WebtoonLineOutcome> {
  const isPassClaim = detail.accessType === "monthly_pass";
  const claimEventId = webtoonReadingEventId(detail);
  const consumptionEventId = webtoonConsumedEventId(detail);

  if (isPassClaim) {
    // THE CLAIM — check the reading-event space first: a coin payout that
    // landed first already paid this read (the arrival-order hole, closed
    // honestly — the pass read is recorded as a consumption fact with the
    // paid-as-coin provenance, never a second payout claim).
    const prior = await store.getMatchQueueEntryByEventId(claimEventId);
    if (prior !== undefined && prior.gross_micros !== "0") {
      // The reading event was already monetized as a pay-per-chapter
      // payout — record the pass read in the consumed space (visible,
      // never a claim) and count the discrepancy.
      const row = webtoonRow(
        ingestId,
        line,
        consumptionEventId,
        `recon:webtoon:paid_as_coin:${line.profile}:line:${line.lineNumber}`,
        detail,
        matchedCbtCode,
        { formatType: "digital_chapter", usageUnit: "pages" },
      );
      await insertOrCountReplay(store, row, counts);
      counts.paidAsCoin += 1;
      return {
        line,
        eventId: consumptionEventId,
        matchedCbtCode,
        written: true,
        disposition: "consumption",
        storeCutMicros: "0",
        platformSplitMicros: "0",
        holdReason: null,
      };
    }
    if (prior !== undefined) {
      // A pass claim replay — counted no-op.
      counts.alreadyPresent += 1;
      return {
        line,
        eventId: claimEventId,
        matchedCbtCode,
        written: false,
        disposition: "consumption",
        storeCutMicros: "0",
        platformSplitMicros: "0",
        holdReason: null,
      };
    }
    const row = webtoonRow(
      ingestId,
      line,
      claimEventId,
      `recon:webtoon:${line.profile}:line:${line.lineNumber}`,
      detail,
      matchedCbtCode,
      { formatType: "digital_chapter", usageUnit: "pages" },
    );
    await insertOrCountReplay(store, row, counts);
    counts.passClaims += 1;
    return {
      line,
      eventId: claimEventId,
      matchedCbtCode,
      written: true,
      disposition: "consumption",
      storeCutMicros: "0",
      platformSplitMicros: "0",
      holdReason: null,
    };
  }

  // Coin-access fact — its own space; a replay is a counted no-op.
  const row = webtoonRow(
    ingestId,
    line,
    consumptionEventId,
    `recon:webtoon:${line.profile}:line:${line.lineNumber}`,
    detail,
    matchedCbtCode,
    { formatType: "coin_unlock", usageUnit: "pages" },
  );
  await insertOrCountReplay(store, row, counts);
  return {
    line,
    eventId: consumptionEventId,
    matchedCbtCode,
    written: true,
    disposition: "consumption",
    storeCutMicros: "0",
    platformSplitMicros: "0",
    holdReason: null,
  };
}

/**
 * A pay-per-chapter coin payout row — the conversion money. THE DEDUP: a
 * monthly-pass claim in the reading-event space quarantines this row into
 * the held space (the founder's double-dip rule); a prior money row is a
 * replay; a fresh reading event takes the money id and records the layered
 * deductions at write time.
 */
async function writeCoinPayoutRow(
  store: Store,
  ingestId: string,
  line: ParsedStatementLine,
  detail: NonNullable<ParsedStatementLine["webtoonDetail"]>,
  matchedCbtCode: string | null,
  counts: WebtoonWriteCounts,
): Promise<WebtoonLineOutcome> {
  const moneyEventId = webtoonReadingEventId(detail);
  const prior = await store.getMatchQueueEntryByEventId(moneyEventId);

  if (prior !== undefined && prior.gross_micros === "0") {
    // A monthly-pass claim owns this reading event — the subscription
    // already paid for the read. The payout row is the platform's
    // double-report attempt: quarantine it visibly (the held space, the
    // row's own facts preserved for audit), never post it, never count it
    // as revenue.
    const heldEventId = webtoonHeldEventId(detail);
    const row = webtoonRow(
      ingestId,
      line,
      heldEventId,
      `recon:webtoon:held:double_dip_monthly_pass:${line.profile}:line:${line.lineNumber}`,
      detail,
      matchedCbtCode,
      {
        formatType: "coin_unlock",
        usageUnit: null,
        storeCutMicros: "0",
        platformSplitMicros: "0",
      },
    );
    await insertOrCountReplay(store, row, counts);
    counts.passDeduped += 1;
    return {
      line,
      eventId: heldEventId,
      matchedCbtCode,
      written: true,
      disposition: "held_double_dip",
      storeCutMicros: "0",
      platformSplitMicros: "0",
      holdReason: "webtoon:double_dip_monthly_pass",
    };
  }
  if (prior !== undefined) {
    // A prior MONEY row for the same reading event (a replayed ingest or a
    // corrected re-ship of the same payout) — one payout per reading
    // event, structurally; the replay is the honest report.
    counts.alreadyPresent += 1;
    return {
      line,
      eventId: moneyEventId,
      matchedCbtCode,
      written: false,
      disposition: "money",
      storeCutMicros: "0",
      platformSplitMicros: "0",
      holdReason: null,
    };
  }

  // Fresh reading event — the layered deductions are computed at write
  // time so the queue row records them before any posting (fail-closed
  // ordering, the gaming writer's precedent; the posting pass
  // re-derives nothing).
  const grossMicros = line.grossMicros;
  const deductions = layeredShareDeductions(
    grossMicros,
    detail.platformSplitBps ?? 0,
  );
  const row = webtoonRow(
    ingestId,
    line,
    moneyEventId,
    `recon:webtoon:${line.profile}:line:${line.lineNumber}`,
    detail,
    matchedCbtCode,
    {
      formatType: "coin_unlock",
      usageUnit: null,
      storeCutMicros: deductions.appStoreCutMicros.toString(),
      platformSplitMicros: deductions.platformSplitMicros.toString(),
    },
  );
  await insertOrCountReplay(store, row, counts);
  return {
    line,
    eventId: moneyEventId,
    matchedCbtCode,
    written: true,
    disposition: "money",
    storeCutMicros: deductions.appStoreCutMicros.toString(),
    platformSplitMicros: deductions.platformSplitMicros.toString(),
    holdReason: null,
  };
}

/** A KENP pool money row — content-derived per (period, marketplace, title),
 * so a re-shipped Global Fund report replays as counted no-ops. */
async function writeKenpPoolRow(
  store: Store,
  ingestId: string,
  line: ParsedStatementLine,
  detail: NonNullable<ParsedStatementLine["webtoonDetail"]>,
  matchedCbtCode: string | null,
  counts: WebtoonWriteCounts,
): Promise<WebtoonLineOutcome> {
  const eventId = webtoonKenpLineEventId(
    detail.period,
    detail.marketplace ?? "",
    detail.seriesId ?? "",
  );
  const row = webtoonRow(
    ingestId,
    line,
    eventId,
    `recon:webtoon:${line.profile}:line:${line.lineNumber}`,
    detail,
    matchedCbtCode,
    { formatType: "kenp_page_read", usageUnit: "kenp_pages" },
  );
  await insertOrCountReplay(store, row, counts);
  return {
    line,
    eventId,
    matchedCbtCode,
    written: true,
    disposition: "money",
    storeCutMicros: "0",
    platformSplitMicros: "0",
    holdReason: null,
  };
}

/** The webtoon queue row — the shared builder plus this lane's overrides.
 * Every column explicit, the closed-record discipline; the caller owns the
 * reason string (held/paid-as-coin rows carry their quarantine in it). */
function webtoonRow(
  ingestId: string,
  line: ParsedStatementLine,
  eventId: string,
  reason: string,
  detail: NonNullable<ParsedStatementLine["webtoonDetail"]>,
  matchedCbtCode: string | null,
  overrides: {
    formatType: MatchQueueRecord["format_type"];
    usageUnit: string | null;
    storeCutMicros?: string;
    platformSplitMicros?: string;
  },
): Omit<MatchQueueRecord, "id"> {
  const base = buildMatchQueueRow(line, eventId, reason);
  return {
    ...base,
    matched_cbt_code: matchedCbtCode,
    // The conversion cells ride the row verbatim — the recorded conversion
    // is auditable from the row alone (the founder's rate-logging rule).
    virtual_currency_code: detail.coinDenomination,
    virtual_amount: detail.coinAmount,
    exchange_rate: detail.exchangeRate,
    // The layered deductions, recorded at write time (money rows only;
    // "0" elsewhere — the quarantined rows record what WOULD have been
    // deducted, the held space's audit trail).
    platform_commission_micros: overrides.storeCutMicros === undefined
      ? "0"
      : (BigInt(overrides.storeCutMicros) + BigInt(overrides.platformSplitMicros ?? "0")).toString(),
    format_type: overrides.formatType,
    usage_unit: overrides.usageUnit,
    usage_quantity:
      detail.kind === "coin_payout" || detail.pagesRead === null
        ? null
        : detail.pagesRead.toString(),
  };
}

/** The idempotent insert — a unique violation is a replay (a counted
 * no-op), anything else throws (never swallowed). */
async function insertOrCountReplay(
  store: Store,
  row: Omit<MatchQueueRecord, "id">,
  counts: WebtoonWriteCounts,
): Promise<void> {
  try {
    await store.insertMatchQueueEntry(row);
    counts.written += 1;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    counts.alreadyPresent += 1;
  }
}
