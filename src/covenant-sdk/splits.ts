/**
 * Convert Covenant split parties onto Don Engine bps, then allocate
 * integer cents with a Primary Company Variance Sweep.
 */

import type { PayeeRole, SplitPartyInput } from "@/lib/don/types";
import {
  BPS_DENOMINATOR,
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
} from "@/modules/don/constants";
import {
  allocateWithCompanyDustSweep,
  percentToBps,
  sumBps,
  zeroBalanceHolds,
} from "@/modules/don/dust";
import type { SplitParty, SplitPartyRole } from "./types";

export { percentToBps };

const ROLE_TO_PAYEE: Record<SplitPartyRole, PayeeRole> = {
  COMPOSER: "creator",
  LYRICIST: "creator",
  FEATURED_ARTIST: "creator",
  AUTHOR: "creator",
  DESIGNER: "creator",
  PRODUCER: "producer",
  LABEL: "label",
  PUBLISHER: "publisher",
  SUB_PUBLISHER: "publisher",
  DEVELOPER: "other",
  RIGHTS_HOLDER: "other",
  ADMINISTRATOR: "other",
};

export function shareBpsOf(party: SplitParty): number | null {
  if (party.shareBps !== undefined) {
    if (
      !Number.isSafeInteger(party.shareBps) ||
      party.shareBps < 1 ||
      party.shareBps > BPS_DENOMINATOR
    ) {
      return null;
    }
    return party.shareBps;
  }
  if (party.sharePercentage === undefined) {
    return null;
  }
  if (
    !Number.isFinite(party.sharePercentage) ||
    party.sharePercentage <= 0 ||
    party.sharePercentage > 100
  ) {
    return null;
  }
  const bps = percentToBps(party.sharePercentage);
  if (bps < 1 || bps > BPS_DENOMINATOR) {
    return null;
  }
  return bps;
}

export function toDonSplitParties(
  splits: readonly SplitParty[],
): SplitPartyInput[] | null {
  const mapped: SplitPartyInput[] = [];
  for (const party of splits) {
    const bps = shareBpsOf(party);
    if (bps === null) {
      return null;
    }
    mapped.push({
      payee_id: party.partyId,
      payee_name: party.name,
      role: ROLE_TO_PAYEE[party.role],
      share_bps: bps,
    });
  }
  return mapped;
}

export function splitsBalanceTo100Percent(
  splits: readonly SplitParty[],
): boolean {
  const mapped = toDonSplitParties(splits);
  if (mapped === null) {
    return false;
  }
  return sumBps(mapped) === BPS_DENOMINATOR;
}

export type CovenantPayoutLine = {
  partyId: string;
  name: string;
  role: SplitPartyRole;
  shareBps: number;
  payoutAmountCents: number;
  currency: "USD";
};

export type CovenantPayoutResult =
  | {
      ok: true;
      lines: CovenantPayoutLine[];
      companyDustCents: number;
      variancePayeeId: typeof COMPANY_VARIANCE_PAYEE_ID;
      variancePayeeName: typeof COMPANY_VARIANCE_PAYEE_NAME;
      grossCents: number;
      zeroBalance: true;
    }
  | {
      ok: false;
      code: "splits_do_not_balance" | "invalid_amount";
      message: string;
    };

export function allocateCovenantPayouts(
  grossCents: number,
  splits: readonly SplitParty[],
): CovenantPayoutResult {
  if (!Number.isSafeInteger(grossCents) || grossCents < 1) {
    return {
      ok: false,
      code: "invalid_amount",
      message: "grossCents must be a whole number of at least 1.",
    };
  }
  const mapped = toDonSplitParties(splits);
  if (mapped === null || sumBps(mapped) !== BPS_DENOMINATOR) {
    const total = mapped === null ? 0 : sumBps(mapped);
    return {
      ok: false,
      code: "splits_do_not_balance",
      message: `Party shares must sum to 10000 bps (100%), got ${total}.`,
    };
  }
  const allocated = allocateWithCompanyDustSweep(grossCents, mapped);
  if (!allocated.ok) {
    return allocated;
  }
  if (
    !zeroBalanceHolds(
      grossCents,
      allocated.splits,
      allocated.company_dust_cents,
    )
  ) {
    return {
      ok: false,
      code: "splits_do_not_balance",
      message: "sum(creator_allocations) + company_dust !== gross.",
    };
  }
  return {
    ok: true,
    lines: allocated.splits.map((line, index) => ({
      partyId: line.payee_id,
      name: line.payee_name,
      role: splits[index]!.role,
      shareBps: line.share_bps,
      payoutAmountCents: line.amount_cents,
      currency: "USD",
    })),
    companyDustCents: allocated.company_dust_cents,
    variancePayeeId: COMPANY_VARIANCE_PAYEE_ID,
    variancePayeeName: COMPANY_VARIANCE_PAYEE_NAME,
    grossCents,
    zeroBalance: true,
  };
}
