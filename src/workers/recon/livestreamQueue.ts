/**
 * CVT recon worker — the livestream lane's match_queue writer (PR 14).
 *
 * Reuses the shared builder for the closed record's explicit columns and
 * overrides ONLY the livestream ones — one source of truth for the null
 * columns, zero drift between lanes (the gaming/podcast writers'
 * precedent). Event ids come from the lane's identity spaces
 * (`livestream:line:` per stream platform, `esports:pool:<batch>` for
 * prize-pool receipts), ingest-scoped — a stream payout row is plain
 * money with no cross-platform impression to dedupe, so replay
 * idempotency rides the queue's UNIQUE event_id exactly like every other
 * lane.
 *
 * The platform fee derives from the row's OWN facts — computed HERE at
 * write time so the queue row records the deduction before any posting
 * happens (fail-closed ordering, the gaming writer's precedent; the
 * posting pass re-derives nothing). Only the Kick 95/5 model carries a
 * platform fee on this lane: Bits and Diamonds convert at creator-net
 * rates, and fiat-native rows post the reported amount.
 */

import type { MatchQueueRecord } from "@/modules/sdk/records";
import type { Store } from "@/lib/server/store";
import type { ParsedStatementLine } from "./records";
import {
  esportsPrizePoolLineEventId,
  livestreamLineEventId,
  splitKickSubscription,
} from "./livestream";
import {
  buildMatchQueueRow,
  isUniqueViolation,
  type VaultLookup,
} from "./matchQueue";

/** Per-line livestream write outcome — the posting pass's input. */
export interface LivestreamLineOutcome {
  line: ParsedStatementLine;
  eventId: string;
  matchedCbtCode: string | null;
  /** false = the row already existed (a replay wrote nothing). */
  written: boolean;
  /** The row's platform-fee deduction, exact micros as text ("0" elsewhere). */
  platformFeeMicros: string;
  /** True when the line is a virtual-currency conversion (Bits/Diamonds) —
   * the posting pass writes its durable conversion log. */
  isConversion: boolean;
  /** True when the line is an esports prize-pool receipt — the posting
   * pass locks it into the batch escrow instead of the holding. */
  isPrizePool: boolean;
}

/** Aggregate livestream write counts — the completion result's inputs. */
export interface LivestreamWriteCounts {
  written: number;
  alreadyPresent: number;
  matched: number;
  unmatched: number;
  /** Per-line detail, in write order — the posting pass's input. */
  lineOutcomes: LivestreamLineOutcome[];
}

/**
 * Writes every livestream line into match_queue idempotently.
 * `vault === null` skips lookups exactly like the other lanes — the
 * caller surfaces an unlabeled vault-less run instead of passing it off
 * as verified matching.
 */
export async function writeLivestreamLinesToMatchQueue(
  store: Store,
  ingestId: string,
  lines: readonly ParsedStatementLine[],
  vault: VaultLookup | null,
  now?: Date,
): Promise<LivestreamWriteCounts> {
  const counts: LivestreamWriteCounts = {
    written: 0,
    alreadyPresent: 0,
    matched: 0,
    unmatched: 0,
    lineOutcomes: [],
  };
  for (const line of lines) {
    const detail = line.livestreamDetail;
    if (detail === null) continue;
    const eventId =
      detail.prizePoolBatch !== null
        ? esportsPrizePoolLineEventId(detail.prizePoolBatch, ingestId, line.lineNumber)
        : livestreamLineEventId(
            detail.platform ?? "esports",
            ingestId,
            line.lineNumber,
          );

    // DOI cross-reference — the livestream lane's only identifier kind.
    let matchedCbtCode: string | null = null;
    const doi = line.identifiers.DOI;
    if (vault !== null && doi !== undefined) {
      const asset = await vault.findByIdentifier("DOI", doi);
      if (asset !== null) matchedCbtCode = asset.cbtCode;
    }
    if (matchedCbtCode !== null) counts.matched += 1;
    else counts.unmatched += 1;

    // The Kick 95/5 model's platform fee — from the row's own recorded
    // share, computed at write time (the queue row records the deduction
    // before any posting happens).
    let platformFeeMicros = 0n;
    if (detail.creatorShareBps !== null) {
      const split = splitKickSubscription(line.grossMicros, detail.creatorShareBps);
      platformFeeMicros = split.platformFeeMicros;
    }

    const base = buildMatchQueueRow(
      line,
      eventId,
      `recon:livestream:${line.profile}:line:${line.lineNumber}`,
    );
    const row: Omit<MatchQueueRecord, "id"> = {
      ...base,
      created_at: (now ?? new Date()).toISOString(),
      matched_cbt_code: matchedCbtCode,
      stream_platform: detail.platform,
      alert_type: detail.alertType,
      revenue_basis: detail.revenueBasis,
      prize_pool_batch: detail.prizePoolBatch,
      virtual_currency_code: detail.virtualCurrencyCode,
      virtual_amount: detail.virtualAmount,
      exchange_rate: detail.exchangeRate,
      platform_commission_micros: platformFeeMicros.toString(),
    };
    let written = true;
    try {
      await store.insertMatchQueueEntry(row);
      counts.written += 1;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A replay: the row already exists (same event_id) — nothing is
      // written and nothing double-counts.
      written = false;
      counts.alreadyPresent += 1;
    }
    counts.lineOutcomes.push({
      line,
      eventId,
      matchedCbtCode,
      written,
      platformFeeMicros: platformFeeMicros.toString(),
      isConversion: detail.virtualCurrencyCode !== null,
      isPrizePool: detail.prizePoolBatch !== null,
    });
  }
  return counts;
}
