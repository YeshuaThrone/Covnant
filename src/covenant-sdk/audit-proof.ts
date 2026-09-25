import { createHash } from "node:crypto";
import type { LedgerPayoutEntry } from "./split-ledger";
import type { MatchingResult, RoyaltyChannelSource } from "./universal-blackbox-sweeper";

export type ImmutableAuditProofPackage = {
  proofId: string;
  matchedWorkId: string;
  recordId: string;
  sourceChannel: RoyaltyChannelSource;
  recoveredAmountCents: number;
  currency: string;
  auditSignature: string;
  cwrPayload?: string;
  payoutLedger: LedgerPayoutEntry[];
  timestamp: string;
};

function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Deterministic SHA-256 proof token. Same inputs → same signature.
 * Does not use Date.now() or a rolling string hash.
 */
export class CovenantAuditProofGenerator {
  constructor(private readonly clock: () => Date = () => new Date()) {}

  public generateProof(
    match: MatchingResult,
    ledger: LedgerPayoutEntry[],
    cwrPayload?: string,
  ): ImmutableAuditProofPackage {
    const timestamp = this.clock().toISOString();
    const digest = sha256Hex(
      [
        match.matchedWorkId,
        match.recordId,
        String(match.recoveredAmountCents),
        match.currency,
        match.matchType,
        String(match.confidenceScore),
        cwrPayload ?? "",
        String(ledger.reduce((sum, row) => sum + row.netPayoutAmountCents, 0)),
      ].join(":"),
    );
    return {
      proofId: `PRF_${digest.slice(0, 24)}`,
      matchedWorkId: match.matchedWorkId,
      recordId: match.recordId,
      sourceChannel: match.sourceChannel,
      recoveredAmountCents: match.recoveredAmountCents,
      currency: match.currency,
      auditSignature: `COVENANT_SIG_v1_${digest}`,
      cwrPayload,
      payoutLedger: ledger,
      timestamp,
    };
  }
}
