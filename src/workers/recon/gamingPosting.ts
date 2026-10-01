/**
 * CVT recon worker — the gaming lane's posting pass (PR 12, riding the
 * canonical posting seam).
 *
 * The music lane posts a matched line's GROSS; the podcast lane posts the
 * creator NET of the network commission; the gaming lane posts the creator
 * NET of BOTH gaming deductions — the platform commission (Apple 15-30%,
 * Steam 30, EGS 12, Unity 30, Roblox 30 — validated at parse, recorded on
 * the queue row at write time) and the Unreal engine royalty (the marginal
 * 3.5% above the $1M annual per-product threshold, fixed by the
 * accumulator at write time). The founder directive's "engine-specific
 * threshold deductions applied before net fiat posts" is THIS ordering:
 * neither deduction ever touches the ledger's integer-cent credit — the
 * holding receives exactly what the creator is owed, and the deductions
 * ride the queue row's records.
 *
 * FAIL-CLOSED, the same locked discipline as the music and podcast seams:
 * - the match_queue row was written BEFORE this pass (a posting failure
 *   never drops the event — the row stays open, a retry heals idempotently);
 * - unmatched lines never post (a DOI that cross-references no vault asset
 *   is not attributable money);
 * - adjustments and sub-cent nets never post (integer cents or nothing,
 *   never rounded up);
 * - the per-source replay guard (the 409 journal-ref check) makes a
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
import type { GamingLineOutcome } from "./gamingQueue";

/** Posting counts for one gaming ingest — the completion report's inputs. */
export interface GamingPostingCounts {
  /** Matched, qualified lines credited to UNCLAIMED_HOLDING. */
  posted: number;
  /** Lines whose post hit the per-source replay guard (counted no-ops). */
  alreadyPosted: number;
  /** Sum of the platform commission deducted across this pass, micros. */
  commissionMicrosDeducted: bigint;
  /** Sum of the engine royalty deducted across this pass, micros. */
  engineRoyaltyMicrosDeducted: bigint;
}

/**
 * True when the gaming line is this seam's subject: a line whose DOI
 * matched a verified vault asset, not an adjustment, worth at least a
 * whole micro. Both deductions (commission, engine royalty) deduct before
 * the posting amount is computed — from the queue row's recorded values,
 * never recomputed.
 */
export function isPostableGamingLine(
  line: ParsedStatementLine,
  matchedCbtCode: string | null,
): boolean {
  return (
    line.gamingDetail !== null &&
    matchedCbtCode !== null &&
    !line.isAdjustment &&
    line.grossMicros > 0n
  );
}

/**
 * Posts every postable gaming line's creator NET to UNCLAIMED_HOLDING.
 * Idempotent per line exactly like the other seams: a replayed ingest
 * re-enters here, each post reads the 409 journal-ref guard, and the pass
 * completes as counted no-ops. Any other failure throws — the caller's
 * failReconJob records the row-scoped reason and the store's retry budget
 * re-runs the whole idempotent pass.
 */
export async function postGamingLinesToHolding(
  store: Store,
  outcomes: readonly GamingLineOutcome[],
  now: Date,
): Promise<GamingPostingCounts> {
  const counts: GamingPostingCounts = {
    posted: 0,
    alreadyPosted: 0,
    commissionMicrosDeducted: 0n,
    engineRoyaltyMicrosDeducted: 0n,
  };
  for (const outcome of outcomes) {
    // A line the queue refused to write (its event_id already exists from
    // an earlier run of the same ingest) is money that has ALREADY been
    // counted once. Posting it here would double-count; the queue layer's
    // alreadyPresent count is the honest report for it. Never resurrect a
    // refused write.
    if (!outcome.written) continue;
    if (!isPostableGamingLine(outcome.line, outcome.matchedCbtCode)) continue;

    if (outcome.line.gamingDetail === null) {
      throw new StatementParseError(
        `gaming_detail_missing:row_${outcome.line.lineNumber}`,
      );
    }
    const commissionMicros = BigInt(outcome.commissionMicros);
    const engineRoyalty = BigInt(outcome.engineRoyaltyMicros);
    const netMicros =
      outcome.line.grossMicros - commissionMicros - engineRoyalty;

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
          // (`gaming:line:<platform>:<ingestId>:line:N`); no id space may
          // be conflated.
          split_run_id: null,
        },
        now,
      );
    } catch (cause) {
      // A store-level exception throws raw past the seam's guards —
      // classify it with the same row-scoped job-failing reason, never
      // swallow.
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
      counts.engineRoyaltyMicrosDeducted += engineRoyalty;
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
