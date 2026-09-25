import { describe, expect, it } from "vitest";
import {
  CovenantExternalDataIngestionEngine,
  DEFAULT_LUMINATE_RATE_MICROS,
  SANDBOX_LUMINATE_URL,
  yieldCentsFromUnits,
} from "./external-data-connectors";
import { CovenantUniversalBlackBoxSweeper } from "./universal-blackbox-sweeper";
import type { UniversalWorkManifest } from "./types";

const FIXED_NOW = new Date("2026-09-13T12:00:00.000Z");

const championWork: UniversalWorkManifest = {
  workId: "WORK_CHAMPION_001",
  title: "STATE OF THE ART",
  category: "AUDIO",
  identifiers: {
    isrc: "USXX12600001",
    iswc: "T1234567890",
    upc: "198123456789",
  },
  splits: [
    {
      partyId: "WRITER_01",
      name: "Yeshua Throne",
      role: "COMPOSER",
      sharePercentage: 50,
      payoutWalletOrBank: "0x123...throne",
    },
    {
      partyId: "PUBLISHER_01",
      name: "Covenant Publishing",
      role: "PUBLISHER",
      sharePercentage: 50,
      payoutWalletOrBank: "0x987...covenant",
    },
  ],
  mulCertificateId: "mul_WORK_CHAMPION_001",
  metadataHash: "hash_champion_001",
  registeredTerritories: ["WW"],
};

describe("yieldCentsFromUnits", () => {
  it("converts the $0.0038 benchmark with integer micros", () => {
    expect(DEFAULT_LUMINATE_RATE_MICROS).toBe(3_800);
    expect(yieldCentsFromUnits(1_000)).toBe(380);
    expect(yieldCentsFromUnits(1)).toBe(0);
    expect(yieldCentsFromUnits(-1)).toBeUndefined();
    expect(yieldCentsFromUnits(10, 3_800.5)).toBeUndefined();
  });
});

describe("CovenantExternalDataIngestionEngine", () => {
  const engine = new CovenantExternalDataIngestionEngine({
    clock: () => FIXED_NOW,
    apiKey: "unused-sandbox-key",
    baseUrl: "https://api.luminate.com/v1",
  });

  it("stays on the sandbox Luminate URL and never keeps a live host", () => {
    expect(engine.getSandboxNodeUrl()).toBe(SANDBOX_LUMINATE_URL);
    expect(engine.hasSandboxCredential()).toBe(true);
    expect(
      new CovenantExternalDataIngestionEngine().getSandboxNodeUrl(),
    ).toBe(SANDBOX_LUMINATE_URL);
  });

  it("parses Luminate consumption into integer-cent DSP audit records", () => {
    const records = engine.parseLuminateConsumptionData([
      {
        luminateId: "LUM_CHAMPION_001",
        isrc: "USXX12600001",
        upc: "198123456789",
        songTitle: "STATE OF THE ART",
        artistName: "Yeshua Throne",
        labelOrDistributor: "Covenant Distro",
        airplaySpins: 200,
        onDemandAudioStreams: 800,
        physicalSales: 12,
        periodStartDate: "2026-01-01",
        periodEndDate: "2026-01-31",
        marketTerritory: "US",
      },
    ]);

    expect(records).toEqual([
      expect.objectContaining({
        recordId: "LUMINATE_LUM_CHAMPION_001",
        sourceChannel: "DSP_DIRECT_DISTRIBUTION",
        sourceEntityName: "Luminate_Audit_Covenant_Distro",
        unallocatedAmountCents: 380,
        currency: "USD",
        territory: "US",
        rawMetadata: {
          title: "STATE OF THE ART",
          artistOrWriterName: "Yeshua Throne",
          identifiers: {
            isrc: "USXX12600001",
            upc: "198123456789",
          },
          confidenceScore: 0.95,
        },
      }),
    ]);
    expect(records[0]?.holdingPeriodEnd).toBe("2028-09-13T12:00:00.000Z");
  });

  it("emits Jaxsta credits that are unclaimed or missing an ISWC", () => {
    const records = engine.parseJaxstaCreditFeed([
      {
        jaxstaEntityId: "JX_CLAIMED",
        isrc: "USXX12600001",
        iswc: "T1234567890",
        trackTitle: "STATE OF THE ART",
        matchedWriters: [{ writerName: "Yeshua Throne", ipi: "00123456789", role: "Composer" }],
        unclaimedStatusFlag: false,
      },
      {
        jaxstaEntityId: "JX_MISSING_ISWC",
        isrc: "USXX12600001",
        trackTitle: "STATE OF THE ART",
        matchedWriters: [
          { writerName: "Yeshua Throne", role: "Composer" },
          { writerName: "Covenant Publishing", role: "Publisher" },
        ],
        unclaimedStatusFlag: false,
      },
      {
        jaxstaEntityId: "JX_UNCLAIMED",
        iswc: "T1234567890",
        trackTitle: "STATE OF THE ART",
        matchedWriters: [{ writerName: "Yeshua Throne", role: "Composer" }],
        unclaimedStatusFlag: true,
      },
    ]);

    expect(records.map((row) => row.recordId)).toEqual([
      "JAXSTA_JX_MISSING_ISWC",
      "JAXSTA_JX_UNCLAIMED",
    ]);
    expect(records[0]).toMatchObject({
      sourceChannel: "PRO_CMO_UNMATCHED",
      sourceEntityName: "Jaxsta_Credit_Registry",
      unallocatedAmountCents: 0,
      territory: "WW",
      rawMetadata: {
        title: "STATE OF THE ART",
        artistOrWriterName: "Yeshua Throne, Covenant Publishing",
        identifiers: { isrc: "USXX12600001" },
        confidenceScore: 0.92,
      },
    });
    expect(records[1]?.rawMetadata.identifiers).toEqual({ iswc: "T1234567890" });
    expect(records[0]?.holdingPeriodEnd).toBe("2029-09-13T12:00:00.000Z");
  });

  it("sweeps Luminate ISRCs against a registered work", async () => {
    const records = engine.parseLuminateConsumptionData([
      {
        luminateId: "LUM_CHAMPION_001",
        isrc: "USXX12600001",
        songTitle: "STATE OF THE ART",
        artistName: "Yeshua Throne",
        onDemandAudioStreams: 1_000,
        periodStartDate: "2026-01-01",
        periodEndDate: "2026-01-31",
        marketTerritory: "US",
      },
    ]);
    const result = await new CovenantUniversalBlackBoxSweeper().reconcileBlackBoxPool(
      records,
      [championWork],
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.matchedWorkId).toBe("WORK_CHAMPION_001");
    expect(result.totalRecoveredRevenueCents).toBe(380);
  });
});
