import { describe, expect, it } from "vitest";
import { COMPANY_VARIANCE_PAYEE_ID } from "@/modules/don/constants";
import { CovenantDisputeResolutionNode } from "./dispute";
import { CovenantFXSettlementNode } from "./fx";
import { CovenantSplitLedgerNode } from "./split-ledger";
import { CovenantMasterEngineFacade } from "./facade";
import { CovenantMcpRegistry } from "./mcp-registry";
import { CovenantMcpToolHost } from "./mcp-tools";
import type { MatchingResult } from "./universal-blackbox-sweeper";
import type { UniversalWorkManifest } from "./types";

const FIXED_NOW = new Date("2026-09-13T12:00:00.000Z");

const balancedWork: UniversalWorkManifest = {
  workId: "work_audio_1",
  title: "Sandbox Track",
  category: "AUDIO",
  identifiers: { isrc: "USAAA0000001", iswc: "T0000000010" },
  splits: [
    {
      partyId: "writer-1",
      name: "Ada Writer",
      role: "COMPOSER",
      sharePercentage: 70,
      payoutWalletOrBank: "acct_writer",
    },
    {
      partyId: "pub-1",
      name: "Pub",
      role: "PUBLISHER",
      sharePercentage: 30,
      payoutWalletOrBank: "acct_pub",
    },
  ],
  mulCertificateId: "mul_1",
  metadataHash: "hash_1",
};

const match: MatchingResult = {
  matchedWorkId: "work_audio_1",
  recordId: "dsr_1",
  sourceChannel: "DSP_DIRECT_DISTRIBUTION",
  recoveredAmountCents: 10_000,
  currency: "USD",
  matchType: "EXACT_CODE_MATCH",
  confidenceScore: 1,
};

describe("CovenantDisputeResolutionNode", () => {
  it("locks over-claimed splits instead of paying out", () => {
    const node = new CovenantDisputeResolutionNode(() => FIXED_NOW);
    const overclaimed: UniversalWorkManifest = {
      ...balancedWork,
      splits: [
        { ...balancedWork.splits[0]!, sharePercentage: 70 },
        { ...balancedWork.splits[1]!, sharePercentage: 40 },
      ],
    };
    const result = node.evaluateSplitIntegrity(overclaimed, match);
    expect(result.passesIntegrity).toBe(false);
    if (result.passesIntegrity) {
      throw new Error("expected dispute");
    }
    expect(result.dispute.status).toBe("PENDING_LEGAL_HOLD");
    expect(result.dispute.totalClaimedShareBps).toBe(11_000);
    expect(result.dispute.disputeId).toBe("DSP_work_audio_1_dsr_1");
  });
});

describe("CovenantFXSettlementNode", () => {
  it("converts EUR cents to USD cents with integer micros", () => {
    const fx = new CovenantFXSettlementNode(() => FIXED_NOW);
    const result = fx.convertToTargetCurrency(100, "EUR", "USD");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected fx");
    }
    expect(result.convertedAmountCents).toBe(108);
  });
});

describe("CovenantSplitLedgerNode", () => {
  it("skims 10% admin then Don Engine-splits the remainder", () => {
    const ledger = new CovenantSplitLedgerNode({ clock: () => FIXED_NOW });
    const result = ledger.calculatePayoutLedger(balancedWork, match);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ledger");
    }
    expect(result.adminFeeCents).toBe(1_000);
    expect(result.companyDustCents).toBe(0);
    expect(result.variancePayeeId).toBe(COMPANY_VARIANCE_PAYEE_ID);
    expect(result.entries.map((row) => row.netPayoutAmountCents)).toEqual([
      6_300, 2_700,
    ]);
    expect(
      result.entries.reduce((sum, row) => sum + row.netPayoutAmountCents, 0) +
        result.adminFeeCents +
        result.companyDustCents,
    ).toBe(10_000);
  });
});

describe("CovenantMasterEngineFacade + MCP tools", () => {
  it("sweeps a DSR hold, stores proofs, and reports channel metrics", async () => {
    const host = new CovenantMcpToolHost(
      new CovenantMcpRegistry(),
      new CovenantMasterEngineFacade({ clock: () => FIXED_NOW }),
    );
    const registered = await host.callTool("register_work_manifest", {
      manifest: balancedWork,
    });
    expect(registered).toEqual({
      isError: false,
      payload: { ok: true, workId: "work_audio_1", codeCount: 2 },
    });

    const dsr = [
      [
        "SU02",
        "",
        "",
        "Sandbox Track",
        "USAAA0000001",
        "T0000000010",
        "",
        "",
        "US",
        "USD",
        "10.00",
        "",
        "UNMATCHED_HOLD",
      ].join("\t"),
    ].join("\n");

    const sweep = await host.callTool("trigger_blackbox_sweep", {
      cwrRawFeed: "",
      dsrRawFeed: dsr,
    });
    expect(sweep.isError).toBe(false);
    expect(sweep.payload).toEqual(
      expect.objectContaining({
        ok: true,
        recoveredRevenueCents: 1_000,
        matchesFound: 1,
        disputes: 0,
      }),
    );

    const proofs = await host.callTool("query_audit_proof", {
      matchedWorkId: "work_audio_1",
    });
    expect(proofs.isError).toBe(false);
    const proofPayload = proofs.payload as { proofs: { auditSignature: string }[] };
    expect(proofPayload.proofs).toHaveLength(1);
    expect(proofPayload.proofs[0]?.auditSignature.startsWith("COVENANT_SIG_v1_")).toBe(
      true,
    );

    const metrics = await host.callTool("get_channel_unclaimed_metrics", {});
    expect(metrics.isError).toBe(false);
    const metricPayload = metrics.payload as {
      metrics: { sourceChannel: string; recoveredAmountCents: number }[];
    };
    const dsp = metricPayload.metrics.find(
      (row) => row.sourceChannel === "DSP_DIRECT_DISTRIBUTION",
    );
    expect(dsp?.recoveredAmountCents).toBe(1_000);
  });
});
