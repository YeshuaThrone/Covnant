import { describe, expect, it } from "vitest";
import { COMPANY_VARIANCE_PAYEE_ID } from "@/modules/don/constants";
import { CovenantDistributionEngine } from "./distribution";
import { CovenantMasterCollectionEngine } from "./collection";
import { DEFAULT_GLOBAL_COMPANY_NODES } from "./nodes";
import { percentToBps } from "./splits";
import type { SplitParty, UniversalWorkManifest } from "./types";

const seventyThirty: SplitParty[] = [
  {
    partyId: "writer-1",
    name: "Writer",
    role: "COMPOSER",
    sharePercentage: 70,
    payoutWalletOrBank: "acct_writer",
  },
  {
    partyId: "label-1",
    name: "Label",
    role: "LABEL",
    sharePercentage: 30,
    payoutWalletOrBank: "acct_label",
  },
];

function audioManifest(
  overrides: Partial<UniversalWorkManifest> = {},
): UniversalWorkManifest {
  return {
    workId: "work_audio_1",
    title: "Sandbox Track",
    category: "AUDIO",
    identifiers: { isrc: "US-AAA-00-00001" },
    splits: seventyThirty,
    mulCertificateId: "mul_cert_1",
    metadataHash: "hash_1",
    ...overrides,
  };
}

describe("CovenantDistributionEngine", () => {
  const engine = new CovenantDistributionEngine();

  it("accepts a 70/30 split that converts to 10000 bps", () => {
    expect(percentToBps(70) + percentToBps(30)).toBe(10_000);
    expect(CovenantDistributionEngine.validateSplits(seventyThirty)).toBe(true);
  });

  it("rejects unbalanced splits", () => {
    const unbalanced: SplitParty[] = [
      { ...seventyThirty[0]!, sharePercentage: 70 },
      { ...seventyThirty[1]!, sharePercentage: 20 },
    ];
    expect(CovenantDistributionEngine.validateSplits(unbalanced)).toBe(false);
    expect(CovenantDistributionEngine.validateSplits([])).toBe(false);
  });

  it("registers a work with bound identifier count", async () => {
    const result = await engine.registerWork(
      audioManifest({
        identifiers: { isrc: "US-AAA-00-00001", iswc: "T-000.000.001-0" },
      }),
    );
    expect(result).toEqual({
      ok: true,
      workId: "work_audio_1",
      codeCount: 2,
    });
  });

  it("does not throw when splits are unaligned", async () => {
    const result = await engine.registerWork(
      audioManifest({
        splits: [{ ...seventyThirty[0]!, sharePercentage: 40 }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("splits_do_not_balance");
    }
  });

  it("pays 70/30 of 100 cents with zero dust", () => {
    const result = engine.calculatePayouts(100, seventyThirty);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected balanced payout");
    }
    expect(result.allocations.map((line) => line.payoutAmountCents)).toEqual([
      70, 30,
    ]);
    expect(result.companyDustCents).toBe(0);
    expect(result.totalAllocatedCents ?? result.grossCents).toBe(100);
    expect(
      result.allocations.reduce((sum, line) => sum + line.payoutAmountCents, 0) +
        result.companyDustCents,
    ).toBe(100);
  });

  it("sweeps leftover dust to platform, never to a creator", () => {
    const result = engine.calculatePayouts(101, seventyThirty);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected dust payout");
    }
    expect(result.allocations[0]).toMatchObject({
      partyId: "writer-1",
      payoutAmountCents: 70,
    });
    expect(result.allocations[1]).toMatchObject({
      partyId: "label-1",
      payoutAmountCents: 30,
    });
    expect(result.companyDustCents).toBe(1);
    expect(result.variancePayeeId).toBe(COMPANY_VARIANCE_PAYEE_ID);
    expect(result.variancePayeeId).toBe("platform");
    expect(
      result.allocations.reduce((sum, line) => sum + line.payoutAmountCents, 0) +
        result.companyDustCents,
    ).toBe(101);
  });
});

describe("CovenantMasterCollectionEngine", () => {
  it("claims nodes that share a bound identifier and leaves the rest pending", async () => {
    const engine = new CovenantMasterCollectionEngine({ apiKey: "sandbox" });
    expect(engine.getSandboxNodeUrl()).toBe("sandbox://covenant-collection");
    expect(engine.listCompanyNodes()).toHaveLength(
      DEFAULT_GLOBAL_COMPANY_NODES.length,
    );

    const result = await engine.enforceMasterGlobalClearance(audioManifest(), [
      "GLOBAL",
    ]);

    const isrcNodes = DEFAULT_GLOBAL_COMPANY_NODES.filter((node) =>
      node.supportedCodes.includes("isrc"),
    ).map((node) => node.companyId);

    expect(result.mulCertificateId).toBe("mul_cert_1");
    expect(result.totalNodesNotified).toBe(DEFAULT_GLOBAL_COMPANY_NODES.length);
    expect(result.successfulClearanceClaims.sort()).toEqual([...isrcNodes].sort());
    expect(result.pendingNodes).not.toContain("SPOTIFY_DIRECT");
    expect(result.pendingNodes).toEqual(
      expect.arrayContaining([
        "THE_MLC_US",
        "EPIC_GAMES_STORE",
        "EIDR_FILM_VAULT",
      ]),
    );
    expect(
      result.successfulClearanceClaims.length + result.pendingNodes.length,
    ).toBe(result.totalNodesNotified);
  });

  it("sweeps UGC revenue in integer cents", async () => {
    const engine = new CovenantMasterCollectionEngine({ apiKey: "sandbox" });
    const result = await engine.processUGCUnclaimedSweep([
      {
        eventId: "ugc_1",
        platform: "TIKTOK",
        videoUrl: "https://example.com/t/1",
        contentIdMatchHash: "match_1",
        creatorHandle: "@one",
        viewCount: 1000,
        estRevenueAccruedCents: 123,
        currency: "USD",
        timestamp: "2026-09-01T00:00:00.000Z",
      },
      {
        eventId: "ugc_2",
        platform: "TIKTOK",
        videoUrl: "https://example.com/t/2",
        contentIdMatchHash: "match_2",
        creatorHandle: "@two",
        viewCount: 500,
        estRevenueAccruedCents: 77,
        currency: "USD",
        timestamp: "2026-09-02T00:00:00.000Z",
      },
      {
        eventId: "ugc_3",
        platform: "INSTAGRAM",
        videoUrl: "https://example.com/ig/3",
        contentIdMatchHash: "match_3",
        creatorHandle: "@three",
        viewCount: 50,
        estRevenueAccruedCents: 10,
        currency: "USD",
        timestamp: "2026-09-03T00:00:00.000Z",
      },
    ]);

    expect(result).toEqual({
      processedEvents: 3,
      totalRecoveredRevenueCents: 210,
      platformBreakdownCents: {
        TIKTOK: 200,
        INSTAGRAM: 10,
      },
    });
  });
});
