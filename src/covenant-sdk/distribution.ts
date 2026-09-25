import type { SplitParty, UniversalWorkManifest } from "./types";
import { boundIdentifierCount } from "./identifiers";
import {
  allocateCovenantPayouts,
  splitsBalanceTo100Percent,
  type CovenantPayoutLine,
  type CovenantPayoutResult,
} from "./splits";

export type RegisterWorkResult =
  | { ok: true; workId: string; codeCount: number }
  | { ok: false; code: "splits_do_not_balance"; message: string };

export type CalculatePayoutsResult =
  | (Extract<CovenantPayoutResult, { ok: true }> & {
      allocations: CovenantPayoutLine[];
      totalAllocatedCents: number;
    })
  | Extract<CovenantPayoutResult, { ok: false }>;

/**
 * Registers work manifests and allocates incoming collection in integer cents.
 * Split validation and remainder handling are Don Engine
 * (`allocateWithCompanyDustSweep`).
 */
export class CovenantDistributionEngine {
  public static validateSplits(splits: SplitParty[]): boolean {
    return splitsBalanceTo100Percent(splits);
  }

  public async registerWork(
    manifest: UniversalWorkManifest,
  ): Promise<RegisterWorkResult> {
    if (!CovenantDistributionEngine.validateSplits(manifest.splits)) {
      return {
        ok: false,
        code: "splits_do_not_balance",
        message: `[Covenant Split Error] Split total for work ${manifest.title} is invalid. Must equal 10000 bps.`,
      };
    }

    return {
      ok: true,
      workId: manifest.workId,
      codeCount: boundIdentifierCount(manifest.identifiers),
    };
  }

  public calculatePayouts(
    grossCents: number,
    splits: SplitParty[],
  ): CalculatePayoutsResult {
    const allocated = allocateCovenantPayouts(grossCents, splits);
    if (!allocated.ok) {
      return {
        ok: false,
        code: allocated.code,
        message:
          allocated.code === "invalid_amount"
            ? allocated.message
            : "[Covenant Payout Error] Cannot process payout with unaligned splits.",
      };
    }

    return {
      ...allocated,
      allocations: allocated.lines,
      totalAllocatedCents: allocated.grossCents,
    };
  }
}
