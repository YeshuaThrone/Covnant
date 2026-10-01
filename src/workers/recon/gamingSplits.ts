/**
 * Gaming item splits — the pure engine (PR 12, the founder gaming
 * directive). No store, no clock, no IO: the same discipline as the
 * waterfall, IAB, and podcast-split engines. The store-touching pass lives
 * in ./gamingAccrual.ts; this module is the registration gate and the math.
 *
 * House rules, restated as the module's contract:
 * - INTEGER CENTS everywhere — a float amount is refused, never rounded.
 * - THE 100.0000% INVARIANT — a split schedule saves only when its shares
 *   sum to exactly 10000 bps (100.0000%); 9999 and 10001 are equally wrong.
 * - ROYALTY OFF THE TOP, THEN SPLITS — on a secondary resale the recorded
 *   5-10% royalty routes to the original-creator payee first, and the
 *   splits route the remainder; royalty + allocations + dust === net.
 * - FAIL-CLOSED — every validation returns a typed error the caller must
 *   surface; nothing defaults to allowing.
 */

import type { AllocatedSplit, PayeeRole, SplitPartyInput } from '@/lib/don/types';
import { allocateWithCompanyDustSweep, zeroBalanceHolds } from '@/modules/don/dust';
import {
  BPS_DENOMINATOR,
  COMPANY_VARIANCE_PAYEE_ID,
  UNCLAIMED_HOLDING_PAYEE_ID,
} from '@/modules/don/constants';

/** The gaming split engine's typed refusal. */
export type GamingSplitsError = {
  ok: false;
  code: string;
  message: string;
};

/**
 * The reserved ledger payees a split schedule may never name: the
 * unclaimed-holding account receives routed money, it is never a
 * rights holder; the company variance account is where rounding dust is
 * swept, never where a contract routes.
 */
const FORBIDDEN_PAYEE_IDS: readonly string[] = [
  UNCLAIMED_HOLDING_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_ID,
];

/** The secondary-resale creator-fee band the platform reports (canon: 5-10%). */
export const RESALE_ROYALTY_MIN_BPS = 500;
export const RESALE_ROYALTY_MAX_BPS = 1_000;

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
 * Validates one per-item split schedule's parties. Returns the typed error
 * on any violation; the schedule saves only through a validate-then-write
 * pass.
 */
export function validateGamingItemSplits(
  splits: readonly SplitPartyInput[],
): GamingSplitsError | { ok: true; splits: SplitPartyInput[] } {
  if (!Array.isArray(splits) || splits.length === 0) {
    return {
      ok: false,
      code: 'gaming_split_schedule_invalid',
      message: 'An item split schedule needs at least one payee.',
    };
  }
  const seenPayees = new Set<string>();
  for (const party of splits) {
    if (typeof party.payee_id !== 'string' || party.payee_id.trim() === '') {
      return {
        ok: false,
        code: 'gaming_split_schedule_invalid',
        message: 'Every payee needs a non-empty payee_id.',
      };
    }
    if (FORBIDDEN_PAYEE_IDS.includes(party.payee_id)) {
      return {
        ok: false,
        code: 'gaming_split_schedule_invalid',
        message: `Payee "${party.payee_id}" is a reserved ledger payee — item splits route to rights holders only.`,
      };
    }
    if (seenPayees.has(party.payee_id)) {
      return {
        ok: false,
        code: 'gaming_split_schedule_invalid',
        message: `Payee "${party.payee_id}" appears twice in the schedule.`,
      };
    }
    seenPayees.add(party.payee_id);
    if (!isValidPayeeRole(party.role)) {
      return {
        ok: false,
        code: 'gaming_split_schedule_invalid',
        message: `Payee "${party.payee_id}" carries an unknown role "${String(party.role)}".`,
      };
    }
    if (typeof party.payee_name !== 'string' || party.payee_name.trim() === '') {
      return {
        ok: false,
        code: 'gaming_split_schedule_invalid',
        message: `Payee "${party.payee_id}" needs a non-empty payee_name.`,
      };
    }
    if (!isSafePositiveInt(party.share_bps)) {
      return {
        ok: false,
        code: 'gaming_split_schedule_invalid',
        message: `Payee "${party.payee_id}" share must be a positive integer bps, got ${party.share_bps}.`,
      };
    }
  }
  const totalBps = splits.reduce((total, party) => total + party.share_bps, 0);
  // The 100.0000% invariant — exact, not rounded, not approximated.
  if (totalBps !== BPS_DENOMINATOR) {
    return {
      ok: false,
      code: 'gaming_split_schedule_invalid',
      message: `Item split shares must sum to exactly 10000 bps (100.0000%), got ${totalBps} bps (${bpsToPercent(totalBps)}%).`,
    };
  }
  return { ok: true, splits: splits.map((party) => ({ ...party })) };
}

/** The item-split schedule registration input before it earns a version. */
export type GamingItemSplitScheduleInput = {
  item_id: string;
  asset_cbt_code?: string | null;
  splits: SplitPartyInput[];
  /** The original-creator payee for the secondary-resale royalty, when the contract enables secondary resale. */
  resale_royalty_payee_id?: string | null;
};

/**
 * Validates one item split schedule registration: the item id, the parties
 * (the 100.0000% gate), and the resale payee (present only when the contract
 * enables secondary resale; never a reserved ledger payee).
 */
export function validateGamingItemSchedule(
  schedule: GamingItemSplitScheduleInput,
): GamingSplitsError | { ok: true; splits: SplitPartyInput[] } {
  if (typeof schedule.item_id !== 'string' || schedule.item_id.trim() === '') {
    return {
      ok: false,
      code: 'gaming_split_schedule_invalid',
      message: 'A split schedule needs a non-empty item_id.',
    };
  }
  const parties = validateGamingItemSplits(schedule.splits);
  if (!parties.ok) return parties;
  const resalePayee = schedule.resale_royalty_payee_id;
  if (resalePayee != null) {
    if (typeof resalePayee !== 'string' || resalePayee.trim() === '') {
      return {
        ok: false,
        code: 'gaming_split_schedule_invalid',
        message: 'A resale royalty payee must be a non-empty payee_id.',
      };
    }
    if (FORBIDDEN_PAYEE_IDS.includes(resalePayee)) {
      return {
        ok: false,
        code: 'gaming_split_schedule_invalid',
        message: `Resale payee "${resalePayee}" is a reserved ledger payee — the secondary royalty routes to the original creator.`,
      };
    }
  }
  return { ok: true, splits: parties.splits };
}

/**
 * The secondary-resale royalty for one line, integer cents. The parser
 * already validated the row's reported rate into the 5-10% band — this
 * re-checks it anyway (a corrupt stored rate fails closed, never charges).
 * The truncation floor favors the creator pool: the sub-cent remainder
 * stays in the routed money the splits distribute, never leaks to the
 * platform.
 */
export function resaleRoyaltyCents(
  sourceAmountCents: number,
  rateBps: number,
): { ok: true; royalty_cents: number } | GamingSplitsError {
  if (!Number.isSafeInteger(sourceAmountCents) || sourceAmountCents < 0) {
    return {
      ok: false,
      code: 'gaming_split_source_invalid',
      message: `Resale royalty computes over whole integer cents, got ${sourceAmountCents}.`,
    };
  }
  if (
    !Number.isSafeInteger(rateBps) ||
    rateBps < RESALE_ROYALTY_MIN_BPS ||
    rateBps > RESALE_ROYALTY_MAX_BPS
  ) {
    return {
      ok: false,
      code: 'gaming_resale_royalty_invalid',
      message: `Resale royalty rate must be 500-1000 bps (5-10%), got ${rateBps}.`,
    };
  }
  return { ok: true, royalty_cents: Math.trunc((sourceAmountCents * rateBps) / BPS_DENOMINATOR) };
}

export type GamingSplitAllocationResult =
  | { ok: true; splits: AllocatedSplit[]; company_dust_cents: number }
  | GamingSplitsError;

/**
 * Allocates one routed remainder across an item's payees — floor shares,
 * the integer-cent remainder swept as company dust, and the zero-balance
 * invariant asserted before the result is trusted (a violation is a
 * refusal, never a rounded post). Re-validates the schedule's bps sum so a
 * corrupt stored schedule fails closed instead of allocating against it.
 */
export function allocateGamingNetCents(
  sourceAmountCents: number,
  splits: readonly SplitPartyInput[],
): GamingSplitAllocationResult {
  if (!Number.isSafeInteger(sourceAmountCents) || sourceAmountCents <= 0) {
    return {
      ok: false,
      code: 'gaming_split_source_invalid',
      message: `Split accrual routes whole integer cents greater than zero, got ${sourceAmountCents}.`,
    };
  }
  const balance = validateGamingItemSplits(splits);
  if (!balance.ok) {
    return {
      ok: false,
      code: 'gaming_split_schedule_invalid',
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

/** Validates a role is one of the ledger's payee roles. */
function isValidPayeeRole(role: unknown): role is PayeeRole {
  return (
    role === 'creator' ||
    role === 'label' ||
    role === 'publisher' ||
    role === 'producer' ||
    role === 'other'
  );
}
