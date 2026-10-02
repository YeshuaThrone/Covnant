// Focused unit tests for the book/magazine lane's pure money engine (PR 26)
// — the directive's pinned math the store-backed cascade tests do not
// isolate: the POD print deduction exact to the cent, the agency tier's
// inclusive boundary cases (exactly $2.99 and exactly $9.99), the anthology
// pro-rata fixtures (floored shares, visible dust), the magazine cut modes,
// the sequential advance recoupment's exact switchover point, and the
// content-derived event-id identity spaces.

import { describe, expect, it } from "vitest";
import {
  AGENCY_OUTSIDE_ROYALTY_BPS,
  AGENCY_TIER_MAX_MICROS,
  AGENCY_TIER_MIN_MICROS,
  AGENCY_TIER_ROYALTY_BPS,
  CHANNEL_DISCOUNT_MAX_BPS,
  CHANNEL_DISCOUNT_MIN_BPS,
  bookAudiobookEventId,
  bookEbookEventId,
  bookMagazineEventId,
  bookPrintEventId,
  bookStreamPoolClass,
  anthologyProRataSplits,
  channelDiscountMicros,
  ebookAgencyRoyaltyMicros,
  ebookAgencyTier,
  ebookGrossMicros,
  magazineFlatPerIssueCutCents,
  magazinePercentageCutMicros,
  podPrintDeductionMicros,
  podPrintNetRoyaltyMicros,
  sequentialAdvanceRecoupment,
  validateAgencyPriceMicros,
  validateBookUnits,
  validateChannelDiscountBps,
  type AnthologyContributorCount,
} from "../books";
import type { BookLineDetail } from "../records";

const NOW_PERIOD = "2026-10";

function printDetail(
  overrides: Partial<Extract<BookLineDetail, { kind: "print_sale" }>> = {},
): Extract<BookLineDetail, { kind: "print_sale" }> {
  return {
    kind: "print_sale",
    platform: "amazon_kdp",
    isbn: "9781612198300",
    formatType: "paperback",
    orderId: "ord-001",
    units: 1,
    grossRetailMicros: "1000000000", // $10.00
    printingCostPerUnitMicros: "231000000", // $2.31
    distributionFeeMicros: "20000000", // $0.20
    channelDiscountBps: 5500,
    period: NOW_PERIOD,
    ...overrides,
  };
}

function ebookDetail(
  overrides: Partial<Extract<BookLineDetail, { kind: "ebook_sale" }>> = {},
): Extract<BookLineDetail, { kind: "ebook_sale" }> {
  return {
    kind: "ebook_sale",
    platform: "amazon_kdp",
    isbn: "9781612198300",
    orderId: "ord-002",
    units: 1,
    listPriceMicros: "999000000", // $9.99
    period: NOW_PERIOD,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1 · POD print deduction — exact integer micros, keyed on isbn + format.
// ---------------------------------------------------------------------------

describe("podPrintNetRoyaltyMicros", () => {
  it("computes the directive's equation exactly — gross − printing × units − fee − discount", () => {
    // $10.00 − $2.31 − $0.20 − 55% of $10.00 ($5.50) = $1.99.
    const detail = printDetail({
      channelDiscountBps: 5500,
    });
    expect(channelDiscountMicros(1000000000n, 5500)).toBe(550000000n);
    expect(podPrintNetRoyaltyMicros(detail)).toBe(199000000n);
    expect(podPrintDeductionMicros(detail)).toBe(801000000n);
  });

  it("scales the printing COGS by units and floors nothing away — exact micros", () => {
    // $19.99 − 2 × $3.33 − $0.42 − 40% of $19.99 ($7.996) = $4.914.
    const detail = printDetail({
      units: 2,
      grossRetailMicros: "1999000000",
      printingCostPerUnitMicros: "333000000",
      distributionFeeMicros: "42000000",
      channelDiscountBps: 4000,
    });
    expect(podPrintNetRoyaltyMicros(detail)).toBe(491400000n);
    expect(podPrintDeductionMicros(detail)).toBe(1507600000n);
  });

  it("treats the format as identity, not money — same legs, other format, same net", () => {
    const paperback = podPrintNetRoyaltyMicros(printDetail({ formatType: "paperback" }));
    const hardcover = podPrintNetRoyaltyMicros(printDetail({ formatType: "hardcover" }));
    expect(paperback).toBe(hardcover);
  });
});

describe("parse-time validators", () => {
  it("holds the channel discount in the 40–55% wholesale band", () => {
    expect(validateChannelDiscountBps(CHANNEL_DISCOUNT_MIN_BPS, 2)).toBe(4000);
    expect(validateChannelDiscountBps(CHANNEL_DISCOUNT_MAX_BPS, 2)).toBe(5500);
    expect(() => validateChannelDiscountBps(3_999, 2)).toThrow(RangeError);
    expect(() => validateChannelDiscountBps(5_501, 2)).toThrow(RangeError);
  });

  it("demands positive whole units and a positive list price", () => {
    expect(validateBookUnits(3, 4)).toBe(3);
    expect(() => validateBookUnits(0, 4)).toThrow(RangeError);
    expect(() => validateBookUnits(-1, 4)).toThrow(RangeError);
    expect(validateAgencyPriceMicros(AGENCY_TIER_MIN_MICROS, 5)).toBe(299000000n);
    expect(() => validateAgencyPriceMicros(0n, 5)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 2 · E-book agency model — 70% inside [$2.99, $9.99] INCLUSIVE, 35% outside.
// ---------------------------------------------------------------------------

describe("ebookAgencyTier — the boundary cases the directive pins", () => {
  it("is tier (70%) at exactly $2.99 and exactly $9.99", () => {
    expect(ebookAgencyTier(AGENCY_TIER_MIN_MICROS)).toBe("seventy_percent"); // $2.99
    expect(ebookAgencyTier(AGENCY_TIER_MAX_MICROS)).toBe("seventy_percent"); // $9.99
  });

  it("is outside (35%) at $2.98 and $10.00 — one micro outside either bound", () => {
    expect(ebookAgencyTier(298000000n)).toBe("thirty_five_percent"); // $2.98
    expect(ebookAgencyTier(1000000000n)).toBe("thirty_five_percent"); // $10.00
    expect(ebookAgencyTier(AGENCY_TIER_MIN_MICROS - 1n)).toBe("thirty_five_percent");
    expect(ebookAgencyTier(AGENCY_TIER_MAX_MICROS + 1n)).toBe("thirty_five_percent");
  });

  it("pays 70% of list × units inside the tier", () => {
    const result = ebookAgencyRoyaltyMicros(ebookDetail()); // $9.99 × 1
    expect(result.tier).toBe("seventy_percent");
    expect(result.royaltyBps).toBe(AGENCY_TIER_ROYALTY_BPS);
    expect(result.royaltyMicros).toBe(699300000n); // $6.993, exact
    expect(ebookGrossMicros(ebookDetail())).toBe(999000000n);
  });

  it("pays 70% of a $2.99 multi-unit row and 35% outside the tier", () => {
    const tierRow = ebookAgencyRoyaltyMicros(
      ebookDetail({ listPriceMicros: "299000000", units: 3 }),
    );
    expect(tierRow.tier).toBe("seventy_percent");
    expect(tierRow.royaltyMicros).toBe(627900000n); // $2.99 × 3 × 70%

    const outsideRow = ebookAgencyRoyaltyMicros(
      ebookDetail({ listPriceMicros: "1000000000", units: 2 }),
    );
    expect(outsideRow.tier).toBe("thirty_five_percent");
    expect(outsideRow.royaltyBps).toBe(AGENCY_OUTSIDE_ROYALTY_BPS);
    expect(outsideRow.royaltyMicros).toBe(700000000n); // $10.00 × 2 × 35%
  });
});

// ---------------------------------------------------------------------------
// 3 · Anthology pro-rata — floored shares, visible dust.
// ---------------------------------------------------------------------------

describe("anthologyProRataSplits", () => {
  const authors: AnthologyContributorCount[] = [
    { payeeId: "payee-a", payeeName: "Author A", count: 300 },
    { payeeId: "payee-b", payeeName: "Author B", count: 200 },
    { payeeId: "payee-c", payeeName: "Author C", count: 100 },
  ];

  it("splits by page count with floored shares and a visible dust cent", () => {
    const result = anthologySplits(10_000, "page_count", authors);
    expect(result).toEqual({
      basis: "page_count",
      totalCents: 10_000,
      allocations: [
        { payeeId: "payee-a", payeeName: "Author A", shareCents: 5_000 }, // $100 × 300/600
        { payeeId: "payee-b", payeeName: "Author B", shareCents: 3_333 }, // floor(3333.33)
        { payeeId: "payee-c", payeeName: "Author C", shareCents: 1_666 }, // floor(1666.67)
      ],
      dustCents: 1, // visible, never redistributed silently
    });
  });

  it("splits by word count exactly when the counts divide the basis", () => {
    const result = anthologySplits(1_000, "word_count", [
      { payeeId: "payee-a", payeeName: "Author A", count: 9_000 },
      { payeeId: "payee-b", payeeName: "Author B", count: 1_000 },
    ]);
    expect(result.allocations.map((a) => a.shareCents)).toEqual([900, 100]);
    expect(result.dustCents).toBe(0);
  });

  it("splits nothing when the basis is zero", () => {
    const result = anthologySplits(0, "page_count", authors);
    expect(result.allocations.every((a) => a.shareCents === 0)).toBe(true);
    expect(result.dustCents).toBe(0);
  });

  it("refuses a hostile schedule — zero or negative counts", () => {
    expect(() =>
      anthologySplits(1_000, "page_count", [
        { payeeId: "payee-a", payeeName: "A", count: 0 },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      anthologySplits(1_000, "word_count", [
        { payeeId: "payee-a", payeeName: "A", count: -5 },
      ]),
    ).toThrow(RangeError);
  });
});

function anthologySplits(
  netCents: number,
  basis: "page_count" | "word_count",
  contributors: AnthologyContributorCount[],
) {
  // Imported inside a thin wrapper only to keep the assertions above reading
  // like the fixtures table; the function itself is pure.
  return anthologyProRataSplits(netCents, basis, contributors);
}

// ---------------------------------------------------------------------------
// 4 · Magazine editorial cuts — flat per-issue vs percentage modes.
// ---------------------------------------------------------------------------

describe("magazine cut modes", () => {
  it("pays the flat per-issue cut as the contracted fee, once", () => {
    expect(magazineFlatPerIssueCutCents(2_500)).toBe(2_500);
    expect(() => magazineFlatPerIssueCutCents(0)).toThrow(RangeError);
    expect(() => magazineFlatPerIssueCutCents(-1)).toThrow(RangeError);
  });

  it("pays the percentage cut of the subscription funding event, floored", () => {
    expect(magazinePercentageCutMicros(1_000_000_000n, 1_500)).toBe(150_000_000n);
    // Sub-cent residue floors — never rounds up into a contributor's credit.
    expect(magazinePercentageCutMicros(999_999_999n, 1_500)).toBe(149_999_999n);
  });

  it("rejects percentage cuts outside 1–10,000 bps", () => {
    expect(() => magazinePercentageCutMicros(1_000_000_000n, 10_001)).toThrow(RangeError);
    expect(() => magazinePercentageCutMicros(1_000_000_000n, -1)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 5 · Sequential advance recoupment — the exact switchover point.
// ---------------------------------------------------------------------------

describe("sequentialAdvanceRecoupment", () => {
  it("fills the pools in sequence order, 100% to recoupment while any is open", () => {
    const result = sequentialAdvanceRecoupment(12_000, [
      { poolId: "pool-1", remainingCents: 10_000 },
      { poolId: "pool-2", remainingCents: 5_000 },
    ]);
    expect(result.applications).toEqual([
      { poolId: "pool-1", appliedCents: 10_000, recoupedBeforeCents: 0, remainingCents: 0 },
      { poolId: "pool-2", appliedCents: 2_000, recoupedBeforeCents: 0, remainingCents: 3_000 },
    ]);
    expect(result.recoupedCents).toBe(12_000);
    expect(result.excessCents).toBe(0);
  });

  it("switches over exactly at the clearing event — its remainder is the splits' basis", () => {
    const result = sequentialAdvanceRecoupment(17_500, [
      { poolId: "pool-1", remainingCents: 10_000 },
      { poolId: "pool-2", remainingCents: 5_000 },
    ]);
    expect(result.recoupedCents).toBe(15_000);
    expect(result.excessCents).toBe(2_500); // the FIRST post-clearance cents
  });

  it("routes everything to splits once every pool is clear, skipping cleared pools in sequence", () => {
    const allClear = sequentialAdvanceRecoupment(5_000, [
      { poolId: "pool-1", remainingCents: 0 },
    ]);
    expect(allClear.applications).toEqual([]);
    expect(allClear.recoupedCents).toBe(0);
    expect(allClear.excessCents).toBe(5_000);

    const skipCleared = sequentialAdvanceRecoupment(3_000, [
      { poolId: "pool-1", remainingCents: 0 },
      { poolId: "pool-2", remainingCents: 5_000 },
    ]);
    expect(skipCleared.applications).toEqual([
      { poolId: "pool-2", appliedCents: 3_000, recoupedBeforeCents: 0, remainingCents: 2_000 },
    ]);
    expect(skipCleared.excessCents).toBe(0);
  });

  it("refuses a negative royalty or pool position", () => {
    expect(() => sequentialAdvanceRecoupment(-1, [])).toThrow(RangeError);
    expect(() =>
      sequentialAdvanceRecoupment(100, [{ poolId: "p", remainingCents: -2 }]),
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 6 · Pool-class isolation + content-derived event identities.
// ---------------------------------------------------------------------------

describe("bookStreamPoolClass — the isolation firewall", () => {
  it("routes print, e-book, and audiobook rows to their OWN pool classes", () => {
    expect(bookStreamPoolClass(printDetail())).toBe("print_advance");
    expect(bookStreamPoolClass(ebookDetail())).toBe("ebook_advance");
    expect(
      bookStreamPoolClass({
        kind: "audiobook_sale",
        platform: "amazon_kdp",
        isbn: "9781612198300",
        orderId: "ord-003",
        units: 1,
        royaltyPerUnitMicros: "100000000",
        grossMicros: "100000000",
        period: NOW_PERIOD,
      }),
    ).toBe("audiobook_production_unrecouped");
  });

  it("carries no pool for magazine rows — their money routes through the split schedule", () => {
    const magazineDetail: Extract<BookLineDetail, { kind: "magazine_issue" }> = {
      kind: "magazine_issue",
      platform: "zinio",
      magazineId: "mag-atlas-monthly",
      issueId: "iss-2026-10",
      eventId: "zin-evt-1",
      units: 1,
      grossMicros: "500000000",
      period: NOW_PERIOD,
    };
    expect(bookStreamPoolClass(magazineDetail)).toBeNull();
  });
});

describe("event-id identity spaces", () => {
  it("derives stable content identities — identity fields, never money", () => {
    const detail = printDetail({ channelDiscountBps: 5500 });
    const expensiveDetail = printDetail({ channelDiscountBps: 4000 });
    // The discount leg is money — it MUST NOT move the identity.
    expect(bookPrintEventId(detail)).toBe(bookPrintEventId(expensiveDetail));
    expect(bookPrintEventId(detail)).toMatch(/^book:print:[0-9a-f]{64}$/);
  });

  it("separates identities per isbn, order, and format", () => {
    const base = printDetail();
    expect(bookPrintEventId(base)).not.toBe(
      bookPrintEventId(printDetail({ isbn: "9781612198393" })),
    );
    expect(bookPrintEventId(base)).not.toBe(bookPrintEventId(printDetail({ orderId: "ord-9" })));
    expect(bookPrintEventId(base)).not.toBe(
      bookPrintEventId(printDetail({ formatType: "hardcover" })),
    );
    expect(bookEbookEventId(ebookDetail())).toMatch(/^book:ebook:[0-9a-f]{64}$/);
    expect(bookAudiobookEventId({
      kind: "audiobook_sale",
      platform: "amazon_kdp",
      isbn: "9781612198300",
      orderId: "ord-003",
      units: 1,
      royaltyPerUnitMicros: "100000000",
      grossMicros: "100000000",
      period: NOW_PERIOD,
    })).toMatch(/^book:audio:[0-9a-f]{64}$/);
  });

  it("keys magazine identities on the sender's own event id", () => {
    const issue: Extract<BookLineDetail, { kind: "magazine_issue" }> = {
      kind: "magazine_issue",
      platform: "substack",
      magazineId: "mag-atlas-monthly",
      issueId: "iss-2026-10",
      eventId: "sub-evt-77",
      units: 1,
      grossMicros: "500000000",
      period: NOW_PERIOD,
    };
    expect(bookMagazineEventId(issue)).toBe(bookMagazineEventId({ ...issue, units: 9 }));
    expect(bookMagazineEventId(issue)).not.toBe(
      bookMagazineEventId({ ...issue, eventId: "sub-evt-78" }),
    );
  });
});
