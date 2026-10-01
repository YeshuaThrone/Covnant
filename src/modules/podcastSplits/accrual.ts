/**
 * Podcast episode splits + guest milestone bonuses — the store-touching
 * passes (PR 11). The pure gate lives in ./engine.ts; this module registers
 * schedules and bonus definitions through that gate and runs the two
 * idempotent accrual passes the podcast lane's worker calls after the
 * canonical posting pass:
 *
 *   ensureEpisodeSplitAccruals — for every postable line, locks the
 *   per-holder routing of its holding credit against the episode's
 *   registered schedule (one accrual per funding event, ever; a replay is a
 *   counted no-op through the UNIQUE source_event_id guard).
 *
 *   ensureGuestMilestoneBonuses — for every episode in the ingest, reads the
 *   episode's LIFETIME verified count from the queue rows and accrues every
 *   bonus definition whose contractual threshold has crossed. The bonus
 *   posts to UNCLAIMED_HOLDING through the PR #89 canonical seam — the
 *   money waits behind the standing payout gates (operator settlement
 *   approval, verified KYC, and the podcast vertical's IAB-impression /
 *   network-commission compliance state) exactly like every other held
 *   credit; the accrual row is the once-only milestone record.
 *
 * FAIL-CLOSED, the locked discipline:
 * - a schedule that does not sum to exactly 10000 bps fails the accrual
 *   (never allocated against, never silently skipped) — fail-closed twice
 *   is once too rarely;
 * - the bonus accrual row is written (insert-as-lock) BEFORE the holding
 *   post moves money and DELETED when the post refuses — the retryable
 *   lifecycle of the film routing decision (migration 0016's precedent);
 * - any posting failure throws CanonicalPostingError with the row-scoped
 *   reason — never silent, never swallowed;
 * - an episode with no registered schedule is an honest skip (counted,
 *   reported on the job result) — the holding credit releases through the
 *   manual-split path exactly as it does today; the accrual ledger never
 *   invents a default schedule.
 */

import { randomUUID } from "node:crypto";

import type { Store } from "@/lib/server/store";
import type {
  PodcastEpisodeSplitAccrualRecord,
  PodcastEpisodeSplitScheduleRecord,
  PodcastGuestBonusDefinitionRecord,
  PodcastGuestBonusAccrualRecord,
  PodcastGuestBonusAccrualStatus,
  PodcastMilestoneKind,
} from "@/modules/don/records";
import type { SplitPartyInput } from "@/lib/don/types";
import { isUniqueViolation } from "@/workers/recon/matchQueue";
import { CanonicalPostingError } from "@/workers/recon/posting";
import type { PodcastLineOutcome } from "@/workers/recon/podcastQueue";
import { microsToWholeCents } from "@/workers/recon/posting";
import { postToUnclaimedHolding } from "@/lib/server/unclaimedHolding";
import {
  allocateSplitCents,
  crossesMilestone,
  guestBonusEventId,
  MILESTONE_EVENT_PREFIXES,
  validateEpisodeSplitSplits,
  validateGuestBonusDefinition,
  type GuestBonusDefinitionInput,
} from "./engine";

/** The pass's honest counts — the job result's PR 11 block. */
export interface PodcastSplitBonusCounts {
  /** Split accrual rows written this pass. */
  splitAccruals: number;
  /** Split accruals that already existed (replays — counted no-ops). */
  splitReplays: number;
  /** Postable lines whose episode has no registered schedule (honest skips). */
  splitSkippedNoSchedule: number;
  /** Guest bonuses accrued (holding credits posted) this pass. */
  bonusAccrued: number;
  /** Milestone crossings that already accrued (replays — counted no-ops). */
  bonusReplayed: number;
}

/** The schedule registration input before it earns its version. */
export type EpisodeSplitScheduleInput = {
  episode_id: string;
  show_cbt_code: string | null;
  splits: SplitPartyInput[];
};

/**
 * Registers (or re-registers) one episode's split schedule through the
 * engine's gate. First registration is version 1; every accepted
 * re-registration bumps the version. Existing accruals keep the version
 * they were computed against — history is never rewritten.
 */
export async function registerEpisodeSplitSchedule(
  store: Store,
  input: EpisodeSplitScheduleInput,
  now: Date,
): Promise<PodcastEpisodeSplitScheduleRecord> {
  if (typeof input.episode_id !== "string" || input.episode_id.trim() === "") {
    throw new Error("podcast_split_schedule_invalid: episode_id is required");
  }
  const validated = validateEpisodeSplitSplits(input.splits);
  if (!validated.ok) {
    throw new Error(`${validated.code}: ${validated.message}`);
  }
  const existing = await store.getPodcastEpisodeSplitSchedule(input.episode_id);
  const record: PodcastEpisodeSplitScheduleRecord = {
    episode_id: input.episode_id,
    show_cbt_code: input.show_cbt_code,
    splits: validated.splits,
    version: existing === undefined ? 1 : existing.version + 1,
    created_at: existing === undefined ? now.toISOString() : existing.created_at,
    updated_at: now.toISOString(),
  };
  return store.upsertPodcastEpisodeSplitSchedule(record);
}

/**
 * Registers one guest milestone bonus definition through the engine's gate.
 * A duplicate (episode, guest, kind, threshold) is a unique violation from
 * the store — surfaced raw, never swallowed.
 */
export async function registerGuestBonusDefinition(
  store: Store,
  episodeId: string,
  input: GuestBonusDefinitionInput,
  now: Date,
): Promise<PodcastGuestBonusDefinitionRecord> {
  const validated = validateGuestBonusDefinition(input);
  if (!validated.ok) {
    throw new Error(`${validated.code}: ${validated.message}`);
  }
  const record: PodcastGuestBonusDefinitionRecord = {
    id: randomUUID(),
    episode_id: episodeId,
    guest_payee_id: input.guest_payee_id,
    guest_payee_name: input.guest_payee_name,
    milestone_kind: input.milestone_kind,
    threshold: input.threshold,
    bonus_amount_cents: input.bonus_amount_cents,
    currency: input.currency,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  return store.insertPodcastGuestBonusDefinition(record);
}

/** True when the line is this ledger's subject — the posting pass's own
 * predicate: matched, not held, not an adjustment, worth a whole micro. */
function isAccrualSubject(outcome: PodcastLineOutcome): boolean {
  return (
    outcome.line.podcastDetail !== null &&
    outcome.matchedCbtCode !== null &&
    !outcome.line.isAdjustment &&
    outcome.line.grossMicros > 0n
  );
}

/**
 * Ensures every postable line's holding credit has its per-holder split
 * accrual. Idempotent by construction: a replayed ingest re-derives the
 * same source_event_id and the store's UNIQUE guard counts the no-op.
 * Runs for replayed lines too (written=false) — if a prior run crashed
 * between posting and accruing, this heals it.
 */
export async function ensureEpisodeSplitAccruals(
  store: Store,
  outcomes: readonly PodcastLineOutcome[],
  now: Date,
): Promise<Pick<PodcastSplitBonusCounts, "splitAccruals" | "splitReplays" | "splitSkippedNoSchedule">> {
  const counts = {
    splitAccruals: 0,
    splitReplays: 0,
    splitSkippedNoSchedule: 0,
  };
  for (const outcome of outcomes) {
    const detail = outcome.line.podcastDetail;
    if (detail === null || !isAccrualSubject(outcome)) continue;

    const commissionMicros = BigInt(outcome.commissionMicros);
    const netMicros = outcome.line.grossMicros - commissionMicros;
    const sourceAmountCents = microsToWholeCents(netMicros);
    // Sub-cent nets never post (the posting pass's rule) — there is no
    // holding credit to route, so nothing accrues.
    if (sourceAmountCents <= 0) continue;

    const schedule = await store.getPodcastEpisodeSplitSchedule(detail.episodeId);
    if (schedule === undefined) {
      // Honest skip: the held credit releases through the manual-split path.
      counts.splitSkippedNoSchedule += 1;
      continue;
    }

    const allocation = allocateSplitCents(sourceAmountCents, schedule.splits);
    if (!allocation.ok) {
      // A stored schedule that no longer balances fails the job — never
      // allocated against, never silently skipped.
      throw new CanonicalPostingError(
        outcome.eventId,
        allocation.code,
        `podcast_split_accrual_failed:${outcome.eventId}:${allocation.code}:${allocation.message}`,
      );
    }

    const accrual: Omit<PodcastEpisodeSplitAccrualRecord, "id"> = {
      episode_id: detail.episodeId,
      source_event_id: outcome.eventId,
      source_amount_cents: sourceAmountCents,
      split_version: schedule.version,
      accruals: allocation.splits,
      company_dust_cents: allocation.company_dust_cents,
      created_at: now.toISOString(),
    };
    try {
      await store.insertPodcastEpisodeSplitAccrual(accrual);
      counts.splitAccruals += 1;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The replay guard: this funding event's accrual already exists —
      // counted no-op, never a second routing decision.
      counts.splitReplays += 1;
    }
  }
  return counts;
}

/**
 * Ensures every crossed guest milestone for the ingest's episodes has its
 * once-only accrual. The verified count is the episode's LIFETIME total
 * over the queue's verified rows (prior ingests included), read fresh
 * every pass — thresholds fire on verified totals, never on raw line counts.
 */
export async function ensureGuestMilestoneBonuses(
  store: Store,
  outcomes: readonly PodcastLineOutcome[],
  now: Date,
): Promise<Pick<PodcastSplitBonusCounts, "bonusAccrued" | "bonusReplayed">> {
  const counts = { bonusAccrued: 0, bonusReplayed: 0 };
  const episodeIds = new Set<string>();
  for (const outcome of outcomes) {
    const detail = outcome.line.podcastDetail;
    if (detail !== null && outcome.matchedCbtCode !== null && !outcome.line.isAdjustment) {
      episodeIds.add(detail.episodeId);
    }
  }

  for (const episodeId of episodeIds) {
    const definitions = await store.listPodcastGuestBonusDefinitions(episodeId);
    if (definitions.length === 0) continue;

    // One scan per kind actually present — the reach count folds the
    // downloads count's rows plus the subscription rows.
    const kinds = new Set<PodcastMilestoneKind>(
      definitions.map((definition) => definition.milestone_kind),
    );
    const verifiedByKind = new Map<PodcastMilestoneKind, number>();
    for (const kind of kinds) {
      verifiedByKind.set(
        kind,
        await store.sumVerifiedImpressionsByEpisode(
          episodeId,
          MILESTONE_EVENT_PREFIXES[kind],
        ),
      );
    }

    for (const definition of definitions) {
      const verifiedCount = verifiedByKind.get(definition.milestone_kind) ?? 0;
      if (!crossesMilestone(definition.threshold, verifiedCount)) continue;

      // The once-only milestone record — content-derived event id, unique
      // in the store and in the GL journal-ref space (the posting seam's
      // per-source guard reads the same id).
      const eventId = guestBonusEventId(episodeId, definition.id, definition.threshold);
      let accrual: PodcastGuestBonusAccrualRecord;
      try {
        accrual = await store.insertPodcastGuestBonusAccrual({
          event_id: eventId,
          episode_id: episodeId,
          bonus_definition_id: definition.id,
          guest_payee_id: definition.guest_payee_id,
          milestone_kind: definition.milestone_kind,
          threshold: definition.threshold,
          verified_count: verifiedCount,
          bonus_amount_cents: definition.bonus_amount_cents,
          status: "accrued" satisfies PodcastGuestBonusAccrualStatus,
          holding_ledger_id: null,
          created_at: now.toISOString(),
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        counts.bonusReplayed += 1;
        continue;
      }

      // The bonus money routes through the SAME canonical seam as every
      // podcast credit: a holding credit behind the standing payout gates.
      // A refused post deletes the accrual row (retryable — the film
      // routing decision's lifecycle) and throws, never silent.
      const posted = await postToUnclaimedHolding(
        store,
        {
          amount_cents: definition.bonus_amount_cents,
          currency: definition.currency,
          source: { type: "match_queue", event_id: eventId },
          split_run_id: null,
        },
        now,
      );
      if (!posted.ok) {
        await store.deletePodcastGuestBonusAccrual(accrual.id);
        throw new CanonicalPostingError(
          eventId,
          posted.code,
          `podcast_bonus_post_failed:${eventId}:${posted.code}:${posted.message}`,
        );
      }
      await store.markPodcastGuestBonusAccrualPosted(
        accrual.id,
        posted.value.holding_credit.id,
      );
      counts.bonusAccrued += 1;
    }
  }
  return counts;
}

/**
 * The worker's one hook (PR 11): after the posting pass lands the holding
 * credits, lock the per-holder routing and fire every crossed milestone.
 * Both passes are idempotent — a replayed ingest counts no-ops.
 */
export async function runPodcastSplitBonusPass(
  store: Store,
  outcomes: readonly PodcastLineOutcome[],
  now: Date,
): Promise<PodcastSplitBonusCounts> {
  const splitCounts = await ensureEpisodeSplitAccruals(store, outcomes, now);
  const bonusCounts = await ensureGuestMilestoneBonuses(store, outcomes, now);
  return { ...splitCounts, ...bonusCounts };
}
