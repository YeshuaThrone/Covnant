import type { AllocatedLineItem, AllocatedSplit, SplitPartyInput } from "@/lib/don/types";
import { BPS_DENOMINATOR } from "./constants";

export type SplitBalanceError = {
  ok: false;
  code: "splits_do_not_balance";
  message: string;
};

export type DustAllocation = {
  ok: true;
  splits: AllocatedSplit[];
  company_dust_cents: number;
};

export type DustAllocateResult = DustAllocation | SplitBalanceError;

export function percentToBps(percent: number): number {
  return Math.round(percent * 100);
}

export function sumBps(splits: ReadonlyArray<{ share_bps: number }>): number {
  return splits.reduce((total, split) => total + split.share_bps, 0);
}

export function sumAllocatedCents(
  splits: ReadonlyArray<{ amount_cents: number }>,
): number {
  return splits.reduce((total, split) => total + split.amount_cents, 0);
}

export function zeroBalanceHolds(
  grossCents: number,
  splits: ReadonlyArray<{ amount_cents: number }>,
  companyDustCents: number,
): boolean {
  return sumAllocatedCents(splits) + companyDustCents === grossCents;
}

export function allocateWithCompanyDustSweep(
  amountCents: number,
  splits: readonly SplitPartyInput[],
): DustAllocateResult {
  const totalBps = sumBps(splits);
  if (totalBps !== BPS_DENOMINATOR) {
    return {
      ok: false,
      code: "splits_do_not_balance",
      message: `Party shares must sum to 10000 bps (100%), got ${totalBps}.`,
    };
  }

  const allocated: AllocatedSplit[] = splits.map((party) => ({
    ...party,
    amount_cents: Math.floor((amountCents * party.share_bps) / BPS_DENOMINATOR),
  }));
  const companyDustCents = amountCents - sumAllocatedCents(allocated);

  return {
    ok: true,
    splits: allocated,
    company_dust_cents: companyDustCents,
  };
}

export type DustLineItem = AllocatedLineItem & { company_dust_cents: number };

export function allocateLineItemsWithDust(
  items: ReadonlyArray<{
    work_id: string;
    work_title: string;
    amount_cents: number;
    splits: SplitPartyInput[];
  }>,
):
  | {
      ok: true;
      items: DustLineItem[];
      grossCents: number;
      varianceAccountCents: number;
    }
  | SplitBalanceError {
  const allocated: DustLineItem[] = [];
  let grossCents = 0;
  let varianceAccountCents = 0;
  for (const item of items) {
    const result = allocateWithCompanyDustSweep(item.amount_cents, item.splits);
    if (!result.ok) {
      return result;
    }
    allocated.push({
      work_id: item.work_id,
      work_title: item.work_title,
      amount_cents: item.amount_cents,
      splits: result.splits,
      company_dust_cents: result.company_dust_cents,
    });
    grossCents += item.amount_cents;
    varianceAccountCents += result.company_dust_cents;
  }
  return { ok: true, items: allocated, grossCents, varianceAccountCents };
}
