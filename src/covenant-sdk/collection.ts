import { DEFAULT_GLOBAL_COMPANY_NODES } from "./nodes";
import type {
  GlobalCompanyNode,
  SocialMediaUGCEvent,
  TerritoryType,
  UniversalWorkManifest,
} from "./types";
import { hasBoundIdentifier } from "./identifiers";

export type EnforceClearanceResult = {
  mulCertificateId: string;
  totalNodesNotified: number;
  successfulClearanceClaims: string[];
  pendingNodes: string[];
  targetTerritories: TerritoryType[];
};

export type UgcSweepResult = {
  processedEvents: number;
  totalRecoveredRevenueCents: number;
  platformBreakdownCents: Record<string, number>;
};

/**
 * In-memory sandbox collection + MUL dispatch.
 * Does not call live DSP / PRO / Covenant HTTP endpoints.
 */
export class CovenantMasterCollectionEngine {
  private readonly apiKey: string;
  private readonly covenantNodeUrl: string;
  private readonly registeredCompanyNodes = new Map<string, GlobalCompanyNode>();

  constructor(config: { apiKey: string; covenantNodeUrl?: string }) {
    this.apiKey = config.apiKey;
    this.covenantNodeUrl = config.covenantNodeUrl ?? "sandbox://covenant-collection";
    this.initializeGlobalCompanyNodes();
  }

  public getSandboxNodeUrl(): string {
    return this.covenantNodeUrl;
  }

  public hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  public listCompanyNodes(): GlobalCompanyNode[] {
    return [...this.registeredCompanyNodes.values()];
  }

  private initializeGlobalCompanyNodes(): void {
    for (const node of DEFAULT_GLOBAL_COMPANY_NODES) {
      this.registeredCompanyNodes.set(node.companyId, node);
    }
  }

  public async enforceMasterGlobalClearance(
    manifest: UniversalWorkManifest,
    targetTerritories: TerritoryType[] = ["GLOBAL"],
  ): Promise<EnforceClearanceResult> {
    const successfulClearanceClaims: string[] = [];
    const pendingNodes: string[] = [];

    for (const [nodeId, node] of this.registeredCompanyNodes.entries()) {
      const hasMatchingCode = node.supportedCodes.some((code) =>
        hasBoundIdentifier(manifest.identifiers, code),
      );
      if (hasMatchingCode) {
        successfulClearanceClaims.push(nodeId);
      } else {
        pendingNodes.push(nodeId);
      }
    }

    return {
      mulCertificateId: manifest.mulCertificateId,
      totalNodesNotified: this.registeredCompanyNodes.size,
      successfulClearanceClaims,
      pendingNodes,
      targetTerritories,
    };
  }

  public async processUGCUnclaimedSweep(
    events: SocialMediaUGCEvent[],
  ): Promise<UgcSweepResult> {
    let totalRecoveredRevenueCents = 0;
    const platformBreakdownCents: Record<string, number> = {};

    for (const event of events) {
      const cents = Math.trunc(event.estRevenueAccruedCents);
      totalRecoveredRevenueCents += cents;
      platformBreakdownCents[event.platform] =
        (platformBreakdownCents[event.platform] ?? 0) + cents;
    }

    return {
      processedEvents: events.length,
      totalRecoveredRevenueCents,
      platformBreakdownCents,
    };
  }
}
