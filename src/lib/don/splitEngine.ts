import type { AllocatedLineItem, SplitPartyInput } from "./types";
import {
  allocateLineItemsWithDust,
  allocateWithCompanyDustSweep,
  percentToBps,
  sumBps,
  type DustAllocateResult,
  type SplitBalanceError,
} from "@/modules/don/dust";

export { percentToBps, sumBps };
export type { SplitBalanceError };
export { BPS_DENOMINATOR } from "@/modules/don/constants";

export type AllocateSuccess = Extract<DustAllocateResult, { ok: true }>;
export type AllocateResult = DustAllocateResult;

export function allocateCents(
  amountCents: number,
  splits: readonly SplitPartyInput[],
): AllocateResult {
  return allocateWithCompanyDustSweep(amountCents, splits);
}

export function allocateLineItems(
  items: ReadonlyArray<{
    work_id: string;
    work_title: string;
    amount_cents: number;
    splits: SplitPartyInput[];
  }>,
):
  | {
      ok: true;
      items: AllocatedLineItem[];
      grossCents: number;
      varianceAccountCents: number;
    }
  | SplitBalanceError {
  return allocateLineItemsWithDust(items);
}
