/**
 * CVT recon worker — the AGBOR box office lane's holding poster (PR 30, the
 * books/art lane's posting pass, without the vault-match gate: the
 * theatrical lane's attribution rides the addendum 11 reconciliation triple
 * (production_id, venue_id, show_date) on the queue row — no vault
 * identifier kind exists for productions, the identifier canon is the v2
 * scope's, and the row is the attribution of record).
 *
 * Posts one theatrical ingest's computed AGBOR to UNCLAIMED_HOLDING. Reads
 * the write pass's outcomes — the net was computed once at write time; the
 * posting pass never recomputes. Dispositions are final here:
 *
 *   `money`  — stops credit holding under the row's event id (the 409
 *              journal-ref guard is the per-source replay; a replayed
 *              ingest counts as alreadyPosted),
 *   `held_negative_net` / `zero_net` — counted, never posted.
 *
 * The stops' money posts in the `theatrical:{sender}:` event spaces — the
 * per-sender identity discipline: each settlement row's sheet is its own
 * event, replay-guarded per sender's settlement id of record.
 */

import type { Store } from "@/lib/server/store";
import type { TheatricalLineOutcome, TheatricalWriteCounts } from "./theatricalQueue";
import { CanonicalPostingError } from "./posting";
import {
  postToUnclaimedHolding,
  type UnclaimedHoldingFailure,
  type UnclaimedHoldingPostSuccess,
} from "@/lib/server/unclaimedHolding";

/** Posting counts for one theatrical ingest — the honest completion report's inputs. */
export interface TheatricalPostingCounts {
  /** Stops credited to UNCLAIMED_HOLDING this pass. */
  posted: number;
  /** Stops whose post hit the per-source replay guard (no-ops). */
  alreadyPosted: number;
  /** Negative-AGBOR quarantine rows — visible, never posted. */
  heldNegativeNet: number;
  /** Sub-cent/zero AGBOR — recorded, never posted. */
  zeroNet: number;
}

/** The replay guard's exact refusal — a 409 is a no-op, anything else fails. */
function isReplayRefusal(failure: UnclaimedHoldingFailure): boolean {
  return failure.status === 409 && failure.code === "unclaimed_holding_already_posted";
}

export async function postTheatricalNetsToHolding(
  store: Store,
  counts: TheatricalWriteCounts,
  now: Date,
): Promise<TheatricalPostingCounts> {
  const posting: TheatricalPostingCounts = {
    posted: 0,
    alreadyPosted: 0,
    heldNegativeNet: 0,
    zeroNet: 0,
  };

  for (const outcome of counts.lineOutcomes as readonly TheatricalLineOutcome[]) {
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

    let posted: UnclaimedHoldingPostSuccess | UnclaimedHoldingFailure;
    try {
      posted = await postToUnclaimedHolding(
        store,
        {
          amount_cents: outcome.netCents,
          currency: outcome.line.currency,
          source: { type: "match_queue", event_id: outcome.eventId },
          // No split_run_id — the ingest linkage rides line_item_id and the
          // event_id itself (`theatrical:{sender}:`); a split run does not
          // exist yet at parse time, and no id space may be conflated.
          split_run_id: null,
        },
        now,
      );
    } catch (cause) {
      // The guards RETURN Failure results; a store-level exception THROWS
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
