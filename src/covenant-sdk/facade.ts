import { CovenantIngestionEngine } from "./covenant-connectors-and-clearance";
import { CovenantClearanceDispatchNode } from "./covenant-connectors-and-clearance";
import type { MULClearanceNotice } from "./covenant-connectors-and-clearance";
import { CovenantUniversalBlackBoxSweeper } from "./universal-blackbox-sweeper";
import type {
  BlackBoxReconcileResult,
  UnclaimedRoyaltyRecord,
} from "./universal-blackbox-sweeper";
import { CovenantDisputeResolutionNode } from "./dispute";
import type { DisputeState } from "./dispute";
import { CovenantSplitLedgerNode } from "./split-ledger";
import type { LedgerPayoutEntry } from "./split-ledger";
import { CovenantAuditProofGenerator } from "./audit-proof";
import type { ImmutableAuditProofPackage } from "./audit-proof";
import { CovenantFXSettlementNode } from "./fx";
import type { UniversalWorkManifest } from "./types";
import {
  dispatchCovenantWebhook,
  type DispatchWebhookOptions,
} from "./outbound-webhook";

export type SystemSweepResult = {
  sweeperSummary: BlackBoxReconcileResult;
  disputesEncountered: DisputeState[];
  payoutLedgers: LedgerPayoutEntry[];
  clearanceNotices: MULClearanceNotice[];
  auditProofs: ImmutableAuditProofPackage[];
};

/**
 * End-to-end sandbox pipeline: ingest → match → dispute → ledger → clearance → audit.
 * Settlement math stays in Don Engine. No live DSP/PRO HTTP.
 */
export class CovenantMasterEngineFacade {
  private readonly ingestion: CovenantIngestionEngine;
  private readonly sweeper: CovenantUniversalBlackBoxSweeper;
  private readonly disputeNode: CovenantDisputeResolutionNode;
  private readonly ledgerNode: CovenantSplitLedgerNode;
  private readonly clearanceNode: CovenantClearanceDispatchNode;
  private readonly auditNode: CovenantAuditProofGenerator;
  private readonly webhookOptions: DispatchWebhookOptions;

  constructor(
    options: { clock?: () => Date; webhook?: DispatchWebhookOptions } = {},
  ) {
    const clock = options.clock ?? (() => new Date());
    this.ingestion = new CovenantIngestionEngine({ clock });
    this.sweeper = new CovenantUniversalBlackBoxSweeper();
    this.disputeNode = new CovenantDisputeResolutionNode(clock);
    this.ledgerNode = new CovenantSplitLedgerNode({
      clock,
      fxNode: new CovenantFXSettlementNode(clock),
    });
    this.clearanceNode = new CovenantClearanceDispatchNode({ clock });
    this.auditNode = new CovenantAuditProofGenerator(clock);
    this.webhookOptions = { clock, ...options.webhook };
  }

  public async executeSystemSweep(
    cwrRawFeed: string,
    dsrRawFeed: string,
    registeredWorks: UniversalWorkManifest[],
    extraRecords: UnclaimedRoyaltyRecord[] = [],
  ): Promise<SystemSweepResult> {
    const cwrRecords = this.ingestion.parseCWRUnmatchedFeed(
      cwrRawFeed,
      "The MLC",
    );
    const dsrRecords = this.ingestion.parseDDEXDSRFeed(
      dsrRawFeed,
      "Spotify_DSR",
    );
    const sweeperSummary = await this.sweeper.reconcileBlackBoxPool(
      [...cwrRecords, ...dsrRecords, ...extraRecords],
      registeredWorks,
    );

    const disputesEncountered: DisputeState[] = [];
    const payoutLedgers: LedgerPayoutEntry[] = [];
    const worksById = new Map(
      registeredWorks.map((work) => [work.workId, work]),
    );

    for (const match of sweeperSummary.matches) {
      const work = worksById.get(match.matchedWorkId);
      if (!work) {
        continue;
      }
      const disputeCheck = this.disputeNode.evaluateSplitIntegrity(work, match);
      if (!disputeCheck.passesIntegrity) {
        disputesEncountered.push(disputeCheck.dispute);
        continue;
      }
      const ledger = this.ledgerNode.calculatePayoutLedger(work, match);
      if (ledger.ok) {
        payoutLedgers.push(...ledger.entries);
      }
    }

    const clearanceNotices = await this.clearanceNode.dispatchClearance(
      sweeperSummary.matches,
      registeredWorks,
    );

    const auditProofs: ImmutableAuditProofPackage[] = [];
    for (const match of sweeperSummary.matches) {
      const matchingLedger = payoutLedgers.filter(
        (row) => row.workId === match.matchedWorkId,
      );
      const matchingNotice = clearanceNotices.find(
        (notice) =>
          notice.matchedWorkId === match.matchedWorkId &&
          notice.targetChannel === match.sourceChannel,
      );
      auditProofs.push(
        this.auditNode.generateProof(
          match,
          matchingLedger,
          matchingNotice?.cwrRevisionPayload,
        ),
      );
    }

    const result = {
      sweeperSummary,
      disputesEncountered,
      payoutLedgers,
      clearanceNotices,
      auditProofs,
    };
    await dispatchCovenantWebhook(
      "sweep.completed",
      {
        recoveredRevenueCents: sweeperSummary.totalRecoveredRevenueCents,
        matchesFound: sweeperSummary.matches.length,
        disputes: disputesEncountered.length,
        channelBreakdownCents: sweeperSummary.channelBreakdownCents,
      },
      this.webhookOptions,
    );
    return result;
  }
}
