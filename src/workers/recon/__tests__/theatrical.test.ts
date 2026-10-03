// Focused unit tests for the AGBOR box office lane's pure money engine (PR 30)
// — the directive's pinned math the store-backed waterfall tests do not
// isolate: the AGBOR calculator exact to the cent (each deduction leg
// flooring, never rounding up), the comedy guarantee's greater-of logic in
// both directions (flat $10,000 vs 85% of the post-recoupment net), the
// Grand Rights founder band (6–10% of AGBOR) and its exact floor, the
// investor recoupment tiers' exact 50/50 switchover at the capitalization
// budget boundary (with the sub-cent dust sweep), the local promoter expense
// cap's min() recoupment, and the per-sender event-id identity spaces.

import { describe, expect, it } from "vitest";
import {
  GRAND_RIGHTS_MAX_BPS,
  GRAND_RIGHTS_MIN_BPS,
  MICROS_PER_DOLLAR,
  agborCents,
  comedyGuaranteeSettlement,
  grandRightsDeductionCents,
  legMicrosToCents,
  productionScopeKey,
  theatricalRecoupmentWalk,
  theatricalStopEventId,
  venueExpenseRecoupment,
  validateGrandRightsBps,
  validateGuaranteePercentageBps,
  type TheatricalStopLegsMicros,
} from "../theatrical";
import type { TheatricalLineDetail } from "../records";

const USD = MICROS_PER_DOLLAR; // $1 = 1e8 micros
const CENT = 1_000_000n; // 1 whole ledger cent = 1e6 micros

function legs(overrides: Partial<TheatricalStopLegsMicros> = {}): TheatricalStopLegsMicros {
  return {
    gborMicros: 1_000_000n * USD, // $1,000,000.00
    salesTaxMicros: 0n,
    cardProcessingMicros: 0n,
    facilityMaintenanceMicros: 0n,
    ffeMicros: 0n,
    groupDiscountMicros: 0n,
    ...overrides,
  };
}

function stopDetail(
  overrides: Partial<TheatricalLineDetail> = {},
): TheatricalLineDetail {
  return {
    sender: "axs",
    productionId: "prod-hamilton-chicago",
    venueId: "venue-civic-opera",
    showDate: "2026-10-02",
    settlementId: "stl-001",
    city: "Chicago",
    gborMicros: "0",
    salesTaxMicros: "0",
    cardProcessingMicros: "0",
    facilityMaintenanceMicros: "0",
    ffeMicros: "0",
    groupDiscountMicros: "0",
    venueExpenseMicros: "0",
    promoterExpenseCapMicros: "0",
    period: "2026-10",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The AGBOR calculator — exact to the cent.
// ---------------------------------------------------------------------------

describe("agborCents", () => {
  it("computes the full equation: GBOR minus taxes, card fees, facility/FF&E fees, and group discounts", () => {
    // $1,000,000.00 GBOR; $85,432.19 tax; $12,500.75 card; $18,000.00
    // facility; $6,250.50 FF&E; $40,000.00 group discounts.
    const result = agborCents(
      legs({
        salesTaxMicros: 85_432n * USD + 19n * CENT,
        cardProcessingMicros: 12_500n * USD + 75n * CENT,
        facilityMaintenanceMicros: 18_000n * USD,
        ffeMicros: 6_250n * USD + 50n * CENT,
        groupDiscountMicros: 40_000n * USD,
      }),
    );
    expect(result.gborCents).toBe(100_000_000);
    expect(result.agborCents).toBe(100_000_000 - 8_543_219 - 1_250_075 - 1_800_000 - 625_050 - 4_000_000);
    // The conservation identity: AGBOR + all deductions = GBOR, exact.
    expect(
      result.agborCents +
        result.salesTaxCents +
        result.cardFeesCents +
        result.facilityFeeCents +
        result.ffeFeeCents +
        result.groupDiscountCents,
    ).toBe(result.gborCents);
  });

  it("floors each deduction leg — sub-cent residue never rounds up", () => {
    // $1,000.00 GBOR; $0.999999 in each leg (99,999,900 micros → 99 cents,
    // floor).
    const result = agborCents(
      legs({
        gborMicros: 1_000n * USD,
        salesTaxMicros: 99_999_900n,
        cardProcessingMicros: 99_999_900n,
        facilityMaintenanceMicros: 99_999_900n,
        ffeMicros: 99_999_900n,
        groupDiscountMicros: 99_999_900n,
      }),
    );
    expect(result.salesTaxCents).toBe(99);
    expect(result.cardFeesCents).toBe(99);
    expect(result.facilityFeeCents).toBe(99);
    expect(result.ffeFeeCents).toBe(99);
    expect(result.groupDiscountCents).toBe(99);
    // Five deductions of $0.999999 = $4.999995 total; AGBOR floors to
    // $1000.00 − 5×99 cents, never the $999.995005 a float would give.
    expect(result.agborCents).toBe(100_000 - 495);
  });

  it("reports a negative AGBOR when the deduction legs outrun the gross (the caller quarantines)", () => {
    const result = agborCents(
      legs({
        gborMicros: 100n * USD,
        salesTaxMicros: 150n * USD,
      }),
    );
    expect(result.agborCents).toBe(-5_000);
  });
});

describe("legMicrosToCents", () => {
  it("floors and rejects overflow past the safe integer-cent range", () => {
    expect(legMicrosToCents(1_500_000n)).toBe(1); // 1.5¢ → 1¢
    expect(legMicrosToCents(-1_500_000n)).toBe(-1); // −1.5¢ → −1¢ (toward zero, never up)
    // 1e22 micros = 1e16 cents > 2^53 — the safe-integer overflow guard.
    expect(() => legMicrosToCents(10_000_000_000_000_000_000_000n)).toThrow(/overflow/);
  });
});

// ---------------------------------------------------------------------------
// The comedy tour guarantee — greater-of, both directions.
// ---------------------------------------------------------------------------

describe("comedyGuaranteeSettlement", () => {
  it("pays the percentage leg when 85% of the net beats the flat guarantee", () => {
    // $100,000 AGBOR, $0 venue expense, $10,000 flat vs 85% → $85,000.
    const result = comedyGuaranteeSettlement(10_000_000, 0, 1_000_000, 8_500);
    expect(result.winner).toBe("percentage");
    expect(result.percentageLegCents).toBe(8_500_000);
    expect(result.payoutCents).toBe(8_500_000);
  });

  it("pays the flat guarantee when the net is weak — the floor obligation holds", () => {
    // $10,000.00 AGBOR, $9,500.00 venue expense recouped → $500.00 net;
    // 85% of $500.00 = $425.00 (42,500 cents). The $10,000 flat wins.
    const result = comedyGuaranteeSettlement(1_000_000, 950_000, 1_000_000, 8_500);
    expect(result.winner).toBe("flat");
    expect(result.percentageLegCents).toBe(42_500);
    expect(result.payoutCents).toBe(1_000_000);
  });

  it("prefers the percentage leg on an exact tie — the deterministic tiebreak", () => {
    // $10,000 net; flat $8,500 vs 85% = $8,500.00 → the earned leg wins.
    const result = comedyGuaranteeSettlement(1_000_000, 0, 850_000, 8_500);
    expect(result.winner).toBe("percentage");
    expect(result.payoutCents).toBe(850_000);
  });

  it("floors the percentage leg's sub-cent residue", () => {
    // $0.99 net at 85% = $0.8415 → 84 cents, floor.
    const result = comedyGuaranteeSettlement(99, 0, 0, 8_500);
    expect(result.percentageLegCents).toBe(84);
    expect(result.payoutCents).toBe(84);
  });

  it("rejects a percentage outside 0–10000 bps", () => {
    expect(() => comedyGuaranteeSettlement(1_000_000, 0, 500_000, 10_001)).toThrow(/0–10000/);
    expect(() => comedyGuaranteeSettlement(1_000_000, 0, 500_000, -1)).toThrow(/0–10000/);
  });
});

// ---------------------------------------------------------------------------
// Grand Rights — the founder band and the top-line deduction.
// ---------------------------------------------------------------------------

describe("grandRightsDeductionCents", () => {
  it("deducts inside the founder band, floored", () => {
    // $1,000,000 AGBOR at 7.5% (750 bps) = $75,000.
    expect(grandRightsDeductionCents(100_000_000, 750)).toBe(7_500_000);
    // $999.99 AGBOR at 6% = $59.9994 → $59.99 (floor).
    expect(grandRightsDeductionCents(99_999, GRAND_RIGHTS_MIN_BPS)).toBe(5_999);
  });

  it("accepts the band's exact edges and refuses beyond them", () => {
    expect(validateGrandRightsBps(600, 1)).toBe(600);
    expect(validateGrandRightsBps(1000, 1)).toBe(1000);
    expect(() => validateGrandRightsBps(599, 1)).toThrow(/founder band/);
    expect(() => validateGrandRightsBps(1001, 1)).toThrow(/founder band/);
    expect(GRAND_RIGHTS_MIN_BPS).toBe(600);
    expect(GRAND_RIGHTS_MAX_BPS).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// The investor recoupment tiers — 100% until clear, exact 50/50 switchover.
// ---------------------------------------------------------------------------

describe("theatricalRecoupmentWalk", () => {
  it("applies 100% of the net to investors before the budget recoups", () => {
    // $10M budget, $0 recouped, $4M net → all $4M to investors.
    const walk = theatricalRecoupmentWalk(400_000_000, 1_000_000_000, 0);
    expect(walk.appliedCents).toBe(400_000_000);
    expect(walk.recoupedAfterCents).toBe(400_000_000);
    expect(walk.remainingCents).toBe(600_000_000);
    expect(walk.switchover).toBe(false);
    expect(walk.producerShareCents).toBe(0);
    expect(walk.investorShareCents).toBe(0);
  });

  it("splits the clearing event exactly at the budget boundary — the automatic switchover", () => {
    // $10M budget, $9M already recouped, $3M net: $1M completes the budget
    // (100% investors), the $2M excess halves 50/50 producer/investor.
    const walk = theatricalRecoupmentWalk(300_000_000, 1_000_000_000, 900_000_000);
    expect(walk.appliedCents).toBe(100_000_000);
    expect(walk.recoupedAfterCents).toBe(1_000_000_000);
    expect(walk.remainingCents).toBe(0);
    expect(walk.switchover).toBe(true);
    expect(walk.producerShareCents).toBe(100_000_000);
    expect(walk.investorShareCents).toBe(100_000_000);
    // Conservation: applied + both halves = the event's net, exact.
    expect(walk.appliedCents + walk.producerShareCents + walk.investorShareCents).toBe(300_000_000);
  });

  it("walks the permanent 50/50 tier after recoupment — no further application", () => {
    // $10M budget fully recouped, $1,000.01 net: halves with 1¢ dust.
    const walk = theatricalRecoupmentWalk(100_001, 1_000_000_000, 1_000_000_000);
    expect(walk.appliedCents).toBe(0);
    expect(walk.switchover).toBe(false);
    expect(walk.producerShareCents).toBe(50_000);
    expect(walk.investorShareCents).toBe(50_000);
    expect(walk.dustCents).toBe(1);
  });

  it("refuses a running position beyond the budget — the corrupt-deal guard", () => {
    expect(() => theatricalRecoupmentWalk(1_000_000, 500_000, 500_001)).toThrow(
      /position exceeds the budget/,
    );
  });
});

// ---------------------------------------------------------------------------
// The local promoter expense cap — min(expense, cap), overage visible.
// ---------------------------------------------------------------------------

describe("venueExpenseRecoupment", () => {
  it("recoups the full expense under the cap", () => {
    const result = venueExpenseRecoupment(250_000, 500_000);
    expect(result.venueExpenseRecoupedCents).toBe(250_000);
    expect(result.venueExpenseCappedCents).toBe(0);
  });

  it("caps the recoupment at the promoter cap — the overage stays visible", () => {
    // $5,000 expense against a $3,500 local promoter cap: $3,500 recoups
    // before the net tour splits; $1,500 is the promoter's own money.
    const result = venueExpenseRecoupment(500_000, 350_000);
    expect(result.venueExpenseRecoupedCents).toBe(350_000);
    expect(result.venueExpenseCappedCents).toBe(150_000);
  });

  it("refuses negative legs", () => {
    expect(() => venueExpenseRecoupment(-1, 100)).toThrow(/non-negative/);
    expect(() => venueExpenseRecoupment(100, -1)).toThrow(/non-negative/);
  });
});

// ---------------------------------------------------------------------------
// Identity — per-sender event-id spaces.
// ---------------------------------------------------------------------------

describe("theatricalStopEventId", () => {
  it("derives one id per (sender, production, venue, show date, settlement id)", () => {
    const id = theatricalStopEventId(stopDetail());
    expect(id).toMatch(/^theatrical:axs:[0-9a-f]{64}$/);
    expect(theatricalStopEventId(stopDetail())).toBe(id);
  });

  it("keeps two senders' sheets for the same stop distinct", () => {
    const axs = theatricalStopEventId(stopDetail());
    const tm = theatricalStopEventId(stopDetail({ sender: "ticketmaster" }));
    const eb = theatricalStopEventId(stopDetail({ sender: "eventbrite" }));
    const vp = theatricalStopEventId(stopDetail({ sender: "venuepos" }));
    expect(new Set([axs, tm, eb, vp]).size).toBe(4);
  });

  it("keeps different stops of the same production distinct", () => {
    const nightOne = theatricalStopEventId(stopDetail({ showDate: "2026-10-02" }));
    const nightTwo = theatricalStopEventId(stopDetail({ showDate: "2026-10-03" }));
    expect(nightOne).not.toBe(nightTwo);
  });
});

describe("productionScopeKey", () => {
  it("names the production scope the deal of record hangs on", () => {
    expect(productionScopeKey("prod-hamilton-chicago")).toBe("production:prod-hamilton-chicago");
  });
});

describe("validateGuaranteePercentageBps", () => {
  it("accepts the founder example — 8500 bps is 85% of the net", () => {
    expect(validateGuaranteePercentageBps(8_500, 7)).toBe(8_500);
  });

  it("refuses a non-integer or out-of-range guarantee percentage", () => {
    expect(() => validateGuaranteePercentageBps(-1, 7)).toThrow(/0–10000 bps/);
    expect(() => validateGuaranteePercentageBps(10_001, 7)).toThrow(/0–10000 bps/);
    expect(() => validateGuaranteePercentageBps(85.5, 7)).toThrow(/0–10000 bps/);
  });
});
