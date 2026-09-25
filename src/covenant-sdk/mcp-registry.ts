import type { ImmutableAuditProofPackage } from "./audit-proof";
import type { MULClearanceNotice } from "./covenant-connectors-and-clearance";
import type { DisputeState } from "./dispute";
import type { SystemSweepResult } from "./facade";
import type { LedgerPayoutEntry } from "./split-ledger";
import type { UniversalWorkManifest } from "./types";
import type { MatchingResult, RoyaltyChannelSource } from "./universal-blackbox-sweeper";
import { ROYALTY_CHANNEL_SOURCES } from "./universal-blackbox-sweeper";

export type ChannelUnclaimedMetric = {
  sourceChannel: RoyaltyChannelSource;
  recoveredAmountCents: number;
  matchCount: number;
};

function upsert<T>(
  map: Map<string, T>,
  key: string,
  value: T,
): void {
  if (!map.has(key)) {
    map.set(key, value);
  }
}

/**
 * Sandbox stand-in for Prisma workManifest / auditProof / matchingRecord.
 * Process-local only. No live database.
 */
export class CovenantMcpRegistry {
  private readonly works = new Map<string, UniversalWorkManifest>();
  private readonly proofs = new Map<string, ImmutableAuditProofPackage>();
  private readonly matches = new Map<string, MatchingResult>();
  private readonly disputes = new Map<string, DisputeState>();
  private readonly payouts = new Map<string, LedgerPayoutEntry>();
  private readonly clearances = new Map<string, MULClearanceNotice>();

  public getWork(workId: string): UniversalWorkManifest | undefined {
    return this.works.get(workId);
  }

  public hasWork(workId: string): boolean {
    return this.works.has(workId);
  }

  public occupiedWorkIds(): Set<string> {
    return new Set(this.works.keys());
  }

  public registerWork(manifest: UniversalWorkManifest): void {
    this.works.set(manifest.workId, manifest);
  }

  public listWorks(): UniversalWorkManifest[] {
    return [...this.works.values()];
  }

  public proofsForWork(matchedWorkId: string): ImmutableAuditProofPackage[] {
    return [...this.proofs.values()].filter(
      (proof) => proof.matchedWorkId === matchedWorkId,
    );
  }

  public listMatches(): MatchingResult[] {
    return [...this.matches.values()];
  }

  public listDisputes(): DisputeState[] {
    return [...this.disputes.values()];
  }

  public listPayouts(): LedgerPayoutEntry[] {
    return [...this.payouts.values()];
  }

  public listClearances(): MULClearanceNotice[] {
    return [...this.clearances.values()];
  }

  /** First-write-wins upserts, equivalent to Prisma upsert with empty update. */
  public recordSweep(result: SystemSweepResult): void {
    for (const match of result.sweeperSummary.matches) {
      upsert(this.matches, match.recordId, match);
    }
    for (const dispute of result.disputesEncountered) {
      upsert(this.disputes, dispute.disputeId, dispute);
    }
    for (const entry of result.payoutLedgers) {
      upsert(this.payouts, entry.entryId, entry);
    }
    for (const notice of result.clearanceNotices) {
      upsert(this.clearances, notice.clearanceId, notice);
    }
    for (const proof of result.auditProofs) {
      upsert(this.proofs, proof.proofId, proof);
    }
  }

  public channelMetrics(): ChannelUnclaimedMetric[] {
    const byChannel = new Map<RoyaltyChannelSource, ChannelUnclaimedMetric>();
    for (const channel of ROYALTY_CHANNEL_SOURCES) {
      byChannel.set(channel, {
        sourceChannel: channel,
        recoveredAmountCents: 0,
        matchCount: 0,
      });
    }
    for (const match of this.matches.values()) {
      const row = byChannel.get(match.sourceChannel);
      if (!row) {
        continue;
      }
      row.recoveredAmountCents += match.recoveredAmountCents;
      row.matchCount += 1;
    }
    return [...byChannel.values()];
  }
}
