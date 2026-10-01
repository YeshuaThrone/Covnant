/**
 * Podcast episode splits + guest milestone bonuses — the pure engine (PR 11,
 * the founder podcast directive). No store, no clock, no IO: the same
 * discipline as the waterfall and IAB engines. The store-touching passes
 * live in ./accrual.ts; this module is the registration gate and the math.
 *
 * House rules, restated as the module's contract:
 * - INTEGER CENTS everywhere — a float amount is refused, never rounded.
 * - ALLOCATIONS PLUS DUST EQUALS GROSS — every allocation carries the
 *   integer-cent remainder as company dust; Σ shares + dust === source.
 * - THE 100.0000% INVARIANT — a split schedule saves only when its shares
 *   sum to exactly 10000 bps (100.0000%); 9999 and 10001 are equally wrong.
 * - FAIL-CLOSED — every validation returns a typed error the caller must
 *   surface; nothing defaults to allowing.
 *
 * Replay safety (the PR #93 per-source guard pattern): bonus accrual event
 * ids are CONTENT-DERIVED — `podcast:bonus:<episode>:<definition>:<threshold>`
 * — so replaying the same episode data derives the same id, and the store's
 * UNIQUE constraint turns the replay into a counted no-op. A threshold
 * crossing accrues exactly once; no clock, no counter drift, no double pay.
 */

import type {
  AllocatedSplit,
  PayeeRole,
  SplitPartyInput,
} from '@/lib/don/types';
import {
  allocateWithCompanyDustSweep,
  zeroBalanceHolds,
} from '@/modules/don/dust';
import {
  BPS_DENOMINATOR,
  COMPANY_VARIANCE_PAYEE_ID,
  UNCLAIMED_HOLDING_PAYEE_ID,
} from '@/modules/don/constants';

/** The episode-split engine's typed refusal. */
export type PodcastSplitsError = {
  ok: false;
  code: string;
  message: string;
};

export const PODCAST_MILESTONE_KINDS = ['downloads', 'reach'] as const;
export type PodcastMilestoneKind = (typeof PODCAST_MILESTONE_KINDS)[number];

/**
 * The match_queue event-id prefixes that count as VERIFIED audience per
 * milestone kind. `downloads` counts qualified impressions only — the rows
 * the IAB pipeline certified (bots, deduped duplicates, and sub-threshold
 * requests never wrote a `podcast:imp:` row). `reach` adds the Channel C
 * subscription rows: verified recurring listening with no impression to
 * qualify. Reach ⊇ downloads, by construction.
 */
export const MILESTONE_EVENT_PREFIXES: Record<
  PodcastMilestoneKind,
  readonly string[]
> = {
  downloads: ['podcast:imp:'],
  reach: ['podcast:imp:', 'podcast:sub:'],
};

/**
 * The payees a split schedule or bonus definition must never name: the
 * unclaimed-holding sentinel (a schedule paying holding would loop held
 * money back into holding) and the platform variance account (dust is
 * swept there by the allocation, never by contract).
 */
const FORBIDDEN_PAYEE_IDS: readonly string[] = [
  UNCLAIMED_HOLDING_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_ID,
];

function isSafePositiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Renders bps as an exact decimal percent string for refusal messages. */
export function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = Math.abs(bps % 100);
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}

/**
 * Validates one per-episode split schedule. Returns the typed error on any
 * violation; the schedule saves only through a `validate`-then-write pass.
 */
export function validateEpisodeSplitSplits(
  splits: readonly SplitPartyInput[],
): PodcastSplitsError | { ok: true; splits: SplitPartyInput[] } {
  if (!Array.isArray(splits) || splits.length === 0) {
    return {
      ok: false,
      code: 'podcast_split_schedule_invalid',
      message: 'An episode split schedule needs at least one holder.',
    };
  }
  const seenPayees = new Set<string>();
  for (const party of splits) {
    if (
      typeof party.payee_id !== 'string' ||
      party.payee_id.trim() === ''
    ) {
      return {
        ok: false,
        code: 'podcast_split_schedule_invalid',
        message: 'Every holder needs a non-empty payee_id.',
      };
    }
    if (FORBIDDEN_PAYEE_IDS.includes(party.payee_id)) {
      return {
        ok: false,
        code: 'podcast_split_schedule_invalid',
        message: `Holder "${party.payee_id}" is a reserved ledger payee — episode splits route to rights holders only.`,
      };
    }
    if (seenPayees.has(party.payee_id)) {
      return {
        ok: false,
        code: 'podcast_split_schedule_invalid',
        message: `Holder "${party.payee_id}" appears twice in the schedule.`,
      };
    }
    seenPayees.add(party.payee_id);
    if (!isValidPayeeRole(party.role)) {
      return {
        ok: false,
        code: 'podcast_split_schedule_invalid',
        message: `Holder "${party.payee_id}" carries an unknown role "${String(party.role)}".`,
      };
    }
    if (typeof party.payee_name !== 'string' || party.payee_name.trim() === '') {
      return {
        ok: false,
        code: 'podcast_split_schedule_invalid',
        message: `Holder "${party.payee_id}" needs a non-empty payee_name.`,
      };
    }
    if (!isSafePositiveInt(party.share_bps)) {
      return {
        ok: false,
        code: 'podcast_split_schedule_invalid',
        message: `Holder "${party.payee_id}" share must be a positive integer bps, got ${party.share_bps}.`,
      };
    }
  }
  const totalBps = splits.reduce((total, party) => total + party.share_bps, 0);
  // The 100.0000% invariant — exact, not rounded, not approximated.
  if (totalBps !== BPS_DENOMINATOR) {
    return {
      ok: false,
      code: 'podcast_split_schedule_invalid',
      message: `Episode split shares must sum to exactly 10000 bps (100.0000%), got ${totalBps} bps (${bpsToPercent(totalBps)}%).`,
    };
  }
  return { ok: true, splits: splits.map((party) => ({ ...party })) };
}

/**
 * Validates a role is one of the ledger's payee roles.
 */
function isValidPayeeRole(role: unknown): role is PayeeRole {
  return (
    role === 'creator' ||
    role === 'label' ||
    role === 'publisher' ||
    role === 'producer' ||
    role === 'other'
  );
}

/** The bonus-definition registration input before it earns an id. */
export type GuestBonusDefinitionInput = {
  guest_payee_id: string;
  guest_payee_name: string;
  milestone_kind: PodcastMilestoneKind;
  threshold: number;
  bonus_amount_cents: number;
  currency: string;
};

/**
 * Validates one guest milestone bonus definition. The threshold and bonus
 * are integer values (a float threshold or bonus is refused, never rounded);
 * the currency must be an alpha-3 code — the bonus posts to holding in it.
 */
export function validateGuestBonusDefinition(
  definition: GuestBonusDefinitionInput,
): PodcastSplitsError | { ok: true } {
  if (
    typeof definition.guest_payee_id !== 'string' ||
    definition.guest_payee_id.trim() === ''
  ) {
    return {
      ok: false,
      code: 'podcast_bonus_definition_invalid',
      message: 'A guest bonus needs a non-empty guest_payee_id.',
    };
  }
  if (FORBIDDEN_PAYEE_IDS.includes(definition.guest_payee_id)) {
    return {
      ok: false,
      code: 'podcast_bonus_definition_invalid',
      message: `Guest "${definition.guest_payee_id}" is a reserved ledger payee — bonuses pay rights holders only.`,
    };
  }
  if (
    typeof definition.guest_payee_name !== 'string' ||
    definition.guest_payee_name.trim() === ''
  ) {
    return {
      ok: false,
      code: 'podcast_bonus_definition_invalid',
      message: 'A guest bonus needs a non-empty guest_payee_name.',
    };
  }
  if (!PODCAST_MILESTONE_KINDS.includes(definition.milestone_kind)) {
    return {
      ok: false,
      code: 'podcast_bonus_definition_invalid',
      message: `milestone_kind must be one of ${PODCAST_MILESTONE_KINDS.join(', ')}, got "${definition.milestone_kind}".`,
    };
  }
  if (!isSafePositiveInt(definition.threshold)) {
    return {
      ok: false,
      code: 'podcast_bonus_definition_invalid',
      message: `threshold must be a safe integer ≥ 1, got ${definition.threshold}.`,
    };
  }
  if (!isSafePositiveInt(definition.bonus_amount_cents)) {
    return {
      ok: false,
      code: 'podcast_bonus_definition_invalid',
      message: `bonus_amount_cents must be a safe integer ≥ 1, got ${definition.bonus_amount_cents}.`,
    };
  }
  if (!/^[A-Z]{3}$/.test(definition.currency)) {
    return {
      ok: false,
      code: 'podcast_bonus_definition_invalid',
      message: `currency must be an alpha-3 ISO code, got "${definition.currency}".`,
    };
  }
  return { ok: true };
}

/**
 * The content-derived bonus accrual event id — the replay arbiter (PR #93's
 * per-source guard pattern). The same episode data replayed derives the same
 * id: identity is WHAT crossed (episode, definition, threshold), never when.
 */
export function guestBonusEventId(
  episodeId: string,
  bonusDefinitionId: string,
  threshold: number,
): string {
  return `podcast:bonus:${episodeId}:${bonusDefinitionId}:${threshold}`;
}

/**
 * Reads the episode id back out of a queue row's raw_payload — the payload
 * is the source of truth (buildPodcastQueueRow writes `podcast.episode_id`),
 * and recovery never re-parses from lossy intermediates. Rows that do not
 * name an episode (music rows, corrupt payloads) contribute nothing — an
 * under-count holds money (fail-closed), it never over-pays.
 */
export function podcastEpisodeIdOfQueueRow(rawPayload: string): string | null {
  try {
    const parsed: unknown = JSON.parse(rawPayload);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const podcast = (parsed as { podcast?: unknown }).podcast;
    if (typeof podcast !== 'object' || podcast === null) return null;
    const episodeId = (podcast as { episode_id?: unknown }).episode_id;
    return typeof episodeId === 'string' && episodeId !== '' ? episodeId : null;
  } catch {
    return null;
  }
}

/**
 * True when the episode's verified count has crossed the threshold. Only
 * VERIFIED counts reach here — the IAB pipeline filters bots, deduped
 * duplicates, and sub-threshold requests before any row is written, so an
 * unverified impression cannot contribute to the number this function sees.
 */
export function crossesMilestone(threshold: number, verifiedCount: number): boolean {
  return (
    isSafePositiveInt(threshold) &&
    Number.isSafeInteger(verifiedCount) &&
    verifiedCount >= threshold
  );
}

export type SplitAllocationResult =
  | { ok: true; splits: AllocatedSplit[]; company_dust_cents: number }
  | PodcastSplitsError;

/**
 * Allocates one funding amount across an episode's holders — floor shares,
 * the integer-cent remainder swept as company dust, and the zero-balance
 * invariant asserted before the result is trusted (a violation is a refusal,
 * never a rounded post). Re-validates the schedule's bps sum so a corrupt
 * stored schedule fails closed instead of allocating against it.
 */
export function allocateSplitCents(
  sourceAmountCents: number,
  splits: readonly SplitPartyInput[],
): SplitAllocationResult {
  if (!Number.isSafeInteger(sourceAmountCents) || sourceAmountCents <= 0) {
    return {
      ok: false,
      code: 'podcast_split_source_invalid',
      message: `Split accrual routes whole integer cents greater than zero, got ${sourceAmountCents}.`,
    };
  }
  const balance = validateEpisodeSplitSplits(splits);
  if (!balance.ok) {
    return {
      ok: false,
      code: 'podcast_split_schedule_invalid',
      message: `Stored schedule refused at accrual time: ${balance.message}`,
    };
  }
  const allocation = allocateWithCompanyDustSweep(sourceAmountCents, balance.splits);
  if (!allocation.ok) {
    return {
      ok: false,
      code: allocation.code,
      message: allocation.message,
    };
  }
  if (!zeroBalanceHolds(sourceAmountCents, allocation.splits, allocation.company_dust_cents)) {
    return {
      ok: false,
      code: 'zero_balance_violation',
      message:
        'sum(allocations) + company_dust !== source amount — split accrual refused.',
    };
  }
  return {
    ok: true,
    splits: allocation.splits,
    company_dust_cents: allocation.company_dust_cents,
  };
}
