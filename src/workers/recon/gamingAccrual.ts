/**
 * CVT recon worker — the gaming lane's per-item split accrual pass (PR 12).
 *
 * After the posting pass lands the seller's holding credits (net of the
 * platform commission, the engine royalty, AND the resale pool), this pass
 * locks each credit's per-payee routing and posts the resale royalty as
 * the original creator's OWN micro-payout:
 *
 *   primary sale      — the seller's net routes across the item's
 *                       registered schedule (the founder gaming directive:
 *                       studio lead 50 / 3D modeler 30 / audio designer 20,
 *                       configurable per contract);
 *   secondary resale  — the 5-10% pool (deducted from the seller's net at
 *                       posting) posts as the original creator's own
 *                       holding credit under the `gaming:royalty:` event
 *                       id (per funding line + payee, unique in the GL
 *                       journal-ref space), and the seller's remaining net
 *                       routes across the schedule.
 *
 * One payout routing per funding event, ever — the UNIQUE source_event_id
 * guard turns a replayed ingest into a counted no-op, and the pass runs
 * for replayed queue rows too (a prior run that crashed between posting
 * and accruing heals here — the podcast accrual's precedent).
 *
 * Crash-safe ordering (the two-guard lifecycle):
 *   1. allocation (pure, fail-fast — a corrupt schedule fails the job
 *      before any money moves);
 *   2. the royalty credit posts (the canonical seam's per-source 409 guard
 *      IS the replay protection — a replayed post is a counted no-op);
 *   3. the payout row inserts (UNIQUE source_event_id).
 * Any crash point heals on retry with nothing stranded: the posting seam
 * and the payout row each guard their own idempotency.
 *
 * FAIL-CLOSED, the locked discipline:
 * - a stored schedule that no longer balances fails the job (re-validated
 *   at accrual time — never allocated against, never silently skipped);
 * - a SECONDARY line whose item has no registered schedule FAILS the job —
 *   the pool was already deducted from the seller's credit at posting, so
 *   skipping would strand the royalty; never silently unattributed money;
 * - a secondary line against a schedule WITHOUT a resale-royalty payee
 *   fails the job for the same reason;
 * - a primary line whose item has no registered schedule is an honest
 *   skip (counted, reported on the job result) — the credit releases
 *   through the manual-split path exactly as it does today; the accrual
 *   ledger never invents a default schedule;
 * - the zero-balance invariant (allocations + dust = routed source) is
 *   asserted by the engine before the payout row is trusted — a violation
 *   is a refusal, never a rounded post.
 *
 * The payout row is a ROUTING DECISION over the already-posted holding
 * credits — it moves no money itself. Every payee's actual settlement
 * still runs through the standing payout gates (operator settlement
 * approval, verified KYC, team-member identity checks) via
 * releaseUnclaimedHolding's clearance-gated path.
 */

import type { Store } from "@/lib/server/store";
import type {
  GamingItemSplitScheduleRecord,
  GamingSplitPayoutRecord,
} from "@/modules/don/records";
import type { SplitPartyInput } from "@/lib/don/types";
import {
  postToUnclaimedHolding,
  type UnclaimedHoldingFailure,
  type UnclaimedHoldingPostSuccess,
} from "@/lib/server/unclaimedHolding";
import { gamingResalePayoutEventId } from "./gaming";
import { isUniqueViolation } from "./matchQueue";
import { CanonicalPostingError, microsToWholeCents } from "./posting";
import type { GamingLineOutcome } from "./gamingQueue";
import {
  allocateGamingNetCents,
  validateGamingItemSchedule,
} from "./gamingSplits";

/** The accrual pass's honest counts — the job result's gaming block. */
export interface GamingAccrualCounts {
  /** Split payout routings written this pass. */
  payouts: number;
  /** Payout routings that already existed (replays — counted no-ops). */
  replays: number;
  /** Resale-royalty micro-payout credits posted this pass. */
  royaltiesPosted: number;
  /** Royalty credits whose post hit the per-source replay guard. */
  royaltiesReplayed: number;
  /** Postable lines whose item has no registered schedule (honest skips —
   * primary lines only; a secondary line fails the job instead). */
  skippedNoSchedule: number;
}

/** The schedule registration input before it earns a version. */
export type GamingItemSplitScheduleInput = {
  item_id: string;
  asset_cbt_code?: string | null;
  splits: SplitPartyInput[];
  /** The original-creator payee for the secondary-resale royalty. */
  resale_royalty_payee_id?: string | null;
};

/**
 * Registers (or re-registers) one item's split schedule through the
 * engine's gate. First registration is version 1; every accepted
 * re-registration bumps the version. Existing payouts keep the version
 * they were computed against — history is never rewritten.
 */
export async function registerGamingItemSplitSchedule(
  store: Store,
  input: GamingItemSplitScheduleInput,
  now: Date,
): Promise<GamingItemSplitScheduleRecord> {
  const validated = validateGamingItemSchedule(input);
  if (!validated.ok) {
    throw new Error(`${validated.code}: ${validated.message}`);
  }
  const existing = await store.getGamingItemSplitSchedule(input.item_id);
  const record: GamingItemSplitScheduleRecord = {
    item_id: input.item_id,
    asset_cbt_code: input.asset_cbt_code ?? null,
    splits: validated.splits,
    resale_royalty_payee_id: input.resale_royalty_payee_id ?? null,
    version: existing === undefined ? 1 : existing.version + 1,
    created_at:
      existing === undefined ? now.toISOString() : existing.created_at,
    updated_at: now.toISOString(),
  };
  return store.upsertGamingItemSplitSchedule(record);
}

/**
 * Ensures every postable line's holding credit has its per-payee split
 * routing (and every secondary line's pool its micro-payout). Idempotent
 * by construction: a replayed ingest re-derives the same source_event_id
 * and the per-source UNIQUE guards count the no-ops.
 */
export async function runGamingSplitAccrualPass(
  store: Store,
  outcomes: readonly GamingLineOutcome[],
  now: Date,
): Promise<GamingAccrualCounts> {
  const counts: GamingAccrualCounts = {
    payouts: 0,
    replays: 0,
    royaltiesPosted: 0,
    royaltiesReplayed: 0,
    skippedNoSchedule: 0,
  };
  for (const outcome of outcomes) {
    const detail = outcome.line.gamingDetail;
    if (detail === null) continue;
    if (!outcome.written) continue;
    if (
      outcome.matchedCbtCode === null ||
      outcome.line.isAdjustment ||
      outcome.line.grossMicros <= 0n
    ) {
      continue;
    }

    // The routed source is the SAME seller net the posting pass credited:
    // gross minus the platform commission, the engine royalty, and the
    // resale pool — from the queue row's recorded values, never recomputed.
    const sellerNetMicros =
      outcome.line.grossMicros -
      BigInt(outcome.commissionMicros) -
      BigInt(outcome.engineRoyaltyMicros) -
      BigInt(outcome.resaleRoyaltyMicros);
    const sourceAmountCents = microsToWholeCents(sellerNetMicros);
    // Sub-cent nets never post (the posting pass's rule) — there is no
    // holding credit to route, so nothing accrues.
    if (sourceAmountCents <= 0) continue;

    const isSecondary = detail.saleType === "secondary_resale";
    const schedule = await store.getGamingItemSplitSchedule(detail.itemId);
    if (schedule === undefined) {
      if (isSecondary) {
        // The pool was deducted from the seller's credit at posting —
        // skipping would strand the royalty. Fail the job, never silently
        // unattributed money.
        throw new CanonicalPostingError(
          outcome.eventId,
          "gaming_schedule_missing_resale",
          `gaming_split_accrual_failed:${outcome.eventId}:gaming_schedule_missing_resale:secondary sale on item ${detail.itemId} but no split schedule is registered`,
        );
      }
      // Honest skip: the held credit releases through the manual-split path.
      counts.skippedNoSchedule += 1;
      continue;
    }
    // Re-validate the STORED schedule at use time — a row that no longer
    // balances (a corrupted store, a hand edit) fails the job; it is never
    // allocated against and never silently skipped.
    const validated = validateGamingItemSchedule({
      item_id: schedule.item_id,
      asset_cbt_code: schedule.asset_cbt_code,
      splits: schedule.splits,
      resale_royalty_payee_id: schedule.resale_royalty_payee_id,
    });
    if (!validated.ok) {
      throw new CanonicalPostingError(
        outcome.eventId,
        validated.code,
        `gaming_split_accrual_failed:${outcome.eventId}:${validated.code}:${validated.message}`,
      );
    }

    const resaleRoyaltyCents = microsToWholeCents(
      BigInt(outcome.resaleRoyaltyMicros),
    );
    if (isSecondary) {
      const payeeId = schedule.resale_royalty_payee_id;
      if (payeeId === null) {
        throw new CanonicalPostingError(
          outcome.eventId,
          "gaming_resale_payee_missing",
          `gaming_split_accrual_failed:${outcome.eventId}:gaming_resale_payee_missing:secondary sale on item ${detail.itemId} but the schedule registers no resale-royalty payee`,
        );
      }
      // The pool's own micro-payout — the original creator's holding
      // credit, guarded by the gaming:royalty: event id. Posted BEFORE
      // the payout row so a crash between the two heals on retry (the
      // seam's 409 guard counts the re-post as a no-op).
      if (resaleRoyaltyCents > 0) {
        const royaltyEventId = gamingResalePayoutEventId(
          outcome.eventId,
          payeeId,
        );
        let posted: UnclaimedHoldingPostSuccess | UnclaimedHoldingFailure;
        try {
          posted = await postToUnclaimedHolding(
            store,
            {
              amount_cents: resaleRoyaltyCents,
              currency: outcome.line.currency,
              source: { type: "match_queue", event_id: royaltyEventId },
              split_run_id: null,
            },
            now,
          );
        } catch (cause) {
          const message =
            cause instanceof Error ? cause.message : String(cause);
          throw new CanonicalPostingError(
            royaltyEventId,
            "ledger_store_error",
            `gaming_royalty_post_failed:${royaltyEventId}:ledger_store_error:${message}`,
          );
        }
        if (posted.ok) {
          counts.royaltiesPosted += 1;
        } else if (
          posted.status === 409 &&
          posted.code === "unclaimed_holding_already_posted"
        ) {
          counts.royaltiesReplayed += 1;
        } else {
          throw new CanonicalPostingError(
            royaltyEventId,
            posted.code,
            `gaming_royalty_post_failed:${royaltyEventId}:${posted.code}:${posted.message}`,
          );
        }
      }
    }

    // The seller's remaining net routes across the schedule — floor
    // shares, the integer-cent remainder swept as company dust.
    const allocation = allocateGamingNetCents(sourceAmountCents, validated.splits);
    if (!allocation.ok) {
      throw new CanonicalPostingError(
        outcome.eventId,
        allocation.code,
        `gaming_split_accrual_failed:${outcome.eventId}:${allocation.code}:${allocation.message}`,
      );
    }

    const payout: Omit<GamingSplitPayoutRecord, "id"> = {
      item_id: detail.itemId,
      source_event_id: outcome.eventId,
      source_amount_cents: sourceAmountCents,
      resale_royalty_payee_id: schedule.resale_royalty_payee_id,
      resale_royalty_cents: isSecondary ? resaleRoyaltyCents : 0,
      split_version: schedule.version,
      accruals: allocation.splits,
      company_dust_cents: allocation.company_dust_cents,
      created_at: now.toISOString(),
    };
    try {
      await store.insertGamingSplitPayout(payout);
      counts.payouts += 1;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The replay guard: this funding event's routing already exists —
      // counted no-op, never a second routing decision.
      counts.replays += 1;
    }
  }
  return counts;
}
