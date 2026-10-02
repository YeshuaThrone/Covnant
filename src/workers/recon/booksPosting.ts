/**
 * CVT recon worker — the book/magazine lane's holding poster (PR 26, the
 * merch lane's posting pass, without the consignment shrinkage leg).
 *
 * Posts one book ingest's computed nets to UNCLAIMED_HOLDING. Reads the
 * write pass's outcomes — the net was computed once at write time; the
 * posting pass never recomputes. Dispositions are final here:
 *
 *   `money`  — matched rows credit holding under the row's event id (the
 *              409 journal-ref guard is the per-source replay; a replayed
 *              ingest counts as alreadyPosted),
 *   `held_negative_net` / `zero_net` — counted, never posted,
 *   matchedCbtCode === null — the row is unattributable (a miss in the
 *              vault cross-reference or a magazine row with no registry
 *              identity); unattributable money never posts.
 */

import type { Store } from "@/lib/server/store";
import type { BookLineOutcome, BookWriteCounts } from "./booksQueue";
import { CanonicalPostingError } from "./posting";
import { postToUnclaimedHolding, type UnclaimedHoldingFailure, type UnclaimedHoldingPostSuccess } from "@/lib/server/unclaimedHolding";

/** Posting counts for one book ingest — the honest completion report's inputs. */
export interface BookPostingCounts {
  /** Matched lines credited to UNCLAIMED_HOLDING this pass. */
  posted: number;
  /** Matched lines whose post hit the per-source replay guard (no-ops). */
  alreadyPosted: number;
  /** Unmatched rows — written, cross-referenced, honestly not posted. */
  unmatched: number;
  /** Negative-net quarantine rows — visible, never posted. */
  heldNegativeNet: number;
  /** Sub-cent/zero nets — recorded, never posted. */
  zeroNet: number;
}

/** The replay guard's exact refusal — a 409 is a no-op, anything else fails. */
function isReplayRefusal(failure: UnclaimedHoldingFailure): boolean {
  return failure.status === 409 && failure.code === "unclaimed_holding_already_posted";
}

export async function postBookNetsToHolding(
  store: Store,
  counts: BookWriteCounts,
  now: Date,
): Promise<BookPostingCounts> {
  const posting: BookPostingCounts = {
    posted: 0,
    alreadyPosted: 0,
    unmatched: 0,
    heldNegativeNet: 0,
    zeroNet: 0,
  };

  for (const outcome of counts.lineOutcomes as readonly BookLineOutcome[]) {
    // The dispositions decided at write time are final here — the pass
    // only counts what it leaves quarantined.
    if (outcome.disposition === "held_negative_net") {
      posting.heldNegativeNet += 1;
      continue;
    }
    if (outcome.disposition === "zero_net") {
      posting.zeroNet += 1;
      continue;
    }
    if (outcome.matchedCbtCode === null) {
      posting.unmatched += 1;
      continue;
    }

    let posted: UnclaimedHoldingPostSuccess | UnclaimedHoldingFailure;
    try {
      posted = await postToUnclaimedHolding(
        store,
        {
          amount_cents: outcome.netCents,
          currency: outcome.line.currency,
          source: { type: "match_queue", event_id: outcome.eventId },
          // No split_run_id — the ingest linkage rides line_item_id and the
          // event_id itself (`book:*:`); a split run does not exist yet at
          // parse time, and no id space may be conflated.
          split_run_id: null,
        },
        now,
      );
    } catch (cause) {
      // PR 7's guards RETURN Failure results; a store-level exception THROWS
      // raw past them. Classify it — never swallow, never let it pose as an
      // anonymous crash: the same row-scoped job-failing reason as a guard
      // refusal, so the retry budget heals through the same idempotent pass
      // and the queue row stays the quarantine record.
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new CanonicalPostingError(
        outcome.eventId,
        "ledger_store_error",
        `unclaimed_holding_post_failed:${outcome.eventId}:ledger_store_error:${message}`,
      );
    }
    if (posted.ok) {
      posting.posted += 1;
      continue;
    }
    if (isReplayRefusal(posted)) {
      posting.alreadyPosted += 1;
      continue;
    }
    throw new CanonicalPostingError(
      outcome.eventId,
      posted.code,
      `unclaimed_holding_post_failed:${outcome.eventId}:${posted.code}:${posted.message}`,
    );
  }
  return posting;
}
