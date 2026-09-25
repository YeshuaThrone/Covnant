import { describe, expect, it } from "vitest";
import type { SplitParty, UniversalWorkManifest } from "./types";
import {
  CovenantUniversalBlackBoxSweeper,
  ROYALTY_CHANNEL_SOURCES,
  type UnclaimedRoyaltyRecord,
} from "./universal-blackbox-sweeper";

const splits: SplitParty[] = [
  {
    partyId: "writer-1",
    name: "Ada Writer",
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

function work(
  overrides: Partial<UniversalWorkManifest> = {},
): UniversalWorkManifest {
  return {
    workId: "work_audio_1",
    title: "Sandbox Track",
    category: "AUDIO",
    identifiers: { isrc: "US-AAA-00-00001", iswc: "T-000.000.001-0" },
    splits,
    mulCertificateId: "mul_cert_1",
    metadataHash: "hash_1",
    ...overrides,
  };
}

function record(
  overrides: Partial<UnclaimedRoyaltyRecord> &
    Pick<UnclaimedRoyaltyRecord, "recordId" | "sourceChannel">,
): UnclaimedRoyaltyRecord {
  return {
    sourceEntityName: "The MLC Unmatched Pool",
    unallocatedAmountCents: 100,
    currency: "USD",
    territory: "US",
    rawMetadata: {},
    holdingPeriodEnd: "2026-12-31",
    ...overrides,
  };
}

describe("CovenantUniversalBlackBoxSweeper", () => {
  const sweeper = new CovenantUniversalBlackBoxSweeper();

  it("covers all six royalty channels", () => {
    expect(ROYALTY_CHANNEL_SOURCES).toEqual([
      "PRO_CMO_UNMATCHED",
      "SOCIAL_UGC",
      "SYNC_CUE_SHEETS",
      "DSP_DIRECT_DISTRIBUTION",
      "LIVE_VENUE_PERFORMANCE",
      "GAMING_INTERACTIVE",
    ]);
  });

  it("recovers exact identifier matches in integer cents", async () => {
    const result = await sweeper.reconcileBlackBoxPool(
      [
        record({
          recordId: "mlc_1",
          sourceChannel: "PRO_CMO_UNMATCHED",
          unallocatedAmountCents: 250,
          rawMetadata: { identifiers: { isrc: "US-AAA-00-00001" } },
        }),
        record({
          recordId: "dsp_hold",
          sourceChannel: "DSP_DIRECT_DISTRIBUTION",
          sourceEntityName: "Spotify statement hold",
          unallocatedAmountCents: 40,
          rawMetadata: { identifiers: { iswc: "T-000.000.001-0" } },
        }),
        record({
          recordId: "unmatched",
          sourceChannel: "SOCIAL_UGC",
          unallocatedAmountCents: 99,
          rawMetadata: { identifiers: { isrc: "US-ZZZ-99-99999" } },
        }),
      ],
      [work()],
    );

    expect(result.totalRecordsEvaluated).toBe(3);
    expect(result.totalRecoveredRevenueCents).toBe(290);
    expect(result.channelBreakdownCents.PRO_CMO_UNMATCHED).toBe(250);
    expect(result.channelBreakdownCents.DSP_DIRECT_DISTRIBUTION).toBe(40);
    expect(result.channelBreakdownCents.SOCIAL_UGC).toBe(0);
    expect(result.matches).toEqual([
      expect.objectContaining({
        recordId: "mlc_1",
        matchedWorkId: "work_audio_1",
        matchType: "EXACT_CODE_MATCH",
        recoveredAmountCents: 250,
        confidenceScore: 1,
      }),
      expect.objectContaining({
        recordId: "dsp_hold",
        matchType: "EXACT_CODE_MATCH",
        recoveredAmountCents: 40,
      }),
    ]);
  });

  it("does not treat blank identifier values as a match", async () => {
    const result = await sweeper.reconcileBlackBoxPool(
      [
        record({
          recordId: "blank",
          sourceChannel: "PRO_CMO_UNMATCHED",
          rawMetadata: { identifiers: { isrc: "   " } },
        }),
      ],
      [work()],
    );
    expect(result.matches).toHaveLength(0);
    expect(result.totalRecoveredRevenueCents).toBe(0);
  });

  it("matches sync cue sheets by title when a cueSheetId is present", async () => {
    const result = await sweeper.reconcileBlackBoxPool(
      [
        record({
          recordId: "cue_1",
          sourceChannel: "SYNC_CUE_SHEETS",
          sourceEntityName: "Network cue sheet",
          unallocatedAmountCents: 500,
          rawMetadata: {
            title: "sandbox track",
            cueSheetId: "CUE-88",
          },
        }),
      ],
      [work()],
    );
    expect(result.matches).toEqual([
      expect.objectContaining({
        recordId: "cue_1",
        matchType: "CUE_SHEET_LEGAL_LOD",
        recoveredAmountCents: 500,
        confidenceScore: 0.95,
      }),
    ]);
  });

  it("recovers fuzzy title matches at or above the 0.7 floor", async () => {
    const result = await sweeper.reconcileBlackBoxPool(
      [
        record({
          recordId: "live_1",
          sourceChannel: "LIVE_VENUE_PERFORMANCE",
          sourceEntityName: "Festival setlist",
          unallocatedAmountCents: 75,
          rawMetadata: { title: "Sandbox Track" },
        }),
        record({
          recordId: "game_1",
          sourceChannel: "GAMING_INTERACTIVE",
          sourceEntityName: "Unreal sync",
          unallocatedAmountCents: 18,
          rawMetadata: { artistOrWriterName: "Ada Writer" },
        }),
      ],
      [work()],
    );

    expect(result.matches).toEqual([
      expect.objectContaining({
        recordId: "live_1",
        matchType: "FUZZY_METADATA_MATCH",
        recoveredAmountCents: 75,
        confidenceScore: 0.7,
      }),
    ]);
    expect(result.channelBreakdownCents.LIVE_VENUE_PERFORMANCE).toBe(75);
    expect(result.channelBreakdownCents.GAMING_INTERACTIVE).toBe(0);
  });

  it("skips non-integer or negative amounts without throwing", async () => {
    const result = await sweeper.reconcileBlackBoxPool(
      [
        record({
          recordId: "float",
          sourceChannel: "SOCIAL_UGC",
          unallocatedAmountCents: 12.5 as unknown as number,
          rawMetadata: { identifiers: { isrc: "US-AAA-00-00001" } },
        }),
        record({
          recordId: "negative",
          sourceChannel: "SOCIAL_UGC",
          unallocatedAmountCents: -1,
          rawMetadata: { identifiers: { isrc: "US-AAA-00-00001" } },
        }),
      ],
      [work()],
    );
    expect(result.totalRecordsEvaluated).toBe(2);
    expect(result.totalRecoveredRevenueCents).toBe(0);
    expect(result.matches).toHaveLength(0);
  });

  it("matches zero-cent CWR ACK records so clearance can re-register", async () => {
    const result = await sweeper.reconcileBlackBoxPool(
      [
        record({
          recordId: "ack_np",
          sourceChannel: "PRO_CMO_UNMATCHED",
          unallocatedAmountCents: 0,
          rawMetadata: { identifiers: { isrc: "US-AAA-00-00001" } },
        }),
      ],
      [work()],
    );
    expect(result.matches).toEqual([
      expect.objectContaining({
        recordId: "ack_np",
        matchType: "EXACT_CODE_MATCH",
        recoveredAmountCents: 0,
      }),
    ]);
    expect(result.totalRecoveredRevenueCents).toBe(0);
  });
});
