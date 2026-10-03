/**
 * The spatial lane's calculator unit tests (PR 36, the founder spatial
 * directive) — the founder's verifying-test list, at the unit seam:
 * the Adjusted Location Sales math exact to the cent, the throughput tier
 * boundaries at 500,000 and 1,000,000 entries with cumulative tracking,
 * the micro-royalty dwell time and session count math, and the shared
 * facility overhead ordering.
 */
import { describe, expect, it } from "vitest";
import {
  adjustedLocationSalesCents,
  sharedOverheadCents,
  spatialBandForPosition,
  spatialMicroRoyaltyCents,
  spatialPositionRoyaltyCents,
  spatialRowEventId,
  spatialThroughputRoyaltyWalk,
  spatialZoneAllocationCents,
} from "../spatial";

/** The founder's example schedule: 5% on the first 500,000 annual
 * entries, a middle tier to 1,000,000, and 8% strictly above. */
const FOUNDER_BANDS = [
  { up_to: 500_000, royalty_bps: 500 },
  { up_to: 1_000_000, royalty_bps: 650 },
  { up_to: null, royalty_bps: 800 },
] as const;

describe("adjustedLocationSalesCents — the founder identity", () => {
  it("nets gross venue ticket and merch revenue minus tax, COGS, and approved discounts, exact to the cent", () => {
    const adjusted = adjustedLocationSalesCents({
      ticketRevenueCents: 1_234_567,
      merchRevenueCents: 765_433,
      occupancyTaxCents: 123_456,
      venueInfrastructureCogsCents: 234_567,
      approvedGroupTourDiscountCents: 345_678,
    });
    expect(adjusted.grossRevenueCents).toBe(2_000_000);
    expect(adjusted.netSpatialLicensedRevenueCents).toBe(1_296_299);
  });

  it("records a negative net honestly — the caller holds it, the math never lies", () => {
    const adjusted = adjustedLocationSalesCents({
      ticketRevenueCents: 100,
      merchRevenueCents: 0,
      occupancyTaxCents: 60,
      venueInfrastructureCogsCents: 30,
      approvedGroupTourDiscountCents: 20,
    });
    expect(adjusted.netSpatialLicensedRevenueCents).toBe(-10);
  });

  it("refuses a negative leg — a refund has no vocabulary here", () => {
    expect(() =>
      adjustedLocationSalesCents({
        ticketRevenueCents: -1,
        merchRevenueCents: 0,
        occupancyTaxCents: 0,
        venueInfrastructureCogsCents: 0,
        approvedGroupTourDiscountCents: 0,
      }),
    ).toThrow();
  });
});

describe("sharedOverheadCents — park-wide legs off every distribution's basis", () => {
  it("floors each leg per-bps and pins the ordering identity", () => {
    const overhead = sharedOverheadCents({
      basisCents: 1_000_000,
      securityBps: 125,
      wristbandMaintenanceBps: 75,
      ticketingPlatformBps: 50,
    });
    expect(overhead.securityCents).toBe(12_500);
    expect(overhead.wristbandMaintenanceCents).toBe(7_500);
    expect(overhead.ticketingPlatformCents).toBe(5_000);
    expect(overhead.overheadTotalCents).toBe(25_000);
    // The ordering: legs + royalty basis === basis.
    expect(1_000_000 - overhead.overheadTotalCents).toBe(975_000);
  });

  it("floors, never rounds up — an uneven leg keeps the owner's cent", () => {
    const overhead = sharedOverheadCents({
      basisCents: 33,
      securityBps: 100,
      wristbandMaintenanceBps: 0,
      ticketingPlatformBps: 0,
    });
    expect(overhead.securityCents).toBe(0); // floor(33 × 100/10000) = 0
  });
});

describe("the occupancy royalty tier walk — the founder's throughput example", () => {
  it("prices a row entirely inside the first band at 5% (the first 500000 entries)", () => {
    const walk = spatialThroughputRoyaltyWalk({
      royaltyBasisCents: 1_000_000,
      entries: 500_000,
      cumulativeBefore: 0,
      bands: FOUNDER_BANDS,
    });
    expect(walk.legs).toHaveLength(1);
    expect(walk.legs[0]?.band_rate_bps).toBe(500);
    expect(walk.royaltyCents).toBe(50_000); // 5% of the basis
    expect(walk.cumulativeAfter).toBe(500_000);
  });

  it("splits exactly at the 500,000 boundary — the 500,000th entry prices in band 1, 500,001 in band 2", () => {
    const walk = spatialThroughputRoyaltyWalk({
      royaltyBasisCents: 10_000,
      entries: 2,
      cumulativeBefore: 499_999,
      bands: FOUNDER_BANDS,
    });
    expect(walk.legs).toHaveLength(2);
    expect(walk.legs[0]).toMatchObject({
      band_from: 0,
      band_to: 500_000,
      band_entries: 1,
      band_basis_cents: 5_000,
      band_royalty_cents: 250, // 5% of 5,000
    });
    expect(walk.legs[1]).toMatchObject({
      band_from: 500_000,
      band_to: 1_000_000,
      band_entries: 1,
      band_basis_cents: 5_000,
      band_royalty_cents: 325, // 6.5% of 5,000
    });
    expect(walk.royaltyCents).toBe(575);
    expect(walk.cumulativeAfter).toBe(500_001);
  });

  it("applies the founder's 8% strictly above 1,000,000 entries", () => {
    const walk = spatialThroughputRoyaltyWalk({
      royaltyBasisCents: 10_000,
      entries: 1,
      cumulativeBefore: 1_000_000,
      bands: FOUNDER_BANDS,
    });
    expect(walk.legs).toHaveLength(1);
    expect(walk.legs[0]?.band_rate_bps).toBe(800);
    expect(walk.royaltyCents).toBe(800);
    expect(walk.cumulativeAfter).toBe(1_000_001);
  });

  it("tracks the cumulative position across rows — a straddling row splits proportionally to the entries each band holds", () => {
    // Row 1 fills the first band exactly.
    const rowOne = spatialThroughputRoyaltyWalk({
      royaltyBasisCents: 1_000_000,
      entries: 500_000,
      cumulativeBefore: 0,
      bands: FOUNDER_BANDS,
    });
    // Row 2 crosses from 500,000 to 1,000,000 — every entry in band 2.
    const rowTwo = spatialThroughputRoyaltyWalk({
      royaltyBasisCents: 1_000_000,
      entries: 500_000,
      cumulativeBefore: rowOne.cumulativeAfter,
      bands: FOUNDER_BANDS,
    });
    expect(rowTwo.cumulativeAfter).toBe(1_000_000);
    expect(rowTwo.legs).toHaveLength(1);
    expect(rowTwo.legs[0]?.band_rate_bps).toBe(650);
    expect(rowTwo.royaltyCents).toBe(65_000); // 6.5% of the basis
  });

  it("conserves the basis exactly — the band bases sum to the royalty basis (largest-remainder dust)", () => {
    const walk = spatialThroughputRoyaltyWalk({
      royaltyBasisCents: 1_001,
      entries: 2,
      cumulativeBefore: 499_999,
      bands: FOUNDER_BANDS,
    });
    const bandBasisSum = walk.legs.reduce((sum, leg) => sum + leg.band_basis_cents, 0);
    expect(bandBasisSum).toBe(1_001);
    // The leftover cent went to band 1 (largest remainder, ties by order).
    expect(walk.legs[0]?.band_basis_cents).toBe(501);
    expect(walk.legs[1]?.band_basis_cents).toBe(500);
  });

  it("refuses a zero-entry walk, a negative basis, and a negative position", () => {
    expect(() =>
      spatialThroughputRoyaltyWalk({
        royaltyBasisCents: 100,
        entries: 0,
        cumulativeBefore: 0,
        bands: FOUNDER_BANDS,
      }),
    ).toThrow();
    expect(() =>
      spatialThroughputRoyaltyWalk({
        royaltyBasisCents: -1,
        entries: 1,
        cumulativeBefore: 0,
        bands: FOUNDER_BANDS,
      }),
    ).toThrow();
    expect(() =>
      spatialThroughputRoyaltyWalk({
        royaltyBasisCents: 100,
        entries: 1,
        cumulativeBefore: -1,
        bands: FOUNDER_BANDS,
      }),
    ).toThrow();
  });
});

describe("spatialBandForPosition / spatialPositionRoyaltyCents — the closing-position and footprint pricing", () => {
  it("prices the 500,000th entry in the first band (the first 500000 entries include it)", () => {
    const found = spatialBandForPosition(500_000, FOUNDER_BANDS);
    expect(found?.band.royalty_bps).toBe(500);
  });

  it("prices position 500,001 in the second band and 1,000,001 in the open top band", () => {
    expect(spatialBandForPosition(500_001, FOUNDER_BANDS)?.band.royalty_bps).toBe(650);
    expect(spatialBandForPosition(1_000_001, FOUNDER_BANDS)?.band.royalty_bps).toBe(800);
  });

  it("prices a pass row at the venue's current cumulative position without advancing it", () => {
    const royalty = spatialPositionRoyaltyCents({
      royaltyBasisCents: 21_500_000,
      position: 400_000,
      bands: FOUNDER_BANDS,
    });
    expect(royalty.legs).toHaveLength(1);
    expect(royalty.legs[0]?.band_entries).toBe(0);
    expect(royalty.royaltyCents).toBe(1_075_000); // 5% of the basis
  });

  it("prices a footprint-basis schedule at the band holding the venue's footprint allocation", () => {
    const bands = [
      { up_to: 50_000, royalty_bps: 300 },
      { up_to: null, royalty_bps: 550 },
    ] as const;
    const royalty = spatialPositionRoyaltyCents({
      royaltyBasisCents: 4_000_000,
      position: 120_000,
      bands,
    });
    expect(royalty.royaltyCents).toBe(220_000); // 5.5% of the basis
  });
});

describe("spatialMicroRoyaltyCents — the dwell/session unit pricing", () => {
  it("prices dwell minutes and ride sessions exactly (statement micros per unit)", () => {
    const royalty = spatialMicroRoyaltyCents({
      dwellMinutes: 90,
      rideSessions: 3,
      microsPerDwellMinute: 1_400_000, // 1.4¢ per minute
      microsPerRideSession: 2_500_000, // 2.5¢ per session
    });
    expect(royalty.dwellRoyaltyMicros).toBe(126_000_000n);
    expect(royalty.sessionRoyaltyMicros).toBe(7_500_000n);
    expect(royalty.totalRoyaltyMicros).toBe(133_500_000n);
    expect(royalty.royaltyCents).toBe(133);
  });

  it("floors sub-cent payouts — a one-micro royalty pays zero cents, honestly", () => {
    const royalty = spatialMicroRoyaltyCents({
      dwellMinutes: 1,
      rideSessions: 0,
      microsPerDwellMinute: 1,
      microsPerRideSession: 0,
    });
    expect(royalty.totalRoyaltyMicros).toBe(1n);
    expect(royalty.royaltyCents).toBe(0);
  });

  it("refuses negative or fractional inputs", () => {
    expect(() =>
      spatialMicroRoyaltyCents({
        dwellMinutes: -1,
        rideSessions: 0,
        microsPerDwellMinute: 0,
        microsPerRideSession: 0,
      }),
    ).toThrow();
    expect(() =>
      spatialMicroRoyaltyCents({
        dwellMinutes: 1.5,
        rideSessions: 0,
        microsPerDwellMinute: 0,
        microsPerRideSession: 0,
      }),
    ).toThrow();
  });
});

describe("spatialZoneAllocationCents — zone routing, overhead first", () => {
  it("takes the overhead legs off the gross BEFORE the owner's bps price the allocated remainder", () => {
    const allocation = spatialZoneAllocationCents({
      grossCents: 500_000,
      securityBps: 125,
      wristbandMaintenanceBps: 75,
      ticketingPlatformBps: 50,
      zoneRoyaltyBps: 300,
    });
    expect(allocation.overhead.overheadTotalCents).toBe(12_500);
    expect(allocation.allocatedBasisCents).toBe(487_500);
    expect(allocation.royaltyCents).toBe(14_625); // 3% of 487,500
    // The ordering identity: overhead legs + allocated basis === gross.
    expect(
      allocation.overhead.overheadTotalCents + allocation.allocatedBasisCents,
    ).toBe(500_000);
  });

  it("never prices a royalty on money the park's overhead already consumed", () => {
    // 3% of the gross (15,000) would be a royalty on overhead money; the
    // allocated remainder prices 14,625.
    const allocation = spatialZoneAllocationCents({
      grossCents: 500_000,
      securityBps: 125,
      wristbandMaintenanceBps: 75,
      ticketingPlatformBps: 50,
      zoneRoyaltyBps: 300,
    });
    expect(allocation.royaltyCents).not.toBe(15_000);
    expect(allocation.royaltyCents).toBe(14_625);
  });

  it("refuses a negative gross", () => {
    expect(() =>
      spatialZoneAllocationCents({
        grossCents: -1,
        securityBps: 0,
        wristbandMaintenanceBps: 0,
        ticketingPlatformBps: 0,
        zoneRoyaltyBps: 0,
      }),
    ).toThrow();
  });
});

describe("spatialRowEventId — the replay identity", () => {
  it("is stable for the same row and distinct across senders, venues, zones, periods, and row ids", () => {
    const base = {
      sender: "turnstile" as const,
      venueId: "venue-a",
      zoneCode: "ORBIT",
      period: "2026-03",
      senderRowId: "TS-1",
    };
    const same = spatialRowEventId(base);
    expect(same).toBe(spatialRowEventId({ ...base }));
    const variants = [
      { ...base, sender: "pass" as const },
      { ...base, venueId: "venue-b" },
      { ...base, zoneCode: "NOVA" },
      { ...base, period: "2026-04" },
      { ...base, senderRowId: "TS-2" },
    ];
    for (const variant of variants) {
      expect(spatialRowEventId(variant)).not.toBe(same);
    }
  });
});
