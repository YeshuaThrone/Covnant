/**
 * CVT recon worker — the gaming lane's per-item split accrual pass (PR 12).
 *
 * After the posting pass lands the holding credits, this pass locks each
 * credit's per-payee routing against the item's registered split schedule
 * (the founder gaming directive: a primary sale pays studio lead 50 /
 * 3D modeler 30 / audio designer 20, configurable per contract; a
 * secondary resale routes the 5-10% platform creator fee to the original
 * creator OFF THE TOP before the schedule splits the remainder). One
 * payout per funding event, ever — the UNIQUE source_event_id guard turns
 * a replayed ingest into a counted no-op, and the pass runs for replayed
 * queue rows too (a prior run that crashed between posting and accruing
 * heals here — the podcast accrual's precedent).
 *
 * FAIL-CLOSED, the locked discipline:
 * - a stored schedule that no longer balances fails the job (re-validated
 *   at accrual time — never allocated against, never silently skipped);
 * - a secondary line against a schedule WITHOUT a resale-royalty payee
 *   fails the job — never silently unattributed money;
 * - an item with no registered schedule is an honest skip (counted,
 *   reported on the job result) — the holding credit releases through the
 *   manual-split path exactly as it does today; the accrual ledger never
 *   invents a default schedule;
 * - the zero-balance invariant (allocations + dust = routed remainder) is
 *   asserted by the engine before the payout row is trusted — a violation
 *   is a refusal, never a rounded post.
 *
 * The payout row is a ROUTING DECISION over the already-posted holding
 * credit — it moves no money itself. Every payee's actual settlement still
 * runs through the standing payout gates (operator settlement approval,
 * verified KYC, team-member identity checks) via
 * releaseUnclaimedHolding's clearance-gated path.
 */

import type { Store } from "@/lib/server/store";
import type {
  GamingItemSplitScheduleRecord,
  GamingSplitPayoutRecord,
} from "@/modules/don/records";
import type { SplitPartyInput } from "@/lib/don/types";
import { isUniqueViolation } from "./matchQueue";
import { CanonicalPostingError, microsToWholeCents } from "./posting";
import type { GamingLineOutcome } from "./gamingQueue";
import { allocateGamingNetCents, validateGamingItemSchedule } from "./gamingSplits";

/** The accrual pass's honest counts — the job result's gaming block. */
export interface GamingAccrualCounts {
  /** Split payout routings written this pass. */
  payouts: number;
  /** Payout routings that already existed (replays — counted no-ops). */
  replays: number;
  /** Postable lines whose item has no registered schedule (honest skips). */
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
 * routing. Idempotent by construction: a replayed ingest re-derives the
 * same source_event_id and the store's UNIQUE guard counts the no-op.
 */
export async function runGamingSplitAccrualPass(
  store: Store,
  outcomes: readonly GamingLineOutcome[],
  now: Date,
): Promise<GamingAccrualCounts> {
  const counts: GamingAccrualCounts = {
    payouts: 0,
    replays: 0,
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

    // The routed source is the SAME creator net the posting pass credited:
    // gross minus the platform commission minus the engine royalty, from
    // the queue row's recorded values — the accrual re-derives nothing.
    const netMicros =
      outcome.line.grossMicros -
      BigInt(outcome.commissionMicros) -
      BigInt(outcome.engineRoyaltyMicros);
    const sourceAmountCents = microsToWholeCents(netMicros);
    // Sub-cent nets never post (the posting pass's rule) — there is no
    // holding credit to route, so nothing accrues.
    if (sourceAmountCents <= 0) continue;

    const schedule = await store.getGamingItemSplitSchedule(detail.itemId);
    if (schedule === undefined) {
      // Honest skip: the held credit releases through the manual-split path.
      counts.skippedNoSchedule += 1;
      continue;
    }

    // The secondary resale royalty routes off the top to the original
    // creator — a secondary line against a schedule without one is
    // unattributable money: fail the job, never guess a payee.
    const resaleRoyaltyCents = microsToWholeCents(
      BigInt(outcome.resaleRoyaltyMicros),
    );
    if (resaleRoyaltyCents > 0 && schedule.resale_royalty_payee_id === null) {
      throw new CanonicalPostingError(
        outcome.eventId,
        "gaming_resale_payee_missing",
        `gaming_split_accrual_failed:${outcome.eventId}:gaming_resale_payee_missing:secondary sale on item ${detail.itemId} but the schedule registers no resale-royalty payee`,
      );
    }
    const remainderCents = sourceAmountCents - resaleRoyaltyCents;
    const allocation = allocateGamingNetCents(remainderCents, schedule.splits);
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
      resale_royalty_cents: resaleRoyaltyCents,
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
