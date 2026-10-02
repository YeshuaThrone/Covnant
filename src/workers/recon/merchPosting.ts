/**
 * CVT recon worker — the merch lane's posting pass (PR 22, founder
 * merchandise directive).
 *
 * Mirrors the canonical seam's discipline for the lane's computed nets:
 * every `money` disposition with a verified vault UPC posts its exact
 * integer-cent net realized profit (DTC) / collaborator split share (POD) /
 * reconciled net payout (consignment) / net sale (POS) to
 * UNCLAIMED_HOLDING through postToUnclaimedHolding with source
 * { type: 'match_queue', event_id } — the same quarantine/recovery pairing
 * as every other lane.
 *
 * FAIL-CLOSED, the locked discipline:
 * - the queue row (unique event_id) is already written — a posting failure
 *   leaves the row as the quarantine record and the retry heals it
 *   idempotently through PR 7's journal-ref replay guard;
 * - a replayed post is a counted no-op, never a second credit;
 * - any other failure throws CanonicalPostingError — the job fails with
 *   the row-scoped reason, never silent.
 *
 * NOT POSTED (the queue row stays the visible record):
 * - `held_negative_net` rows — a dump row whose cost legs exceed its gross
 *   is an operator quarantine; a negative holding credit is invented money;
 * - `zero_net` rows — a sub-cent net cannot exist in the integer-cent
 *   ledger and is never rounded up;
 * - UNMATCHED rows — no verified vault asset behind the UPC is
 *   unattributable money; it stays quarantined, never held.
 *
 * WHAT THIS PASS DOES NOT DO (the standing payout gates are untouched):
 * money reaches payees ONLY through the compliance-gated release paths —
 * the collaboration waterfall's `merch_collab_release` flow and
 * releaseUnclaimedHolding's fail-closed evaluatePayoutCompliance. This
 * pass's only ledger writes are the sentinel holding credit and its
 * balanced journal.
 */

import type { Store } from "@/lib/server/store";
import {
  postToUnclaimedHolding,
  type UnclaimedHoldingFailure,
  type UnclaimedHoldingPostSuccess,
} from "@/lib/server/unclaimedHolding";
import { CanonicalPostingError } from "./posting";
import type { MerchWriteCounts } from "./merchQueue";

/** The merch posting counts — folded into the completion result. */
export interface MerchPostingCounts {
  posted: number;
  alreadyPosted: number;
  /** Negative-net rows left quarantined (never posted). */
  heldNegativeNet: number;
  /** Sub-cent nets left in the queue row (never rounded up). */
  zeroNet: number;
  /** Unmatched rows left quarantined (never posted). */
  unmatched: number;
}

/** The replay guard's exact refusal — a 409 is a no-op, anything else fails. */
function isReplayRefusal(failure: UnclaimedHoldingFailure): boolean {
  return failure.status === 409 && failure.code === "unclaimed_holding_already_posted";
}

/**
 * Posts one merch ingest's computed nets. Reads the write pass's outcomes —
 * the net was computed once at write time; the posting pass never recomputes.
 */
export async function postMerchNetsToHolding(
  store: Store,
  counts: MerchWriteCounts,
  now: Date,
): Promise<MerchPostingCounts> {
  const posting: MerchPostingCounts = {
    posted: 0,
    alreadyPosted: 0,
    heldNegativeNet: 0,
    zeroNet: 0,
    unmatched: 0,
  };

  for (const outcome of counts.lineOutcomes) {
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
          // event_id itself (`merch:*:`); a split run does not exist yet at
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
