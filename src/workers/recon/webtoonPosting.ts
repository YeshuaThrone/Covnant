/**
 * CVT recon worker — the webtoon lane's posting pass (PR 19, riding the
 * canonical posting seam).
 *
 * The music lane posts a matched line's GROSS; the podcast lane posts the
 * creator NET of the network commission; the gaming lane posts the creator
 * NET of the storefront's deductions; the LIVESTREAM lane posts the creator
 * NET of the row's own recorded platform fee; the WEBTOON lane posts the
 * creator NET of the layered shares — the pinned 30% Apple/Google App
 * Store cut, then the platform's 30-50% split, both recorded on the queue
 * row at write time — and the KENP pool rows post their pool gross (pages
 * × the period's recorded rate; Amazon pays the pool net of nothing).
 *
 * TWO MOVES, in fail-closed order per line:
 *
 *   1. THE CONVERSION LOG (coin-payout rows only): the durable
 *      virtual-currency conversion record — the founder's rate-logging
 *      rule, made durable BEFORE any fiat movement — rides the PR 13
 *      conversion-log store (UNIQUE on the content-derived
 *      `webtoon:conv:` event id). A replayed log is a counted no-op; the
 *      holding post's own 409 guard still protects the money, so a log
 *      replay never drops a credit and never double-posts one.
 *
 *   2. THE HOLDING POST (every postable money row): the creator net
 *      (gross − the recorded store cut − the recorded platform split) —
 *      or the KENP pool gross — credits UNCLAIMED_HOLDING through the
 *      canonical seam. Money reaches a payee ONLY through the
 *      clearance-gated settlement path (operator settlement approval,
 *      verified KYC, tax-withholding verification). The standing payout
 *      gates are untouched: this lane posts into holding, and holding
 *      alone; settlement stays behind its gates.
 *
 * NEVER POSTED BY THIS SEAM:
 * - quarantined double-dip rows (the `webtoon:held:` disposition — a
 *   monthly-pass claim owns that reading event; the payout row is the
 *   platform's double-report attempt and stays a visible quarantine);
 * - reader-log consumption facts and pass claims (zero-gross rows — a
 *   reading log reports reads, never money);
 * - unmatched lines (a DOI that cross-references no vault asset is not
 *   attributable money);
 * - adjustments and sub-cent nets (integer cents or nothing, never
 *   rounded up).
 *
 * FAIL-CLOSED, the same locked discipline as every other seam:
 * - the match_queue row was written BEFORE this pass (a posting failure
 *   never drops the event — the row stays open, a retry heals
 *   idempotently);
 * - the per-source replay guard (the 409 journal-ref check) makes a
 *   replayed post a counted no-op;
 * - ANY other posting failure throws CanonicalPostingError — never
 *   silent, never swallowed.
 */

import type { Store } from "@/lib/server/store";
import {
  postToUnclaimedHolding,
  type UnclaimedHoldingFailure,
  type UnclaimedHoldingPostSuccess,
} from "@/lib/server/unclaimedHolding";
import type { GamingDevexConversionLogRecord } from "@/modules/don/records";
import { CanonicalPostingError, microsToWholeCents } from "./posting";
import { StatementParseError } from "./records";
import { webtoonConversionEventId } from "./webtoon";
import { isUniqueViolation } from "./matchQueue";
import type { WebtoonLineOutcome } from "./webtoonQueue";

/** Posting counts for one webtoon ingest — the completion report's inputs. */
export interface WebtoonPostingCounts {
  /** Matched, postable money rows credited this pass. */
  posted: number;
  /** Posts that hit a per-source replay guard (counted no-ops). */
  alreadyPosted: number;
  /** Durable conversion logs written this pass (coin-payout rows). */
  conversionsLogged: number;
  /** Conversion logs that already existed — counted no-ops. */
  conversionsReplayed: number;
  /** Sum of the pinned App Store cut deducted across this pass, micros. */
  storeCutMicrosDeducted: bigint;
  /** Sum of the platform split deducted across this pass, micros. */
  platformSplitMicrosDeducted: bigint;
  /** Integer cents posted for KENP pool rows this pass. */
  kenpPayoutCents: number;
}

/**
 * True when the outcome is this seam's subject: a MONEY disposition (the
 * coin conversion or the KENP pool) the queue actually wrote, whose DOI
 * matched a verified vault asset, not an adjustment, worth at least a
 * whole micro. The recorded deductions ride the outcome — never
 * recomputed here.
 */
export function isPostableWebtoonLine(outcome: WebtoonLineOutcome): boolean {
  return (
    outcome.disposition === "money" &&
    outcome.written &&
    outcome.matchedCbtCode !== null &&
    !outcome.line.isAdjustment &&
    outcome.line.grossMicros > 0n
  );
}

/**
 * Posts every postable webtoon money row — the conversion log first, then
 * the holding post. Idempotent per row exactly like the other seams: a
 * replayed ingest re-enters here, each write reads its replay guard, and
 * the pass completes as counted no-ops. Any other failure throws — the
 * caller's failReconJob records the row-scoped reason and the store's
 * retry budget re-runs the whole idempotent pass.
 */
export async function postWebtoonLines(
  store: Store,
  outcomes: readonly WebtoonLineOutcome[],
  now: Date,
): Promise<WebtoonPostingCounts> {
  const counts: WebtoonPostingCounts = {
    posted: 0,
    alreadyPosted: 0,
    conversionsLogged: 0,
    conversionsReplayed: 0,
    storeCutMicrosDeducted: 0n,
    platformSplitMicrosDeducted: 0n,
    kenpPayoutCents: 0,
  };
  for (const outcome of outcomes) {
    // A line the queue refused to write (its event_id already exists from
    // an earlier run of the same ingest) is money that has ALREADY been
    // counted once. Posting it here would double-count; the queue layer's
    // alreadyPresent count is the honest report for it. Never resurrect a
    // refused write.
    if (!outcome.written) continue;
    // The quarantined double-dip and the zero-gross consumption rows are
    // structurally not this seam's subject — checked before the postable
    // predicate so the disposition is explicit at the read.
    if (outcome.disposition !== "money") continue;
    if (!isPostableWebtoonLine(outcome)) continue;

    const detail = outcome.line.webtoonDetail;
    if (detail === null) {
      throw new StatementParseError(
        `webtoon_detail_missing:row_${outcome.line.lineNumber}`,
      );
    }

    // MOVE 1 — the durable conversion log (coin-payout rows): the recorded
    // conversion's auditable facts, BEFORE the fiat movement it explains
    // (the founder's rate-logging rule, the PR 13 ordering).
    if (detail.kind === "coin_payout") {
      const storeCutMicros = BigInt(outcome.storeCutMicros);
      const platformSplitMicros = BigInt(outcome.platformSplitMicros);
      const netMicros = outcome.line.grossMicros - storeCutMicros - platformSplitMicros;
      const conversionRow: Omit<GamingDevexConversionLogRecord, "id"> = {
        event_id: webtoonConversionEventId(outcome.eventId),
        line_event_id: outcome.eventId,
        platform: detail.platform,
        denomination: detail.coinDenomination ?? "",
        // The exact decimal texts, verbatim from the row — never a
        // recomputation (the recorded conversion log).
        virtual_amount: detail.coinAmount ?? "",
        exchange_rate: detail.exchangeRate ?? "",
        // The creator's net fiat from this conversion — what the layered
        // settlement will carry (the gross and its layers ride the queue
        // row).
        fiat_net_cents: microsToWholeCents(netMicros),
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

    // MOVE 2 — the holding post: the creator net of the recorded layered
    // shares (coin rows), or the pool gross (KENP rows — Amazon pays the
    // pool net of nothing), through the canonical seam.
    let netMicros: bigint;
    if (detail.kind === "coin_payout") {
      const storeCutMicros = BigInt(outcome.storeCutMicros);
      const platformSplitMicros = BigInt(outcome.platformSplitMicros);
      netMicros = outcome.line.grossMicros - storeCutMicros - platformSplitMicros;
    } else {
      netMicros = outcome.line.grossMicros;
    }
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
          // (`webtoon:read:<fp>` / `webtoon:kenp:<period>:<marketplace>:
          // <title>`); no id space may be conflated.
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
      if (detail.kind === "coin_payout") {
        counts.storeCutMicrosDeducted += BigInt(outcome.storeCutMicros);
        counts.platformSplitMicrosDeducted += BigInt(outcome.platformSplitMicros);
      } else {
        counts.kenpPayoutCents += microsToWholeCents(netMicros);
      }
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
