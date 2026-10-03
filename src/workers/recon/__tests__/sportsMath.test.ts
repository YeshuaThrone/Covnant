/**
 * The sports lane's pure-math suite (PR 50, the founder sports
 * directive) — the Net Venue Realization identity exact to the cent,
 * the turnstile-to-receipt reconciliation verdicts, the resale royalty
 * splits, and the league pool distribution's market-size balance
 * offsets, salary cap thresholds, and performance incentives. Every
 * expectation below is the pinned scenario arithmetic from
 * sportsScenario.ts, computed by hand.
 */

import { describe, expect, it } from "vitest";

import {
  gateReconciliationVerdict,
  netVenueRealizationCents,
  planLeaguePoolDistribution,
  planResaleRoyaltySplit,
} from "../sports";

describe("the Net Venue Realization — the founder's identity, exact to the cent", () => {
  it("subtracts the four deduction legs from the gross, no bps, no proration", () => {
    const outcome = netVenueRealizationCents({
      grossTicketRevenueCents: 35_000_003,
      facilitySurchargesCents: 2_700_000,
      municipalTaxesCents: 2_000_000,
      insuranceReservesCents: 700_000,
      processorFeeCutsCents: 950_000,
    });
    expect(outcome.netGatePoolCents).toBe(28_650_003);
    expect(outcome.verdict).toBe("posted");
  });

  it("pins a zero-gate and a one-cent gate", () => {
    expect(
      netVenueRealizationCents({
        grossTicketRevenueCents: 100,
        facilitySurchargesCents: 100,
        municipalTaxesCents: 0,
        insuranceReservesCents: 0,
        processorFeeCutsCents: 0,
      }),
    ).toEqual({ netGatePoolCents: 0, verdict: "posted" });
    expect(
      netVenueRealizationCents({
        grossTicketRevenueCents: 101,
        facilitySurchargesCents: 100,
        municipalTaxesCents: 0,
        insuranceReservesCents: 0,
        processorFeeCutsCents: 0,
      }),
    ).toEqual({ netGatePoolCents: 1, verdict: "posted" });
  });

  it("holds a loss-making gate visible, never a silent negative post", () => {
    const outcome = netVenueRealizationCents({
      grossTicketRevenueCents: 1_000,
      facilitySurchargesCents: 600,
      municipalTaxesCents: 200,
      insuranceReservesCents: 300,
      processorFeeCutsCents: 200,
    });
    expect(outcome.netGatePoolCents).toBe(-300);
    expect(outcome.verdict).toBe("held_negative_net");
  });

  it("refuses negative or non-integer legs", () => {
    expect(() =>
      netVenueRealizationCents({
        grossTicketRevenueCents: -1,
        facilitySurchargesCents: 0,
        municipalTaxesCents: 0,
        insuranceReservesCents: 0,
        processorFeeCutsCents: 0,
      }),
    ).toThrow(/sports_realization_invalid_leg/);
    expect(() =>
      netVenueRealizationCents({
        grossTicketRevenueCents: 1.5,
        facilitySurchargesCents: 0,
        municipalTaxesCents: 0,
        insuranceReservesCents: 0,
        processorFeeCutsCents: 0,
      }),
    ).toThrow(/sports_realization_invalid_leg/);
  });
});

describe("the gate reconciliation — scan counts against gross ticket receipts", () => {
  it("reconciles equal positive counts with a zero delta", () => {
    expect(gateReconciliationVerdict(35_010, 35_010)).toEqual({
      verdict: "reconciled",
      varianceScanDelta: 0,
    });
  });

  it("flags orphan scans (scans the receipts never saw) with the signed delta", () => {
    expect(gateReconciliationVerdict(7, 5_000)).toEqual({
      verdict: "variance_flagged",
      varianceScanDelta: 4_993,
    });
  });

  it("flags unscanned tickets (tickets with no scans) with the signed delta", () => {
    expect(gateReconciliationVerdict(7_500, 0)).toEqual({
      verdict: "variance_flagged",
      varianceScanDelta: -7_500,
    });
  });

  it("reports an empty scope unreconciled, never silently clean", () => {
    expect(gateReconciliationVerdict(0, 0)).toEqual({
      verdict: "unreconciled",
      varianceScanDelta: 0,
    });
  });

  it("refuses negative counts", () => {
    expect(() => gateReconciliationVerdict(-1, 0)).toThrow(
      /sports_gate_reconciliation_invalid_counts/,
    );
    expect(() => gateReconciliationVerdict(0, -5)).toThrow(
      /sports_gate_reconciliation_invalid_counts/,
    );
  });
});

describe("the secondary resale royalties — the founder 5–10% band", () => {
  const POLICY = {
    resale_royalty_bps: 1000,
    promoter_share_bps: 5000,
    venue_share_bps: 3000,
    league_share_bps: 2000,
  };

  it("routes the $40,000 resale's cut 50/30/20 across promoter, venue, league", () => {
    const split = planResaleRoyaltySplit(4_000_000, POLICY);
    expect(split).toEqual({
      royaltyPotCents: 400_000,
      promoterLegCents: 200_000,
      venueLegCents: 120_000,
      leagueLegCents: 80_000,
    });
  });

  it("conserves the pot exactly on an odd gross — the league leg absorbs the dust", () => {
    const split = planResaleRoyaltySplit(1_000_500, POLICY);
    expect(split.royaltyPotCents).toBe(100_050);
    expect(split.promoterLegCents).toBe(50_025);
    expect(split.venueLegCents).toBe(30_015);
    expect(split.leagueLegCents).toBe(20_010);
    expect(
      split.promoterLegCents + split.venueLegCents + split.leagueLegCents,
    ).toBe(split.royaltyPotCents);
  });

  it("pins the $1.00 resale — pot 10 cents, still split exactly", () => {
    const split = planResaleRoyaltySplit(100, POLICY);
    expect(split).toEqual({
      royaltyPotCents: 10,
      promoterLegCents: 5,
      venueLegCents: 3,
      leagueLegCents: 2,
    });
  });

  it("honors the founder band's floor — a 500 bps royalty", () => {
    const split = planResaleRoyaltySplit(999, {
      resale_royalty_bps: 500,
      promoter_share_bps: 5000,
      venue_share_bps: 3000,
      league_share_bps: 2000,
    });
    expect(split.royaltyPotCents).toBe(49);
    expect(split.promoterLegCents).toBe(24);
    expect(split.venueLegCents).toBe(14);
    expect(split.leagueLegCents).toBe(11);
  });

  it("refuses a negative gross", () => {
    expect(() => planResaleRoyaltySplit(-1, POLICY)).toThrow(
      /sports_resale_invalid_gross/,
    );
  });
});

describe("the league-wide pool distribution — market balance, salary cap, incentives", () => {
  const POLICY = {
    equal_share_bps: 4000,
    market_balance_bps: 3500,
    performance_incentive_bps: 2500,
  };
  const TEAMS = [
    {
      team_code: "TEAM-A",
      owner_payee_id: "owner-team-a",
      owner_payee_name: "Metro Owners LP (A)",
      market_size_micros: 4_000_000,
      payroll_micros: 1_000_000,
      cap_threshold_micros: 1_200_000,
      performance_incentive_bps: 300,
    },
    {
      team_code: "TEAM-B",
      owner_payee_id: "owner-team-b",
      owner_payee_name: "Harbor Owners LP (B, over cap)",
      market_size_micros: 3_000_000,
      payroll_micros: 1_500_000,
      cap_threshold_micros: 1_200_000,
      performance_incentive_bps: 200,
    },
    {
      team_code: "TEAM-C",
      owner_payee_id: "owner-team-c",
      owner_payee_name: "Capital Owners LP (C)",
      market_size_micros: 3_000_000,
      payroll_micros: 500_000,
      cap_threshold_micros: 1_000_000,
      performance_incentive_bps: 500,
    },
  ];

  it("distributes the scenario's 150000001-cent pool with every offset pinned", () => {
    const distribution = planLeaguePoolDistribution(150_000_001, POLICY, TEAMS);
    // The equal slice — 60000000 across three teams, exact.
    expect(distribution.legs.map((leg) => leg.equal_share_cents)).toEqual([
      20_000_000,
      20_000_000,
      20_000_000,
    ]);
    // The market slice — TEAM-B is over the salary cap and takes none
    // of it; A and C split 52500000 by market size, exact.
    expect(distribution.legs.map((leg) => leg.market_balance_cents)).toEqual([
      30_000_000,
      0,
      22_500_000,
    ]);
    // The incentive slice — the exact remainder 37500001 (it carries
    // the national contract's bps-floor dust), weighted 300/200/500,
    // the one-cent remainder to the highest weight (TEAM-C).
    expect(
      distribution.legs.map((leg) => leg.performance_incentive_cents),
    ).toEqual([11_250_000, 7_500_000, 18_750_001]);
    // The totals of record.
    expect(distribution.legs.map((leg) => leg.total_cents)).toEqual([
      61_250_000,
      27_500_000,
      61_250_001,
    ]);
    expect(distribution.distributedCents).toBe(150_000_001);
    expect(distribution.dustCents).toBe(0);
  });

  it("keeps every owner's payee identity on its leg", () => {
    const distribution = planLeaguePoolDistribution(150_000_000, POLICY, TEAMS);
    expect(distribution.legs.map((leg) => leg.owner_payee_id)).toEqual([
      "owner-team-a",
      "owner-team-b",
      "owner-team-c",
    ]);
  });

  it("conserves pool = Σ legs + dust on an undistributable slice", () => {
    // An incentive weight of zero on every team strands the incentive
    // slice — the dust leg carries it visibly (equal 40000 + market
    // 35000 distribute; the 25000 incentive slice is stranded).
    const distribution = planLeaguePoolDistribution(
      100_000,
      POLICY,
      TEAMS.map((team) => ({ ...team, performance_incentive_bps: 0 })),
    );
    expect(distribution.distributedCents).toBe(75_000);
    expect(distribution.dustCents).toBe(25_000);
    expect(distribution.distributedCents + distribution.dustCents).toBe(
      100_000,
    );
  });

  it("refuses a policy that does not conserve to 10000", () => {
    expect(() =>
      planLeaguePoolDistribution(
        1000,
        { equal_share_bps: 4000, market_balance_bps: 3500, performance_incentive_bps: 2000 },
        TEAMS,
      ),
    ).toThrow(/sports_pool_invalid_policy/);
  });

  it("refuses duplicate team codes and empty team lists", () => {
    expect(() =>
      planLeaguePoolDistribution(1000, POLICY, [TEAMS[0], TEAMS[0]]),
    ).toThrow(/sports_pool_duplicate_team/);
    expect(() => planLeaguePoolDistribution(1000, POLICY, [])).toThrow(
      /sports_pool_no_teams/,
    );
  });
});
