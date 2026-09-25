import { describe, expect, it } from "vitest";
import type { UniversalWorkManifest } from "./types";
import {
  CWR_REV_LINE_LENGTH,
  CWR_REV_TERMINATOR,
  CovenantClearanceDispatchNode,
  CovenantIngestionEngine,
  parseDecimalDollarsToCents,
} from "./covenant-connectors-and-clearance";
import type { MatchingResult } from "./universal-blackbox-sweeper";

const FIXED_NOW = new Date("2026-09-13T12:00:00.000Z");

function pad(value: string, width: number): string {
  return value.padEnd(width, " ").slice(0, width);
}

function cwrPrefix(type: string, txSeq: number, recSeq: number): string {
  return `${type}${String(txSeq).padStart(8, "0")}${String(recSeq).padStart(8, "0")}`;
}

function nwrLine(txSeq: number, title: string, iswc: string): string {
  return (
    cwrPrefix("NWR", txSeq, 0) +
    pad(title, 60) +
    pad("EN", 2) +
    pad("WORK1", 14) +
    pad(iswc, 11)
  );
}

function recLine(txSeq: number, isrc: string): string {
  return (
    cwrPrefix("REC", txSeq, 1) +
    pad("", 18) +
    pad("000000", 6) +
    pad("", 60) +
    pad("", 60) +
    pad("20260913", 8) +
    pad("SANDBOX TRACK", 60) +
    pad(isrc, 12)
  );
}

function ackLine(txSeq: number, status: string): string {
  return (
    cwrPrefix("ACK", txSeq, 0) +
    String(txSeq).padStart(8, "0") +
    "NWR" +
    "20260913" +
    status
  );
}

describe("parseDecimalDollarsToCents", () => {
  it("converts decimal dollars with integer math", () => {
    expect(parseDecimalDollarsToCents("12.34")).toBe(1234);
    expect(parseDecimalDollarsToCents("12")).toBe(1200);
    expect(parseDecimalDollarsToCents("0.09")).toBe(9);
    expect(parseDecimalDollarsToCents("-1.00")).toBeUndefined();
    expect(parseDecimalDollarsToCents("12.345")).toBeUndefined();
  });
});

describe("CovenantIngestionEngine", () => {
  const ingestion = new CovenantIngestionEngine({ clock: () => FIXED_NOW });

  it("parses CWR ACK NP/RJ/UN into unmatched PRO records", () => {
    const cwr = [
      ackLine(1, "NP"),
      nwrLine(1, "SANDBOX TRACK", "T0000000010"),
      recLine(1, "USAAA0000001"),
      ackLine(2, "AS"),
      nwrLine(2, "ACCEPTED TRACK", "T0000000020"),
    ].join("\n");

    const records = ingestion.parseCWRUnmatchedFeed(cwr, "The MLC");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      recordId: "CWR_ACK_The_MLC_00000001",
      sourceChannel: "PRO_CMO_UNMATCHED",
      sourceEntityName: "The MLC",
      unallocatedAmountCents: 0,
      currency: "USD",
      territory: "US",
      rawMetadata: {
        title: "SANDBOX TRACK",
        identifiers: {
          iswc: "T0000000010",
          isrc: "USAAA0000001",
        },
        confidenceScore: 0.85,
      },
    });
    expect(records[0]?.holdingPeriodEnd).toBe("2029-09-13T12:00:00.000Z");
  });

  it("parses compact CISAC-style CWR ACK/NWR/REC short lines", () => {
    const mockCWR =
      "NWR0000000000000000STATE OF THE ART                                           T1234567890\r\n" +
      "REC000000000000USXX12600001\r\n" +
      "ACK000000000000000000000000000000000000UN\r\n";
    const records = ingestion.parseCWRUnmatchedFeed(mockCWR, "The MLC");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sourceChannel: "PRO_CMO_UNMATCHED",
      unallocatedAmountCents: 0,
      rawMetadata: {
        title: "STATE OF THE ART",
        identifiers: {
          iswc: "T1234567890",
          isrc: "USXX12600001",
        },
      },
    });
  });

  it("parses DDEX DSR unmatched holds as integer cents", () => {
    const dsr = [
      "# comment",
      [
        "SU02",
        "",
        "",
        "Sandbox Track",
        "US-AAA-00-00001",
        "T-000.000.001-0",
        "",
        "",
        "US",
        "USD",
        "12.34",
        "",
        "UNMATCHED_HOLD",
      ].join("\t"),
      [
        "MW01",
        "",
        "",
        "Other",
        "US-BBB-00-00002",
        "",
        "",
        "",
        "GB",
        "USD",
        "1.00",
        "",
        "MATCHED",
      ].join("\t"),
    ].join("\n");

    const records = ingestion.parseDDEXDSRFeed(dsr, "Spotify");
    expect(records).toEqual([
      expect.objectContaining({
        recordId: "DSR_Spotify_1_US_AAA_00_00001",
        sourceChannel: "DSP_DIRECT_DISTRIBUTION",
        sourceEntityName: "Spotify",
        unallocatedAmountCents: 1234,
        currency: "USD",
        territory: "US",
        rawMetadata: {
          title: "Sandbox Track",
          identifiers: {
            isrc: "US-AAA-00-00001",
            iswc: "T-000.000.001-0",
          },
          confidenceScore: 0.9,
        },
      }),
    ]);
    expect(records[0]?.holdingPeriodEnd).toBe("2028-09-13T12:00:00.000Z");
  });

  it("resolves DDEX AS01 resource blocks into SU02 orphaned holds", () => {
    const dsr = [
      ["AS01", "BLK1", "Mapped Title", "", "US-AAA-00-00001", "T-000.000.001-0"].join(
        "\t",
      ),
      [
        "SU02",
        "BLK1",
        "",
        "",
        "",
        "",
        "",
        "",
        "US",
        "USD",
        "5.50",
        "",
        "ORPHANED",
      ].join("\t"),
    ].join("\n");
    const records = ingestion.parseDDEXDSRFeed(dsr, "Spotify");
    expect(records).toEqual([
      expect.objectContaining({
        unallocatedAmountCents: 550,
        rawMetadata: {
          title: "Mapped Title",
          identifiers: {
            isrc: "US-AAA-00-00001",
            iswc: "T-000.000.001-0",
          },
          confidenceScore: 0.9,
        },
      }),
    ]);
  });
});

describe("CovenantClearanceDispatchNode", () => {
  const dispatch = new CovenantClearanceDispatchNode({ clock: () => FIXED_NOW });

  it("generates CWR REV for PRO matches and invoices for sync/gaming", async () => {
    const matches: MatchingResult[] = [
      {
        matchedWorkId: "work_audio_1",
        recordId: "CWR_ACK_The_MLC_00000001",
        sourceChannel: "PRO_CMO_UNMATCHED",
        recoveredAmountCents: 0,
        currency: "USD",
        matchType: "EXACT_CODE_MATCH",
        confidenceScore: 1,
      },
      {
        matchedWorkId: "work_audio_1",
        recordId: "dsp_hold",
        sourceChannel: "DSP_DIRECT_DISTRIBUTION",
        recoveredAmountCents: 1234,
        currency: "USD",
        matchType: "EXACT_CODE_MATCH",
        confidenceScore: 1,
      },
      {
        matchedWorkId: "work_audio_1",
        recordId: "cue_1",
        sourceChannel: "SYNC_CUE_SHEETS",
        recoveredAmountCents: 500,
        currency: "USD",
        matchType: "CUE_SHEET_LEGAL_LOD",
        confidenceScore: 0.95,
      },
    ];

    const work: UniversalWorkManifest = {
      workId: "work_audio_1",
      title: "Sandbox Track",
      category: "AUDIO",
      identifiers: { iswc: "T-000.000.001-0" },
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
    const notices = await dispatch.dispatchClearance(matches, [work]);
    expect(notices).toHaveLength(3);
    expect(notices[0]).toMatchObject({
      clearanceId: "CLR_CWR_ACK_The_MLC_00000001_work_audio_1",
      actionTaken: "CWR_RE_REGISTRATION_GENERATED",
      claimedAmountCents: 0,
    });
    const rev = notices[0]?.cwrRevisionPayload ?? "";
    expect(rev.endsWith(CWR_REV_TERMINATOR)).toBe(true);
    const body = rev.slice(0, CWR_REV_LINE_LENGTH);
    expect(body).toHaveLength(CWR_REV_LINE_LENGTH);
    expect(body.startsWith("REV0000000100000000")).toBe(true);
    expect(body.slice(19, 79).trim()).toBe("SANDBOX TRACK");
    expect(body.slice(79, 90).trim()).toBe("T0000000010");
    expect(notices[1]).toMatchObject({
      actionTaken: "DIRECT_DSP_CLAIM_SUBMITTED",
      claimedAmountCents: 1234,
      cwrRevisionPayload: undefined,
    });
    expect(notices[2]).toMatchObject({
      actionTaken: "MICRO_SYNC_INVOICE_ISSUED",
      claimedAmountCents: 500,
    });
    expect(notices[0]?.clearanceTimestamp).toBe(FIXED_NOW.toISOString());
  });
});
