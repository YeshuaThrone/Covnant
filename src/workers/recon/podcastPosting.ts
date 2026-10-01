/**
 * CVT recon worker — the podcast lane's commission-aware posting pass
 * (PR 10, riding PR #89's canonical posting seam).
 *
 * The music lane posts a matched line's GROSS; the podcast lane posts the
 * creator NET — the network management commission (20-40% band, validated
 * at parse, recorded on the queue row at write time as
 * platform_commission_micros) deducts BEFORE the credit lands in
 * UNCLAIMED_HOLDING. The deduction therefore never touches the ledger's
 * integer-cent credit: the holding receives exactly what the creator is
 * owed, and the commission rides the queue row's records.
 *
 * Channel attribution at the posting gate (the founder's routing rules):
 * - Channel A (programmatic DAI): network-sold inventory deducts the
 *   contract's commission; direct-sold carries none.
 * - Channel B (host-read): bypasses the DAI commission ENTIRELY — direct
 *   attribution, the funds route to the episode host (PR 11's episode
 *   splits reclassify; this seam posts the net with no deduction).
 * - Channel C (subscription): exact recurring money, no commission.
 *
 * FAIL-CLOSED, the same locked discipline as the music seam:
 * - the match_queue row was written BEFORE this pass (a posting failure
 *   never drops the event — the row stays open, a retry heals idempotently);
 * - sponsor-UNVERIFIED host reads never post (their rows live in the
 *   `podcast:held:` quarantine space; the money waits, visible, for the
 *   verified re-report);
 * - unmatched lines never post (a DOI that cross-references no vault show
 *   is not attributable money);
 * - adjustments and sub-cent nets never post (integer cents or nothing,
 *   never rounded up — PR #89's discipline);
 * - the per-source replay guard (PR 7's 409 journal-ref check) makes a
 *   replayed post a counted no-op;
 * - ANY other posting failure throws CanonicalPostingError — never silent,
 *   never swallowed.
 *
 * This pass inherits the music seam's limits verbatim: the standing payout
 * gates are untouched — money reaches a creator payee ONLY through
 * releaseUnclaimedHolding's clearance-gated settlement path (operator
 * settlement approval, verified KYC, and the vertical's compliance state).
 */

import type { Store } from "@/lib/server/store";
import {
  postToUnclaimedHolding,
  type UnclaimedHoldingFailure,
  type UnclaimedHoldingPostSuccess,
} from "@/lib/server/unclaimedHolding";
import { CanonicalPostingError, microsToWholeCents } from "./posting";
import type { ParsedStatementLine } from "./records";
import { StatementParseError } from "./records";
import { isPodcastHeldLine, type PodcastLineOutcome } from "./podcastQueue";

/** Posting counts for one podcast ingest — the completion report's inputs. */
export interface PodcastPostingCounts {
  /** Matched, qualified, verified lines credited to UNCLAIMED_HOLDING. */
  posted: number;
  /** Lines whose post hit the per-source replay guard (counted no-ops). */
  alreadyPosted: number;
  /** Sum of the commission deducted across this pass's posts, micros. */
  commissionMicrosDeducted: bigint;
}

/**
 * True when the podcast line is this seam's subject: a QUALIFIED line
 * (the engine filtered bots/dupes/shorts before the queue saw it — the
 * write layer only produced outcomes for qualified + subscription lines)
 * whose DOI matched a verified vault show, not sponsor-held, not an
 * adjustment, worth at least a whole micro. Commission (if any) deducts
 * before the posting amount is computed.
 */
export function isPostablePodcastLine(
  line: ParsedStatementLine,
  matchedCbtCode: string | null,
): boolean {
  return (
    line.podcastDetail !== null &&
    matchedCbtCode !== null &&
    !isPodcastHeldLine(line) &&
    !line.isAdjustment &&
    line.grossMicros > 0n
  );
}

/**
 * Posts every postable podcast line's creator NET to UNCLAIMED_HOLDING.
 * Idempotent per line exactly like the music seam: a replayed ingest
 * re-enters here, each post reads the 409 journal-ref guard, and the pass
 * completes as counted no-ops. Any other failure throws — the caller's
 * failReconJob records the row-scoped reason and the store's retry budget
 * re-runs the whole idempotent pass.
 */
export async function postPodcastLinesToHolding(
  store: Store,
  outcomes: readonly PodcastLineOutcome[],
  now: Date,
): Promise<PodcastPostingCounts> {
  const counts: PodcastPostingCounts = {
    posted: 0,
    alreadyPosted: 0,
    commissionMicrosDeducted: 0n,
  };
  for (const outcome of outcomes) {
    // A line the queue refused to write (the cross-ingest replay guard —
    // its event_id already exists from another feed's report) is money
    // that has ALREADY been counted once. Posting it here would double-
    // count across feeds; the queue layer's alreadyPresent count is the
    // honest report for it. Never resurrect a refused write.
    if (!outcome.written) continue;
    if (!isPostablePodcastLine(outcome.line, outcome.matchedCbtCode)) continue;

    const detail = outcome.line.podcastDetail;
    if (detail === null) {
      throw new StatementParseError(
        `podcast_detail_missing:row_${outcome.line.lineNumber}`,
      );
    }
    const commissionMicros = BigInt(outcome.commissionMicros);
    const netMicros = outcome.line.grossMicros - commissionMicros;

    let posted: UnclaimedHoldingPostSuccess | UnclaimedHoldingFailure;
    try {
      const amountCents = microsToWholeCents(netMicros);
      // A net worth less than a whole cent cannot exist in the integer-cent
      // ledger — it stays honestly quarantined in its queue row (never
      // rounded up into invented money, never silently dropped).
      if (amountCents <= 0) continue;

      posted = await postToUnclaimedHolding(
        store,
        {
          amount_cents: amountCents,
          currency: outcome.line.currency,
          source: { type: "match_queue", event_id: outcome.eventId },
          // No split_run_id — the ingest linkage rides the event_id itself
          // (`podcast:imp:<fingerprint>` / `podcast:sub:<ingestId>:line:N`);
          // no id space may be conflated.
          split_run_id: null,
        },
        now,
      );
    } catch (cause) {
      // A store-level exception throws raw past PR 7's guards — classify
      // it with the same row-scoped job-failing reason, never swallow.
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new CanonicalPostingError(
        outcome.eventId,
        "ledger_store_error",
        `unclaimed_holding_post_failed:${outcome.eventId}:ledger_store_error:${message}`,
      );
    }
    if (posted.ok) {
      counts.posted += 1;
      counts.commissionMicrosDeducted += commissionMicros;
      continue;
    }
    if (
      posted.status === 409 &&
      posted.code === "unclaimed_holding_already_posted"
    ) {
      counts.alreadyPosted += 1;
      continue;
    }
    throw new CanonicalPostingError(
      outcome.eventId,
      posted.code,
      `unclaimed_holding_post_failed:${outcome.eventId}:${posted.code}:${posted.message}`,
    );
  }
  return counts;
}
