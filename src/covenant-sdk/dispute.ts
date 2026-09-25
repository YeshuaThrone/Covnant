import {
  BPS_DENOMINATOR,
  COMPANY_VARIANCE_PAYEE_ID,
} from "@/modules/don/constants";
import { sumBps } from "@/modules/don/dust";
import { toDonSplitParties } from "./splits";
import type { UniversalWorkManifest } from "./types";
import type { MatchingResult } from "./universal-blackbox-sweeper";

export const DISPUTE_STATUSES = [
  "PENDING_LEGAL_HOLD",
  "RECONCILED",
  "ESCROW_LOCKED",
] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export type DisputeState = {
  disputeId: string;
  workId: string;
  recordId: string;
  totalClaimedShareBps: number;
  status: DisputeStatus;
  partiesInvolved: string[];
  createdAt: string;
};

export type SplitIntegrityResult =
  | { passesIntegrity: true }
  | { passesIntegrity: false; dispute: DisputeState };

/**
 * Over-claim lock. Shares must be exactly 10000 bps. Greater than 100%
 * parks recovered cents (legal hold) instead of paying out.
 */
export class CovenantDisputeResolutionNode {
  constructor(private readonly clock: () => Date = () => new Date()) {}

  public evaluateSplitIntegrity(
    work: UniversalWorkManifest,
    match: MatchingResult,
  ): SplitIntegrityResult {
    const mapped = toDonSplitParties(work.splits);
    const totalClaimedShareBps = mapped === null ? 0 : sumBps(mapped);
    if (totalClaimedShareBps === BPS_DENOMINATOR) {
      return { passesIntegrity: true };
    }
    return {
      passesIntegrity: false,
      dispute: {
        disputeId: `DSP_${work.workId}_${match.recordId}`,
        workId: work.workId,
        recordId: match.recordId,
        totalClaimedShareBps,
        status:
          totalClaimedShareBps > BPS_DENOMINATOR
            ? "PENDING_LEGAL_HOLD"
            : "ESCROW_LOCKED",
        partiesInvolved: work.splits.map((party) => party.partyId),
        createdAt: this.clock().toISOString(),
      },
    };
  }
}
