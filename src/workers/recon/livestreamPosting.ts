/**
 * CVT recon worker — the livestream lane's posting pass (PR 14, riding the
 * canonical posting seam).
 *
 * The music lane posts a matched line's GROSS; the podcast lane posts the
 * creator NET of the network commission; the gaming lane posts the creator
 * NET of the storefront's deductions; the LIVESTREAM lane posts the creator
 * NET of the row's own recorded platform fee — only the Kick 95/5 model
 * carries one (Bits and Diamonds convert at creator-net rates, and fiat-
 * native rows post the reported amount).
 *
 * THREE MOVES, in fail-closed order per line:
 *
 *   1. THE CONVERSION LOG (Bits/Diamonds rows only): the durable
 *      virtual-currency conversion record — the founder's rate-logging
 *      rule, made durable BEFORE any fiat movement — rides the PR 13
 *      conversion-log store (UNIQUE on the content-derived
 *      `livestream:conv:` event id). A replayed log is a counted no-op;
 *      the holding post's own 409 guard still protects the money, so a
 *      log replay never drops a credit and never double-posts one.
 *
 *   2. THE PRIZE-POOL LOCK (esports receipt rows): the receipt locks into
 *      the batch's waterfall escrow through PR 14's esports escrow module
 *      (journal kind `esports_pool_escrow_post`, replay-guarded per source
 *      event id) — NEVER the unclaimed holding. A tournament's prize pool
 *      is team money owed to named players and staff.
 *
 *   3. THE HOLDING POST (every other postable row): the creator net
 *      (gross − the row's recorded platform fee) credits UNCLAIMED_HOLDING
 *      through the canonical seam — money reaches a payee ONLY through the
 *      clearance-gated settlement path (operator settlement approval,
 *      verified KYC, the livestream vertical's compliance state). The
 *      standing payout gates are untouched.
 *
 * FAIL-CLOSED, the same locked discipline as every other seam:
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
 */

import type { Store } from "@/lib/server/store";
import {
  postToUnclaimedHolding,
  type UnclaimedHoldingFailure,
  type UnclaimedHoldingPostSuccess,
} from "@/lib/server/unclaimedHolding";
import { postToEsportsPoolEscrow } from "@/lib/server/esportsPoolEscrow";
import type { GamingDevexConversionLogRecord } from "@/modules/don/records";
import { CanonicalPostingError, microsToWholeCents } from "./posting";
import { StatementParseError } from "./records";
import type { ParsedStatementLine } from "./records";
import { livestreamConversionEventId } from "./livestream";
import { isUniqueViolation } from "./matchQueue";
import type { LivestreamLineOutcome } from "./livestreamQueue";

/** Posting counts for one livestream ingest — the completion report's inputs. */
export interface LivestreamPostingCounts {
  /** Matched, postable rows credited/locked this pass. */
  posted: number;
  /** Posts that hit a per-source replay guard (counted no-ops). */
  alreadyPosted: number;
  /** Durable conversion logs written this pass (Bits/Diamonds rows). */
  conversionsLogged: number;
  /** Conversion logs that already existed — counted no-ops. */
  conversionsReplayed: number;
  /** Sum of the Kick platform fee deducted across this pass, micros. */
  platformFeeMicrosDeducted: bigint;
  /** Prize-pool receipts locked into batch escrows this pass. */
  prizePoolsLocked: number;
  /** Prize-pool receipts whose lock hit the replay guard — counted no-ops. */
  prizePoolsReplayed: number;
  /** Integer cents locked into esports batch escrows this pass. */
  prizePoolLockedCents: number;
}

/**
 * True when the livestream line is this seam's subject: a line whose DOI
 * matched a verified vault asset, not an adjustment, worth at least a
 * whole micro. Deductions ride the queue row's recorded platform fee —
 * never recomputed here.
 */
export function isPostableLivestreamLine(
  line: ParsedStatementLine,
  matchedCbtCode: string | null,
): boolean {
  return (
    line.livestreamDetail !== null &&
    matchedCbtCode !== null &&
    !line.isAdjustment &&
    line.grossMicros > 0n
  );
}

/**
 * Posts every postable livestream line — conversion log first, then the
 * prize-pool lock or the holding post. Idempotent per line exactly like
 * the other seams: a replayed ingest re-enters here, each write reads its
 * replay guard, and the pass completes as counted no-ops. Any other
 * failure throws — the caller's failReconJob records the row-scoped
 * reason and the store's retry budget re-runs the whole idempotent pass.
 */
export async function postLivestreamLines(
  store: Store,
  outcomes: readonly LivestreamLineOutcome[],
  now: Date,
): Promise<LivestreamPostingCounts> {
  const counts: LivestreamPostingCounts = {
    posted: 0,
    alreadyPosted: 0,
    conversionsLogged: 0,
    conversionsReplayed: 0,
    platformFeeMicrosDeducted: 0n,
    prizePoolsLocked: 0,
    prizePoolsReplayed: 0,
    prizePoolLockedCents: 0,
  };
  for (const outcome of outcomes) {
    // A line the queue refused to write (its event_id already exists from
    // an earlier run of the same ingest) is money that has ALREADY been
    // counted once. Posting it here would double-count; the queue layer's
    // alreadyPresent count is the honest report for it. Never resurrect a
    // refused write.
    if (!outcome.written) continue;
    if (!isPostableLivestreamLine(outcome.line, outcome.matchedCbtCode)) continue;

    const detail = outcome.line.livestreamDetail;
    if (detail === null) {
      throw new StatementParseError(
        `livestream_detail_missing:row_${outcome.line.lineNumber}`,
      );
    }

    // MOVE 1 — the durable conversion log (Bits/Diamonds rows): the
    // recorded conversion's auditable facts, BEFORE the fiat movement it
    // explains (the founder's rate-logging rule, the PR 13 ordering).
    if (detail.virtualCurrencyCode !== null) {
      const conversionRow: Omit<GamingDevexConversionLogRecord, "id"> = {
        event_id: livestreamConversionEventId(outcome.eventId),
        line_event_id: outcome.eventId,
        platform: detail.platform ?? "esports",
        denomination: detail.virtualCurrencyCode,
        // The exact decimal texts, verbatim from the row — never a
        // recomputation (the recorded conversion log).
        virtual_amount: detail.virtualAmount ?? "",
        exchange_rate: detail.exchangeRate ?? "",
        fiat_net_cents: microsToWholeCents(outcome.line.grossMicros),
        // No payout-batch context exists on a statement row — the
        // platform's fiat settlement confirms through the cashout flow,
        // not the recon lane.
        settlement_batch_ref: "",
        status: "pending_fiat_settlement",
        settled_at: null,
        created_at: now.toISOString(),
      };
      try {
        await store.insertGamingDevexConversionLog(conversionRow);
        counts.conversionsLogged += 1;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // The log already exists (a prior pass crashed between the log and
        // the fiat movement). Count the replay honestly and PROCEED to the
        // post — its own 409 guard makes a re-post a counted no-op, so no
        // credit is dropped and none is doubled.
        counts.conversionsReplayed += 1;
      }
    }

    // MOVE 2 — the prize-pool lock (esports receipt rows): the batch's
    // waterfall escrow, never the unclaimed holding.
    if (detail.prizePoolBatch !== null) {
      const locked = await postToEsportsPoolEscrow(
        store,
        {
          batch: detail.prizePoolBatch,
          amount_cents: microsToWholeCents(outcome.line.grossMicros),
          currency: outcome.line.currency,
          source: { type: "match_queue", event_id: outcome.eventId },
        },
        now,
      );
      if (locked.ok) {
        counts.posted += 1;
        counts.prizePoolsLocked += 1;
        counts.prizePoolLockedCents += locked.value.escrow_credit.amount_cents;
        continue;
      }
      if (
        locked.status === 409 &&
        locked.code === "esports_pool_receipt_already_posted"
      ) {
        counts.alreadyPosted += 1;
        counts.prizePoolsReplayed += 1;
        continue;
      }
      throw new CanonicalPostingError(
        outcome.eventId,
        locked.code,
        `esports_pool_lock_failed:${outcome.eventId}:${locked.code}:${locked.message}`,
      );
    }

    // MOVE 3 — the holding post: the creator net (gross − the row's
    // recorded platform fee) credits UNCLAIMED_HOLDING through the
    // canonical seam.
    const platformFeeMicros = BigInt(outcome.platformFeeMicros);
    const netMicros = outcome.line.grossMicros - platformFeeMicros;
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
          // (`livestream:line:<platform>:<ingestId>:line:N` /
          // `esports:pool:<batch>`); no id space may be conflated.
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
      counts.platformFeeMicrosDeducted += platformFeeMicros;
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
