/**
 * CVT recon worker — the gaming lane's match_queue writer (PR 12).
 *
 * Reuses the shared builder for the closed record's explicit columns and
 * overrides ONLY the gaming ones — one source of truth for the null
 * columns, zero drift between lanes (the podcast writer's precedent).
 * Event ids come from the gaming identity spaces (`gaming:line:`),
 * ingest-scoped — a gaming report row is plain money with no cross-
 * platform impression to dedupe, so replay idempotency rides the queue's
 * UNIQUE event_id constraint exactly like every other lane.
 *
 * The engine-royalty accumulator lives HERE, at write time, because the
 * marginal calculation is store-state-dependent: a line's royalty window
 * is [cumBefore, cumBefore + gross) over the product-year's RECORDED
 * contributions. Ordering discipline:
 *
 *   1. accumulator event (insert-as-lock) — UNIQUE on event_id fixes the
 *      line's position in the product-year's contribution sequence;
 *   2. the queue row records the royalty AT CONTRIBUTION TIME — a replay
 *      reuses the recorded value instead of recomputing against moved
 *      state (a recomputation against the accumulator AFTER the original
 *      contribution would derive zero, and a queue row carrying revenue
 *      that moved would be worse than no row).
 *
 * Only Epic-family lines contribute: the EGS waiver counts its gross
 * toward the threshold (the waiver is on the RATE, not the window — the
 * founder's 0%-up-to-$1M rule reads the whole product-year's gross) while
 * Unreal Marketplace lines both count and bear the 3.5% above the line.
 * Non-Epic platforms have no engine royalty and no accumulator.
 */

import type { MatchQueueRecord } from "@/modules/sdk/records";
import type { Store } from "@/lib/server/store";
import type { ParsedStatementLine } from "./records";
import { StatementParseError } from "./records";
import {
  bearsEngineRoyalty,
  engineRoyaltyMicros,
  gamingLineEventId,
  isEpicFamilyPlatform,
  platformCommissionMicros,
  resaleRoyaltyPoolMicros,
} from "./gaming";
import {
  buildMatchQueueRow,
  isUniqueViolation,
  type VaultLookup,
} from "./matchQueue";

/** Per-line gaming write outcome — the posting and accrual passes' input. */
export interface GamingLineOutcome {
  line: ParsedStatementLine;
  eventId: string;
  matchedCbtCode: string | null;
  /** false = the row already existed (a replay wrote nothing). */
  written: boolean;
  /** The queue row's commission deduction, exact micros as text. */
  commissionMicros: string;
  /** The line's engine royalty at contribution time, exact micros as text. */
  engineRoyaltyMicros: string;
  /** The secondary resale royalty pool, exact micros as text ("0" primary). */
  resaleRoyaltyMicros: string;
}

/** Aggregate gaming write counts — the completion result's gaming block. */
export interface GamingWriteCounts {
  written: number;
  alreadyPresent: number;
  /** Epic-family gross newly recorded into the accumulator this pass. */
  accumulatorGrossMicros: bigint;
  matched: number;
  unmatched: number;
  /** Per-line detail, in write order — the posting pass's input. */
  lineOutcomes: GamingLineOutcome[];
}

/**
 * Writes every gaming line into match_queue idempotently, recording each
 * Epic-family line's accumulator contribution before its queue row.
 * `vault === null` skips lookups exactly like the other lanes — the caller
 * surfaces an unlabeled vault-less run instead of passing it off as
 * verified matching.
 */
export async function writeGamingLinesToMatchQueue(
  store: Store,
  ingestId: string,
  lines: readonly ParsedStatementLine[],
  vault: VaultLookup | null,
  now?: Date,
): Promise<GamingWriteCounts> {
  const nowDate = (now ?? new Date()).toISOString();
  const counts: GamingWriteCounts = {
    written: 0,
    alreadyPresent: 0,
    accumulatorGrossMicros: 0n,
    matched: 0,
    unmatched: 0,
    lineOutcomes: [],
  };
  for (const line of lines) {
    const detail = line.gamingDetail;
    if (detail === null) continue;
    const eventId = gamingLineEventId(detail, ingestId, line.lineNumber);

    // The engine-royalty contribution — insert-as-lock BEFORE the queue
    // row so the marginal window's position is fixed. A replayed line
    // reuses the recorded royalty (never recomputed against moved state).
    let royaltyMicros = 0n;
    if (isEpicFamilyPlatform(detail.platform)) {
      const productId = detail.productId;
      if (productId === null) {
        throw new StatementParseError(
          `gaming_accumulator_product_missing:row_${line.lineNumber}`,
        );
      }
      const existing = await store.getGamingEngineRoyaltyEventByEventId(eventId);
      if (existing !== undefined) {
        royaltyMicros = BigInt(existing.engine_royalty_micros);
      } else {
        const cumBefore = BigInt(
          await store.sumGamingEngineRoyaltyGross(
            detail.platform,
            productId,
            detail.annualYear,
          ),
        );
        royaltyMicros = engineRoyaltyMicros(detail, line.grossMicros, cumBefore);
        try {
          await store.insertGamingEngineRoyaltyEvent({
            event_id: eventId,
            platform: detail.platform,
            product_id: productId,
            annual_year: detail.annualYear,
            gross_micros: line.grossMicros.toString(),
            engine_royalty_micros: royaltyMicros.toString(),
            created_at: nowDate,
          });
          counts.accumulatorGrossMicros += line.grossMicros;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // A concurrent pass recorded this contribution between our sum
          // and our insert — the lock held; re-read the recorded royalty.
          const winner = await store.getGamingEngineRoyaltyEventByEventId(eventId);
          if (winner === undefined) {
            throw new StatementParseError(
              `gaming_accumulator_lock_lost:${eventId}`,
            );
          }
          royaltyMicros = BigInt(winner.engine_royalty_micros);
        }
      }
    }

    // DOI cross-reference — the gaming lane's only identifier kind.
    let matchedCbtCode: string | null = null;
    const doi = line.identifiers.DOI;
    if (vault !== null && doi !== undefined) {
      const asset = await vault.findByIdentifier("DOI", doi);
      if (asset !== null) matchedCbtCode = asset.cbtCode;
    }
    if (matchedCbtCode !== null) counts.matched += 1;
    else counts.unmatched += 1;

    // The commission and resale pool derive from the row's own facts —
    // computed HERE at write time so the queue row records the deductions
    // before any posting happens (fail-closed ordering, the podcast
    // writer's precedent; the posting pass re-derives nothing).
    const commission = platformCommissionMicros(
      line.grossMicros,
      detail.commissionBps,
    );
    const resalePool = resaleRoyaltyPoolMicros(
      line.grossMicros,
      detail.resaleRoyaltyBps,
    );

    const base = buildMatchQueueRow(
      line,
      eventId,
      `recon:gaming:${line.profile}:line:${line.lineNumber}`,
    );
    const row: Omit<MatchQueueRecord, "id"> = {
      ...base,
      matched_cbt_code: matchedCbtCode,
      sale_type: detail.saleType,
      virtual_currency_code: detail.virtualCurrencyCode,
      virtual_amount: detail.virtualAmount,
      exchange_rate: detail.exchangeRate,
      engine_royalty_micros: royaltyMicros.toString(),
      platform_commission_micros: commission.toString(),
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
      commissionMicros: commission.toString(),
      engineRoyaltyMicros: royaltyMicros.toString(),
      resaleRoyaltyMicros: resalePool.toString(),
    });
  }
  return counts;
}

/** True when the line bears the Unreal engine royalty — the posting pass
 * reports the deduction only for lines that actually carried one. */
export function lineBearsEngineRoyalty(line: ParsedStatementLine): boolean {
  const detail = line.gamingDetail;
  return detail !== null && bearsEngineRoyalty(detail);
}
