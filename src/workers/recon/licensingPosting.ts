/**
 * CVT recon worker — the brand-licensing lane's holding poster (PR 32, the
 * books/art/theatrical posting pass, without the vault-match gate: the
 * licensing lane's attribution rides the addendum 12 deal-of-record triple
 * (license_id, category_code, territory_iso) on the queue row — no vault
 * identifier kind exists for license scopes, the identifier canon is the v2
 * scope's, and the row is the attribution of record).
 *
 * Posts one licensing ingest's computed Net Licensed Sales to
 * UNCLAIMED_HOLDING. Reads the write pass's outcomes — the net was computed
 * once at write time; the posting pass never recomputes. Dispositions are
 * final here:
 *
 *   `money`  — sales credit holding under the row's event id (the 409
 *              journal-ref guard is the per-source replay; a replayed
 *              ingest counts as alreadyPosted),
 *   `held_negative_net` / `zero_net` — counted, never posted.
 *
 * The sales' money posts in the `licensing:{sender}:` event spaces — the
 * per-sender identity discipline: each statement row's sheet is its own
 * event, replay-guarded per sender's row id of record. The tier walk and
 * the sub-license override live in the cascade pass downstream of this —
 * the posted net is the pool the royalty engine prices from, never a
 * payout itself.
 */

import type { Store } from "@/lib/server/store";
import type { LicensingLineOutcome, LicensingWriteCounts } from "./licensingQueue";
import { CanonicalPostingError } from "./posting";
import {
  postToUnclaimedHolding,
  type UnclaimedHoldingFailure,
  type UnclaimedHoldingPostSuccess,
} from "@/lib/server/unclaimedHolding";

/** Posting counts for one licensing ingest — the honest completion report's inputs. */
export interface LicensingPostingCounts {
  /** Sales credited to UNCLAIMED_HOLDING this pass. */
  posted: number;
  /** Sales whose post hit the per-source replay guard (no-ops). */
  alreadyPosted: number;
  /** Negative-net quarantine rows — visible, never posted. */
  heldNegativeNet: number;
  /** Sub-cent/zero net — recorded, never posted. */
  zeroNet: number;
}

/** The replay guard's exact refusal — a 409 is a no-op, anything else fails. */
function isReplayRefusal(failure: UnclaimedHoldingFailure): boolean {
  return failure.status === 409 && failure.code === "unclaimed_holding_already_posted";
}

export async function postLicensingNetsToHolding(
  store: Store,
  counts: LicensingWriteCounts,
  now: Date,
): Promise<LicensingPostingCounts> {
  const posting: LicensingPostingCounts = {
    posted: 0,
    alreadyPosted: 0,
    heldNegativeNet: 0,
    zeroNet: 0,
  };

  for (const outcome of counts.lineOutcomes as readonly LicensingLineOutcome[]) {
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
          // event_id itself (`licensing:{sender}:`); a split run does not
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
