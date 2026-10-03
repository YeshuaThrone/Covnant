/**
 * The energy lane's pure-math suite (PR 48, the founder resource
 * directive) — the founder's verifying tests over energy.ts, no store:
 * the Net Resource Realization identity exact to the cent, the tier
 * walk's ORRI and GPU yield band boundaries, the acreage-ratio
 * multi-owner division at scale (hundreds of deeded fractional heirs,
 * conserving), the statutory interest day-count formula, the dynamic
 * telemetry-weighted compute-grid split, and the per-tonne carbon
 * offset payouts.
 */
import { describe, expect, it } from "vitest";

import {
  carbonOffsetPayoutCents,
  energyBpsShareCents,
  energyRoyaltyTierWalk,
  isEnergyPeriod,
  netResourceRealizationCents,
  planComputeGridSplit,
  planParcelAcreageDivision,
  statutoryInterestCents,
  validateEnergyRoyaltyBands,
} from "../energy";

describe("the Net Resource Realization identity", () => {
  it("prices the founder's exact identity to the cent", () => {
    expect(
      netResourceRealizationCents({
        grossEnergySalesCents: 100_003,
        grossMineralSalesCents: 200_000,
        transportationPipelineDeductionsCents: 123_456,
        gridTransmissionFeesCents: 7_890,
        processingRefiningBaseFeesCents: 1_234,
      }).netRealizedResourcePoolCents,
    ).toBe(167_423);

    // Zero deductions: the pool is the gross sales exactly.
    expect(
      netResourceRealizationCents({
        grossEnergySalesCents: 5_000,
        grossMineralSalesCents: 0,
        transportationPipelineDeductionsCents: 0,
        gridTransmissionFeesCents: 0,
        processingRefiningBaseFeesCents: 0,
      }).netRealizedResourcePoolCents,
    ).toBe(5_000);

    // A negative net is a number, not an error — the HELD verdict is
    // the caller's honest record of it.
    expect(
      netResourceRealizationCents({
        grossEnergySalesCents: 1_000,
        grossMineralSalesCents: 0,
        transportationPipelineDeductionsCents: 1_100,
        gridTransmissionFeesCents: 0,
        processingRefiningBaseFeesCents: 0,
      }).netRealizedResourcePoolCents,
    ).toBe(-100);
  });

  it("refuses non-integer or negative legs", () => {
    for (const bad of [
      { grossEnergySalesCents: -1, grossMineralSalesCents: 0, transportationPipelineDeductionsCents: 0, gridTransmissionFeesCents: 0, processingRefiningBaseFeesCents: 0 },
      { grossEnergySalesCents: 1.5, grossMineralSalesCents: 0, transportationPipelineDeductionsCents: 0, gridTransmissionFeesCents: 0, processingRefiningBaseFeesCents: 0 },
      { grossEnergySalesCents: 0, grossMineralSalesCents: 0, transportationPipelineDeductionsCents: -5, gridTransmissionFeesCents: 0, processingRefiningBaseFeesCents: 0 },
    ]) {
      expect(() => netResourceRealizationCents(bad)).toThrow(/^energy_realization_invalid_leg:/);
    }
  });
});

describe("the tiered royalty walk (ORRI and GPU yield boundaries)", () => {
  it("prices the founder's flat 12.5% ORRI", () => {
    const walk = energyRoyaltyTierWalk({
      royaltyBasisCents: 100_003,
      cumulativeBeforeCents: 0,
      bands: [{ up_to: null, royalty_bps: 1250 }],
    });
    expect(walk.royaltyCents).toBe(12_500); // floor(100003 × 0.125)
    expect(walk.cumulativeAfterCents).toBe(100_003);
  });

  it("prices the founder's flat 20% GPU yield", () => {
    const walk = energyRoyaltyTierWalk({
      royaltyBasisCents: 50_000,
      cumulativeBeforeCents: 0,
      bands: [{ up_to: null, royalty_bps: 2000 }],
    });
    expect(walk.royaltyCents).toBe(10_000);
  });

  it("prices bands marginally across the cumulative boundary", () => {
    // The ladder: 10% to 100_000, then 25% open — a basis crossing the
    // boundary prices only its marginal slice at the higher rate.
    const walk = energyRoyaltyTierWalk({
      royaltyBasisCents: 60_000,
      cumulativeBeforeCents: 80_000,
      bands: [
        { up_to: 100_000, royalty_bps: 1000 },
        { up_to: null, royalty_bps: 2500 },
      ],
    });
    expect(walk.legs).toEqual([
      { band_from: 0, band_to: 100_000, royalty_bps: 1000, band_basis_cents: 20_000, band_royalty_cents: 2_000 },
      { band_from: 100_000, band_to: null, royalty_bps: 2500, band_basis_cents: 40_000, band_royalty_cents: 10_000 },
    ]);
    expect(walk.royaltyCents).toBe(12_000);
    expect(walk.cumulativeAfterCents).toBe(140_000);
  });

  it("walks a basis entirely inside one band without spilling", () => {
    const walk = energyRoyaltyTierWalk({
      royaltyBasisCents: 10_000,
      cumulativeBeforeCents: 50_000,
      bands: [
        { up_to: 100_000, royalty_bps: 1000 },
        { up_to: null, royalty_bps: 2500 },
      ],
    });
    expect(walk.legs).toHaveLength(1);
    expect(walk.legs[0]?.royalty_bps).toBe(1000);
    expect(walk.royaltyCents).toBe(1_000);
  });

  it("refuses malformed ladders", () => {
    expect(() => energyRoyaltyTierWalk({ royaltyBasisCents: 1, cumulativeBeforeCents: 0, bands: [] })).toThrow("energy_walk_bands_empty");
    expect(() => energyRoyaltyTierWalk({ royaltyBasisCents: -1, cumulativeBeforeCents: 0, bands: [{ up_to: null, royalty_bps: 100 }] })).toThrow(/^energy_walk_invalid_basis:/);
    expect(() => energyRoyaltyTierWalk({ royaltyBasisCents: 1, cumulativeBeforeCents: -1, bands: [{ up_to: null, royalty_bps: 100 }] })).toThrow(/^energy_walk_invalid_position:/);
  });

  it("validates band ladders before persist", () => {
    expect(validateEnergyRoyaltyBands([{ up_to: null, royalty_bps: 1250 }])).toEqual([
      { up_to: null, royalty_bps: 1250 },
    ]);
    expect(() => validateEnergyRoyaltyBands([{ up_to: 100, royalty_bps: 100 }, { up_to: 50, royalty_bps: 100 }])).toThrow("energy_bands_bounds");
    expect(() => validateEnergyRoyaltyBands([{ up_to: 100, royalty_bps: 100 }, { up_to: 200, royalty_bps: 100 }, { up_to: null, royalty_bps: 100 }, { up_to: 300, royalty_bps: 100 }])).toThrow("energy_bands_open_not_last");
    expect(() => validateEnergyRoyaltyBands([{ up_to: null, royalty_bps: 0 }])).toThrow("energy_bands_rate");
    expect(() => validateEnergyRoyaltyBands([{ up_to: null, royalty_bps: 10_001 }])).toThrow("energy_bands_rate");
    expect(() => validateEnergyRoyaltyBands([])).toThrow("energy_bands_empty");
  });
});

describe("the acreage-ratio multi-owner division at scale", () => {
  it("divides 4/3/2-of-9 conserving with deterministic dust", () => {
    const division = planParcelAcreageDivision({
      interests: [
        { payeeId: "heir-ana", deededAcresMicros: 4_000_000 },
        { payeeId: "heir-bea", deededAcresMicros: 3_000_000 },
        { payeeId: "heir-cal", deededAcresMicros: 2_000_000 },
      ],
      potCents: 12_500,
    });
    expect(division).toEqual([
      { payee_id: "heir-ana", deeded_acres_micros: 4_000_000, allocated_cents: 5_556 },
      { payee_id: "heir-bea", deeded_acres_micros: 3_000_000, allocated_cents: 4_167 },
      { payee_id: "heir-cal", deeded_acres_micros: 2_000_000, allocated_cents: 2_777 },
    ]);
    expect(division.reduce((sum, leg) => sum + leg.allocated_cents, 0)).toBe(12_500);
  });

  it("divides across hundreds of deeded fractional heirs, conserving exactly", () => {
    // 300 heirs with deliberately irregular acreages (the monthly oil /
    // gas / wind revenue event) — the floors leave dust; the dust must
    // top up deterministically and the legs must conserve to the cent.
    const interests = Array.from({ length: 300 }, (_, index) => ({
      payeeId: `heir-${String(index).padStart(4, "0")}`,
      deededAcresMicros: 137_000 + ((index * 977) % 421_000),
    }));
    const potCents = 987_654_321;
    const division = planParcelAcreageDivision({ interests, potCents });

    const totalAcres = interests.reduce((sum, i) => sum + i.deededAcresMicros, 0);
    // Every leg holds its exact floor share (BigInt-exact), the dust is
    // smaller than the heir count, and the legs conserve the pot.
    for (const leg of division) {
      const exact = (BigInt(leg.deeded_acres_micros) * BigInt(potCents)) / BigInt(totalAcres);
      const dust = Number(BigInt(potCents) - (BigInt(totalAcres) * BigInt(potCents)) / BigInt(totalAcres));
      expect(leg.allocated_cents).toBeGreaterThanOrEqual(Number(exact));
      expect(leg.allocated_cents - Number(exact)).toBeLessThanOrEqual(dust + interests.length);
    }
    expect(division.reduce((sum, leg) => sum + leg.allocated_cents, 0)).toBe(potCents);

    // The ranking is deterministic: identical inputs, identical legs.
    const again = planParcelAcreageDivision({ interests, potCents });
    expect(again).toEqual(division);
  });

  it("refuses to divide without interests, acreage, or a sane pot", () => {
    expect(() => planParcelAcreageDivision({ interests: [], potCents: 100 })).toThrow("energy_division_no_interests");
    expect(() =>
      planParcelAcreageDivision({
        interests: [{ payeeId: "heir-ana", deededAcresMicros: 0 }],
        potCents: 100,
      }),
    ).toThrow("energy_division_zero_acreage");
    expect(() =>
      planParcelAcreageDivision(
        { interests: [{ payeeId: "heir-ana", deededAcresMicros: 1_000_000 }], potCents: -1 },
      ),
    ).toThrow(/^energy_division_invalid_pot:/);
  });
});

describe("the statutory interest day-count formula", () => {
  it("prices floor(base × lateDays × rateBps / 3,650,000) exactly", () => {
    // The scenario's two accruals.
    expect(statutoryInterestCents({ baseCents: 2_777, lateDays: 26, rateBps: 800 })).toBe(15);
    expect(statutoryInterestCents({ baseCents: 5_555, lateDays: 26, rateBps: 800 })).toBe(31);
    // A whole-year of 800 bps on 10_000: floor(10000 × 365 × 800 / 3650000) = 800.
    expect(statutoryInterestCents({ baseCents: 10_000, lateDays: 365, rateBps: 800 })).toBe(800);
    // Zero days or zero rate accrue nothing.
    expect(statutoryInterestCents({ baseCents: 9_999, lateDays: 0, rateBps: 800 })).toBe(0);
    expect(statutoryInterestCents({ baseCents: 9_999, lateDays: 26, rateBps: 0 })).toBe(0);
    // BigInt-exact where Number multiplication would lose precision.
    expect(statutoryInterestCents({ baseCents: 900_719_925, lateDays: 400, rateBps: 10_000 })).toBe(
      Number((BigInt(900_719_925) * 400n * 10_000n) / 3_650_000n),
    );
  });

  it("refuses negative or out-of-vocabulary operands", () => {
    expect(() => statutoryInterestCents({ baseCents: -1, lateDays: 1, rateBps: 100 })).toThrow(/^energy_interest_invalid_base:/);
    expect(() => statutoryInterestCents({ baseCents: 1, lateDays: -1, rateBps: 100 })).toThrow(/^energy_interest_invalid_late_days:/);
    expect(() => statutoryInterestCents({ baseCents: 1, lateDays: 1, rateBps: 10_001 })).toThrow(/^energy_interest_invalid_rate:/);
  });
});

describe("the dynamic compute-grid split", () => {
  const participants = [
    { payeeId: "silicon-lessor", participantClass: "gpu_hardware_owner" as const, weightMicros: 10_000_000 },
    { payeeId: "power-provider-meridian", participantClass: "power_plant_operator" as const, weightMicros: 40_000 },
    { payeeId: "colocation-facility-delta", participantClass: "colocation_manager" as const, weightMicros: 250_000_000 },
  ];

  it("allocates the founder's three counterparties by telemetry weight, conserving", () => {
    const split = planComputeGridSplit({
      participants,
      telemetry: { computeHoursMicros: 150_000_000, powerDrawKwMicros: 25_000_000_000 },
      revenueCents: 50_000,
    });
    expect(split.allocatedTotalCents).toBe(50_000);
    expect(split.legs.find((l) => l.payee_id === "silicon-lessor")?.allocated_cents).toBe(27_273);
    expect(split.legs.find((l) => l.payee_id === "power-provider-meridian")?.allocated_cents).toBe(18_182);
    expect(split.legs.find((l) => l.payee_id === "colocation-facility-delta")?.allocated_cents).toBe(4_545);
    expect(split.legs.reduce((sum, leg) => sum + leg.allocated_cents, 0)).toBe(50_000);
  });

  it("shifts the split DYNAMICALLY as the real-time telemetry moves", () => {
    // Double the GPU and power telemetry at constant revenue; the
    // colocation manager's flat registered weight loses ground — its
    // 4_545-cent share halves to 2_380 while the GPU and power legs
    // take the growth.
    const before = planComputeGridSplit({
      participants,
      telemetry: { computeHoursMicros: 150_000_000, powerDrawKwMicros: 25_000_000_000 },
      revenueCents: 50_000,
    });
    const after = planComputeGridSplit({
      participants,
      telemetry: { computeHoursMicros: 300_000_000, powerDrawKwMicros: 50_000_000_000 },
      revenueCents: 50_000,
    });
    const coloBefore = before.legs.find((l) => l.payee_id === "colocation-facility-delta")!;
    const coloAfter = after.legs.find((l) => l.payee_id === "colocation-facility-delta")!;
    expect(coloBefore.allocated_cents).toBe(4_545);
    expect(coloAfter.allocated_cents).toBe(2_380);
    expect(coloAfter.effective_weight_micros).toBe(coloBefore.effective_weight_micros);
    const siliconAfter = after.legs.find((l) => l.payee_id === "silicon-lessor")!;
    expect(siliconAfter.allocated_cents).toBe(28_572);
  });

  it("refuses to split without participants, weight, or sane revenue", () => {
    expect(() =>
      planComputeGridSplit({
        participants: [],
        telemetry: { computeHoursMicros: 0, powerDrawKwMicros: 0 },
        revenueCents: 100,
      }),
    ).toThrow("energy_grid_split_no_participants");
    expect(() =>
      planComputeGridSplit({
        participants: [{ payeeId: "x", participantClass: "colocation_manager", weightMicros: 0 }],
        telemetry: { computeHoursMicros: 0, powerDrawKwMicros: 0 },
        revenueCents: 100,
      }),
    ).toThrow(/^energy_grid_split_invalid_weight:/);
    expect(() =>
      planComputeGridSplit({ participants, telemetry: { computeHoursMicros: -1, powerDrawKwMicros: 0 }, revenueCents: 100 }),
    ).toThrow(/^energy_grid_split_invalid_compute_hours:/);
    expect(() =>
      planComputeGridSplit({ participants, telemetry: { computeHoursMicros: 0, powerDrawKwMicros: 0 }, revenueCents: -1 }),
    ).toThrow(/^energy_grid_split_invalid_revenue:/);
  });
});

describe("the per-tonne carbon offset payouts", () => {
  it("routes the trust's bps share and the developer's remainder", () => {
    // 12.5 verified tonnes (1_250_000_000 house micros) at $1.50/tonne
    // → $18.75 pot; the trust's 70% floors to 1312, the developer rides
    // the remainder.
    const payout = carbonOffsetPayoutCents({
      tonnesVerifiedMicros: 1_250_000_000,
      microsPerTonne: 150_000_000,
      trustShareBps: 7000,
    });
    expect(payout.potCents).toBe(1_875);
    expect(payout.trustCents).toBe(1_312);
    expect(payout.developerCents).toBe(563);
    expect(payout.trustCents + payout.developerCents).toBe(payout.potCents);
  });

  it("floors a sub-cent pot to zero payable cents without dropping it", () => {
    // 0.005 tonnes (500_000 house micros) × $1.50 = 3/4 of a cent —
    // the caller records the row; no payable cents exist to route.
    const payout = carbonOffsetPayoutCents({
      tonnesVerifiedMicros: 500_000,
      microsPerTonne: 150_000_000,
      trustShareBps: 7000,
    });
    expect(payout.potCents).toBe(0);
    expect(payout.trustCents).toBe(0);
    expect(payout.developerCents).toBe(0);
  });

  it("refuses zero tonnes, a zero rate, or a boundary trust share", () => {
    expect(() => carbonOffsetPayoutCents({ tonnesVerifiedMicros: 0, microsPerTonne: 100, trustShareBps: 7000 })).toThrow(/^energy_offset_invalid_tonnes:/);
    expect(() => carbonOffsetPayoutCents({ tonnesVerifiedMicros: 1, microsPerTonne: 0, trustShareBps: 7000 })).toThrow(/^energy_offset_invalid_rate:/);
    expect(() => carbonOffsetPayoutCents({ tonnesVerifiedMicros: 1, microsPerTonne: 100, trustShareBps: 10_000 })).toThrow(/^energy_offset_invalid_trust_share:/);
    expect(() => carbonOffsetPayoutCents({ tonnesVerifiedMicros: 1, microsPerTonne: 100, trustShareBps: 0 })).toThrow(/^energy_offset_invalid_trust_share:/);
  });
});

describe("the shared helpers", () => {
  it("floors bps shares and validates the period shape", () => {
    expect(energyBpsShareCents(1_875, 7000)).toBe(1_312);
    expect(energyBpsShareCents(1, 9999)).toBe(0);
    expect(isEnergyPeriod("2026-03")).toBe(true);
    expect(isEnergyPeriod("2026-3")).toBe(false);
    expect(isEnergyPeriod("26-03")).toBe(false);
  });
});
