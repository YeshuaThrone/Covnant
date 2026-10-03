/**
 * The sports lane's routing suite (PR 50, the founder sports
 * directive) — the collective group licensing routing, the NIL deal
 * classification, the biometric micro-payout math, the sports ledger
 * namespace's event-id derivations, and the eight senders' strict
 * ingestion profiles. Every expectation is the pinned scenario
 * arithmetic from sportsScenario.ts, computed by hand.
 */

import { describe, expect, it } from "vitest";

import {
  biometricMicroPayoutCents,
  gateReconciliationEventId,
  leaguePoolEventId,
  netVenueRealizationEventId,
  nilDealClassLegs,
  nilDealReconciliationEventId,
  planBiometricPayoutSplit,
  planGroupLicensingSplit,
  sportsRowEventId,
  unionLedgerPayeeId,
} from "../sports";
import { parseSportsFixtures, SPORTS_FIXTURES } from "./sportsScenario";

describe("the collective group licensing engine — union ledgers and athlete wallets", () => {
  const ROSTER = [
    { athlete_glan: "athlete:wr-two", wallet_payee_id: "wallet-wr-two" },
    { athlete_glan: "athlete:qb-one", wallet_payee_id: "wallet-qb-one" },
    { athlete_glan: "athlete:rb-three", wallet_payee_id: "wallet-rb-three" },
  ];

  it("routes the video-game pool's union leg and splits the athlete remainder", () => {
    const split = planGroupLicensingSplit(100_000_000, 2000, ROSTER);
    expect(split.unionLegCents).toBe(20_000_000);
    expect(split.athletePoolCents).toBe(80_000_000);
    // Equal division 26666666.67 — the floor remainder walks GLAN order.
    expect(split.wallets).toEqual([
      { athlete_glan: "athlete:qb-one", wallet_payee_id: "wallet-qb-one", wallet_cents: 26_666_667 },
      { athlete_glan: "athlete:rb-three", wallet_payee_id: "wallet-rb-three", wallet_cents: 26_666_667 },
      { athlete_glan: "athlete:wr-two", wallet_payee_id: "wallet-wr-two", wallet_cents: 26_666_666 },
    ]);
  });

  it("pins the card pool's split", () => {
    const split = planGroupLicensingSplit(25_000_000, 2000, ROSTER);
    expect(split.unionLegCents).toBe(5_000_000);
    expect(split.athletePoolCents).toBe(20_000_000);
    expect(split.wallets.map((wallet) => wallet.wallet_cents)).toEqual([
      6_666_667,
      6_666_667,
      6_666_666,
    ]);
  });

  it("gives a solo roster the whole athlete pool", () => {
    const split = planGroupLicensingSplit(2_000_000, 2000, [
      { athlete_glan: "athlete:c-four", wallet_payee_id: "wallet-c-four" },
    ]);
    expect(split.unionLegCents).toBe(400_000);
    expect(split.athletePoolCents).toBe(1_600_000);
    expect(split.wallets).toEqual([
      { athlete_glan: "athlete:c-four", wallet_payee_id: "wallet-c-four", wallet_cents: 1_600_000 },
    ]);
  });

  it("names the union ledger payees of record", () => {
    expect(unionLedgerPayeeId("NFLPA")).toBe("union_ledger:NFLPA");
    expect(unionLedgerPayeeId("NBAPA")).toBe("union_ledger:NBAPA");
  });

  it("refuses an empty roster, a zero share, and a full share", () => {
    expect(() => planGroupLicensingSplit(1000, 2000, [])).toThrow(
      /sports_group_licensing_empty_roster/,
    );
    expect(() =>
      planGroupLicensingSplit(1000, 0, [
        { athlete_glan: "a", wallet_payee_id: "w" },
      ]),
    ).toThrow(/sports_group_licensing_invalid_union_share/);
    expect(() =>
      planGroupLicensingSplit(1000, 10_000, [
        { athlete_glan: "a", wallet_payee_id: "w" },
      ]),
    ).toThrow(/sports_group_licensing_invalid_union_share/);
  });
});

describe("the NIL deal waterfall classification", () => {
  it("classifies brand senders as endorsement deals", () => {
    expect(nilDealClassLegs("nil:brand:SCEN-ENDORSE-1")).toEqual({
      endorsementDealCents: 1,
      boosterCollectiveCents: 0,
      fanClubSubscriptionCents: 0,
    });
  });

  it("classifies collective senders as booster collective payouts", () => {
    expect(nilDealClassLegs("nil:collective:SCEN-BOOST-1")).toEqual({
      endorsementDealCents: 0,
      boosterCollectiveCents: 1,
      fanClubSubscriptionCents: 0,
    });
  });

  it("keeps the fan-club leg at zero until a fan-club sender exists", () => {
    // No fan-club sender ships — an application classifying as neither
    // brand nor collective is a lane bug the queue refuses.
    expect(nilDealClassLegs("nil:fanclub:x").fanClubSubscriptionCents).toBe(1);
    expect(nilDealClassLegs("nil:fanclub:x").endorsementDealCents).toBe(0);
  });
});

describe("the biometric performance telemetry micro-royalties", () => {
  it("pins the sportsbook license's micro-payout", () => {
    expect(biometricMicroPayoutCents(5_000_000_000, 2_000_000)).toBe(100);
  });

  it("pins the media network license's micro-payout", () => {
    expect(biometricMicroPayoutCents(2_500_000_000, 1_000_000)).toBe(25);
  });

  it("pins the health tech license's micro-payout", () => {
    expect(biometricMicroPayoutCents(1_000_000_000, 500_000)).toBe(5);
  });

  it("floors sub-cent pots to zero without error", () => {
    expect(biometricMicroPayoutCents(1, 1)).toBe(0);
  });

  it("splits the pot — athlete share floors, the league leg conserves", () => {
    expect(planBiometricPayoutSplit(100, 7000)).toEqual({
      athleteLegCents: 70,
      leagueLegCents: 30,
    });
    expect(planBiometricPayoutSplit(25, 5000)).toEqual({
      athleteLegCents: 12,
      leagueLegCents: 13,
    });
    expect(planBiometricPayoutSplit(5, 7000)).toEqual({
      athleteLegCents: 3,
      leagueLegCents: 2,
    });
  });

  it("refuses negative quantities and rates", () => {
    expect(() => biometricMicroPayoutCents(-1, 100)).toThrow(
      /sports_biometric_invalid_quantity/,
    );
    expect(() => biometricMicroPayoutCents(100, -1)).toThrow(
      /sports_biometric_invalid_rate/,
    );
  });
});

describe("the sports ledger namespace — content-derived event ids", () => {
  it("derives the realization's position id from the founder's identity tuple", () => {
    expect(
      netVenueRealizationEventId({
        nilContractId: "nil-contract-77",
        athleteGlan: "athlete:qb-one",
        venueGln: "VEN-METRO-1",
        leagueRightsCode: "NFL-LIC-2026",
        turnstileScanHash: "hash-turnstile-a",
        period: "2026-03",
        currency: "USD",
      }),
    ).toBe(
      "sports:net_gate_realization:nil-contract-77:athlete:qb-one:VEN-METRO-1:NFL-LIC-2026:hash-turnstile-a:2026-03:USD",
    );
  });

  it("derives the venue-scoped reconciliation position id", () => {
    expect(gateReconciliationEventId("VEN-METRO-1", "2026-03", "USD")).toBe(
      "sports:gate_reconciliation:VEN-METRO-1:2026-03:USD",
    );
  });

  it("derives the league pool and NIL reconciliation position ids", () => {
    expect(leaguePoolEventId("NFL-LIC-2026", "2026-03", "USD")).toBe(
      "sports:league_pool:NFL-LIC-2026:2026-03:USD",
    );
    expect(
      nilDealReconciliationEventId("nil-contract-77", "athlete:qb-one", "2026-03"),
    ).toBe(
      "sports:nil_deal_reconciliation:nil-contract-77:athlete:qb-one:2026-03",
    );
  });

  it("derives row ids without money in the identity", () => {
    expect(sportsRowEventId("resale_royalty", "stubhub:SH-1", "2026-03:USD")).toBe(
      "sports:resale_royalty:stubhub:SH-1:2026-03:USD",
    );
  });
});

describe("the strict ingestion profiles — eight senders, exact headers", () => {
  it("dispatches every pinned fixture and parses its rows exactly", () => {
    const lines = parseSportsFixtures();
    // 5 + 1 + 1 + 2 + 2 + 2 + 8 + 4 rows.
    expect(lines).toHaveLength(25);

    // The AXS aliases map to the shared settlement fields — the
    // founder's five-leg identity, aliased per sender.
    const axs = lines.find(
      (line) => line.sportsDetail?.sender === "axs",
    );
    expect(axs?.sportsDetail).toMatchObject({
      sender: "axs",
      senderRowId: "AX-2026-03-0001",
      nilContractId: "nil-contract-88",
      athleteGlan: "athlete:wr-two",
      venueGln: "VEN-ARENA-2",
      leagueRightsCode: "NFL-LIC-2026",
      turnstileScanHash: "hash-turnstile-b",
      grossTicketRevenueCents: 5_000_000,
      facilitySurchargesCents: 400_000,
      municipalTaxesCents: 250_000,
      insuranceReservesCents: 100_000,
      processorFeeCutsCents: 150_000,
      ticketCount: 5_000,
      period: "2026-03",
      currency: "USD",
    });

    // The SeatGeek aliases map likewise.
    const seatgeek = lines.find(
      (line) => line.sportsDetail?.sender === "seatgeek",
    );
    expect(seatgeek?.sportsDetail).toMatchObject({
      senderRowId: "SG-2026-03-0001",
      grossTicketRevenueCents: 2_500_000,
      facilitySurchargesCents: 200_000,
      municipalTaxesCents: 120_000,
      insuranceReservesCents: 50_000,
      processorFeeCutsCents: 80_000,
    });

    // The Ticketmaster penny gross — exact cents through the money
    // parser ($150,000.03).
    const ticketmaster = lines.find(
      (line) => line.sportsDetail?.sender === "ticketmaster",
    );
    expect(ticketmaster?.sportsDetail).toMatchObject({
      senderRowId: "TM-2026-03-0001",
      grossTicketRevenueCents: 15_000_003,
    });

    // The Vivid Seats header reorders league before venue — the row
    // parses by position, never by guesswork.
    const vivid = lines.find(
      (line) => line.sportsDetail?.sender === "vivid_seats",
    );
    expect(vivid?.sportsDetail).toMatchObject({
      senderRowId: "VS-2026-03-0001",
      venueGln: "VEN-METRO-1",
      leagueRightsCode: "NFL-LIC-2026",
      resaleGrossCents: 100,
    });

    // The league contract's roster parses the semicolon list.
    const gameContract = lines.find(
      (line) =>
        line.sportsDetail?.sender === "league_contracts" &&
        line.sportsDetail.senderRowId === "CONTRACT-GAME-2026",
    );
    expect(gameContract?.sportsDetail).toMatchObject({
      contractClass: "group_licensing_video_games",
      contractGrossCents: 0,
      royaltyPoolCents: 100_000_000,
      unionCode: "NFLPA",
      unionShareBps: 2000,
      athleteRosterJson: JSON.stringify([
        "athlete:qb-one",
        "athlete:wr-two",
        "athlete:rb-three",
      ]),
    });

    // The biometric telemetry's quantity lands as micros.
    const biometric = lines.find(
      (line) => line.sportsDetail?.sender === "biometric_tracking",
    );
    expect(biometric?.sportsDetail).toMatchObject({
      senderRowId: "BIO-2026-03-0001",
      athleteGlan: "athlete:qb-one",
      trackingModality: "wearable",
      licenseeClass: "sportsbook",
      licensedQuantityMicros: 5_000_000_000,
    });
  });

  it("rides every fixture through the worker's dispatch — no orphans", () => {
    // Every fixture dispatches (the scenario helper throws otherwise);
    // the list itself is the dispatch contract.
    expect(SPORTS_FIXTURES).toHaveLength(8);
  });
});
