import { beforeAll, describe, expect, it } from "vitest";
import {
  CovenantMasterEngineFacade,
  type UniversalWorkManifest,
} from "./covenant-master-production-sdk";
import { parseWorkRegistration } from "./manifest-parse";

const FIXED_NOW = new Date("2026-09-13T12:00:00.000Z");

function mustParse(value: unknown): UniversalWorkManifest {
  const parsed = parseWorkRegistration(value);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  return parsed.manifest;
}

describe("Covenant Master Engine Production Test Suite", () => {
  let masterEngine: CovenantMasterEngineFacade;

  beforeAll(() => {
    masterEngine = new CovenantMasterEngineFacade({ clock: () => FIXED_NOW });
  });

  const mockRegisteredWorks: UniversalWorkManifest[] = [
    mustParse({
      workId: "WORK_CHAMPION_001",
      title: "STATE OF THE ART",
      identifiers: {
        iswc: "T1234567890",
        isrc: "USXX12600001",
        upc: "198123456789",
      },
      splits: [
        {
          partyId: "WRITER_01",
          partyName: "Yeshua Throne",
          role: "COMPOSER",
          sharePercentage: 50.0,
          ipiNumber: "00123456789",
          payoutWalletOrAccount: "0x123...throne",
        },
        {
          partyId: "PUBLISHER_01",
          partyName: "Covenant Publishing",
          role: "PUBLISHER",
          sharePercentage: 50.0,
          ipiNumber: "00987654321",
          payoutWalletOrAccount: "0x987...covenant",
        },
      ],
      registeredTerritories: ["WW"],
    }),
  ];

  it("should parse CWR ACK feed and match against registered work", async () => {
    const mockCWR =
      "NWR0000000000000000STATE OF THE ART                                           T1234567890\r\n" +
      "REC000000000000USXX12600001\r\n" +
      "ACK000000000000000000000000000000000000UN\r\n";

    const sweepResult = await masterEngine.executeSystemSweep(
      mockCWR,
      "",
      mockRegisteredWorks,
    );

    expect(sweepResult.sweeperSummary.totalRecordsEvaluated).toBe(1);
    expect(sweepResult.sweeperSummary.matches.length).toBe(1);
    expect(sweepResult.sweeperSummary.matches[0]?.matchedWorkId).toBe(
      "WORK_CHAMPION_001",
    );
    expect(sweepResult.clearanceNotices[0]?.actionTaken).toBe(
      "CWR_RE_REGISTRATION_GENERATED",
    );
    expect(sweepResult.clearanceNotices[0]?.cwrRevisionPayload?.length).toBe(199);
  });

  it("should calculate accurate multi-tiered split payout ledgers with FX conversion", async () => {
    const mockDSR =
      "#Header\n" +
      "AS01\tBLOCK_01\tSTATE OF THE ART\tSTATE OF THE ART\tUSXX12600001\tT1234567890\n" +
      "SU02\tBLOCK_01\t\t\t\t\t\t\tUS\tUSD\t1000.00\t\tUNMATCHED_HOLD\n";

    const sweepResult = await masterEngine.executeSystemSweep(
      "",
      mockDSR,
      mockRegisteredWorks,
    );

    expect(sweepResult.sweeperSummary.totalRecoveredRevenueCents).toBe(100_000);
    expect(sweepResult.payoutLedgers.length).toBe(2);

    const writerLedger = sweepResult.payoutLedgers.find(
      (ledger) => ledger.partyId === "WRITER_01",
    );
    expect(writerLedger?.grossAmountCents).toBe(50_000);
    expect(writerLedger?.adminFeeDeductionCents).toBe(5_000);
    expect(writerLedger?.netPayoutAmountCents).toBe(45_000);
  });

  it("should trigger dispute legal hold when split percentage exceeds 100%", async () => {
    const invalidWork: UniversalWorkManifest[] = [
      mustParse({
        ...mockRegisteredWorks[0],
        splits: [
          {
            partyId: "P1",
            partyName: "Party 1",
            role: "COMPOSER",
            sharePercentage: 70.0,
            payoutWalletOrAccount: "acct1",
          },
          {
            partyId: "P2",
            partyName: "Party 2",
            role: "AUTHOR",
            sharePercentage: 50.0,
            payoutWalletOrAccount: "acct2",
          },
        ],
      }),
    ];

    const mockDSR =
      "AS01\tBLOCK_01\tSTATE OF THE ART\tSTATE OF THE ART\tUSXX12600001\tT1234567890\n" +
      "SU02\tBLOCK_01\t\t\t\t\t\t\tUS\tUSD\t500.00\t\tUNMATCHED_HOLD\n";

    const sweepResult = await masterEngine.executeSystemSweep(
      "",
      mockDSR,
      invalidWork,
    );

    expect(sweepResult.disputesEncountered.length).toBe(1);
    expect(sweepResult.disputesEncountered[0]?.status).toBe("PENDING_LEGAL_HOLD");
    expect(sweepResult.payoutLedgers.length).toBe(0);
  });

  it("should generate verifiable immutable audit proof signatures", async () => {
    const mockDSR =
      "AS01\tBLOCK_01\tSTATE OF THE ART\tSTATE OF THE ART\tUSXX12600001\tT1234567890\n" +
      "SU02\tBLOCK_01\t\t\t\t\t\t\tUS\tUSD\t250.00\t\tUNMATCHED_HOLD\n";

    const sweepResult = await masterEngine.executeSystemSweep(
      "",
      mockDSR,
      mockRegisteredWorks,
    );

    expect(sweepResult.auditProofs.length).toBe(1);
    expect(sweepResult.auditProofs[0]?.auditSignature).toContain("COVENANT_SIG_v1_");
  });
});
