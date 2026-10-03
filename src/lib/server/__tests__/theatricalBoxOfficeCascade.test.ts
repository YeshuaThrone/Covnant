// Store-backed tests for the AGBOR box office + theatrical recoupment
// cascade (PR 30) — the durable behaviors the pure-math tests do not
// isolate: the deal-of-record gate (fail-closed absent, currency firewall),
// the versioned re-registration (the recoupment position NEVER resets), the
// Grand Rights deduction taken BEFORE the production profit splits, the
// capped venue-expense recoupment before the net tour splits, both deal
// classes' waterfalls through the real store (the comedy greater-of; the
// theatrical investor tiers' exact 50/50 switchover), and the whole pass's
// replay idempotency (a re-shipped report is counted no-ops, never double
// money).

import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import {
  applyTheatricalStopOutcome,
  registerTheatricalProductionDeal,
  runTheatricalWaterfallPass,
} from "@/lib/server/theatricalBoxOfficeCascade";
import type { TheatricalLineDetail, ParsedStatementLine } from "@/workers/recon/records";
import type { TheatricalLineOutcome } from "@/workers/recon/theatricalQueue";

const NOW = new Date("2026-10-02T09:00:00Z");
const PRODUCTION = "prod-hamilton-chicago";

function stopDetail(
  overrides: Partial<TheatricalLineDetail> = {},
): TheatricalLineDetail {
  return {
    sender: "axs",
    productionId: PRODUCTION,
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

/** A minimal honest ParsedStatementLine carrying a theatrical detail. */
function theatricalLine(
  detail: TheatricalLineDetail,
  overrides: Partial<ParsedStatementLine> = {},
): ParsedStatementLine {
  return {
    lineNumber: 1,
    profile: "theatrical_axs_settlement_csv",
    rightsType: "unknown",
    statementSourceType: null,
    tierLevel: null,
    rightsPipeline: "composition_performance",
    period: "2026-10",
    currency: "USD",
    grossMicros: BigInt(detail.gborMicros),
    isAdjustment: false,
    identifiers: {},
    workTitle: null,
    territory: null,
    platform: null,
    usageNote: "theatrical lane row",
    raw: [],
    guildResidual: null,
    podcastDetail: null,
    gamingDetail: null,
    livestreamDetail: null,
    webtoonDetail: null,
    merchDetail: null,
    aiDetail: null,
    theatricalDetail: detail,
    ...overrides,
  };
}

function outcome(
  detail: TheatricalLineDetail,
  eventId: string,
  overrides: Partial<TheatricalLineOutcome> = {},
): TheatricalLineOutcome {
  return {
    line: theatricalLine(detail),
    eventId,
    disposition: "money",
    netCents: 0,
    netMicros: detail.gborMicros,
    deductionMicros: "0",
    detail,
    ...overrides,
  };
}

/** The directive's example terms: $10,000 flat vs 85% of the net. */
function comedyDeal(
  overrides: Partial<Parameters<typeof registerTheatricalProductionDeal>[1]> = {},
) {
  return {
    productionId: PRODUCTION,
    dealClass: "comedy_guarantee" as const,
    currency: "USD",
    artistPayeeId: "artist-001",
    artistPayeeName: "The Comedian",
    flatGuaranteeCents: 1_000_000, // $10,000.00
    guaranteePercentageBps: 8_500, // 85%
    ...overrides,
  };
}

/** A $10M capitalization budget with a 50/50 producer/investor pair. */
function theatricalDeal(
  overrides: Partial<Parameters<typeof registerTheatricalProductionDeal>[1]> = {},
) {
  return {
    productionId: PRODUCTION,
    dealClass: "theatrical_recoupment" as const,
    currency: "USD",
    producerPayeeId: "producer-001",
    producerPayeeName: "The Producer",
    investorPayeeId: "investor-001",
    investorPayeeName: "The Investors",
    capitalizationBudgetCents: 1_000_000_000, // $10,000,000.00
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Registration — the fail-closed gates.
// ---------------------------------------------------------------------------

describe("registerTheatricalProductionDeal", () => {
  it("registers the versioned deal of record", async () => {
    const store = new InMemoryStore();
    const deal = await registerTheatricalProductionDeal(store, comedyDeal(), NOW);
    if ("ok" in deal) throw new Error(`registration failed: ${deal.message}`);
    expect(deal.scope_key).toBe(`production:${PRODUCTION}`);
    expect(deal.version).toBe(1);
    expect(deal.recouped_cents).toBe(0);
  });

  it("refuses a half-registered Grand Rights license", async () => {
    const store = new InMemoryStore();
    const half = await registerTheatricalProductionDeal(
      store,
      comedyDeal({ grandRightsRateBps: 750 }),
      NOW,
    );
    expect(half).toMatchObject({ ok: false, code: "invalid_deal_input" });
  });

  it("refuses a rate outside the founder band (6–10%)", async () => {
    const store = new InMemoryStore();
    const out = await registerTheatricalProductionDeal(
      store,
      comedyDeal({
        grandRightsRateBps: 500,
        publisherCode: "mti",
        publisherPayeeId: "pub-001",
        publisherPayeeName: "MTI",
      }),
      NOW,
    );
    expect(out).toMatchObject({ ok: false, code: "invalid_deal_input" });
  });

  it("refuses a class change on re-registration", async () => {
    const store = new InMemoryStore();
    await registerTheatricalProductionDeal(store, comedyDeal(), NOW);
    const flipped = await registerTheatricalProductionDeal(
      store,
      theatricalDeal(),
      NOW,
    );
    expect(flipped).toMatchObject({ ok: false, code: "deal_class_conflict" });
  });

  it("refuses a currency change on re-registration", async () => {
    const store = new InMemoryStore();
    await registerTheatricalProductionDeal(store, comedyDeal(), NOW);
    const flipped = await registerTheatricalProductionDeal(
      store,
      comedyDeal({ currency: "EUR" }),
      NOW,
    );
    expect(flipped).toMatchObject({ ok: false, code: "deal_currency_conflict" });
  });

  it("increments the version and preserves the recoupment position on re-registration", async () => {
    const store = new InMemoryStore();
    await registerTheatricalProductionDeal(store, theatricalDeal(), NOW);
    // One stop applies $1,000,000 to the budget.
    await applyTheatricalStopOutcome(
      store,
      {
        productionId: PRODUCTION,
        venueId: "venue-civic-opera",
        showDate: "2026-10-02",
        sourceEventId: "theatrical:axs:one",
        settlementId: "stl-001",
        senderCode: "axs",
        city: "Chicago",
        currency: "USD",
        legs: {
          gborMicros: 10_000_000n * 100_000_000n,
          salesTaxMicros: 0n,
          cardProcessingMicros: 0n,
          facilityMaintenanceMicros: 0n,
          ffeMicros: 0n,
          groupDiscountMicros: 0n,
        },
        venueExpenseMicros: 0n,
        promoterExpenseCapMicros: 0n,
      },
      NOW,
    );
    const reregistered = await registerTheatricalProductionDeal(
      store,
      theatricalDeal(),
      NOW,
    );
    if ("ok" in reregistered) throw new Error(`re-registration failed: ${reregistered.message}`);
    expect(reregistered.version).toBe(2);
    // The investors' position is capital of record — never re-cut.
    expect(reregistered.recouped_cents).toBe(1_000_000_000);
  });
});

// ---------------------------------------------------------------------------
// The waterfall — Grand Rights before splits, the capped venue expenses.
// ---------------------------------------------------------------------------

describe("applyTheatricalStopOutcome — theatrical class", () => {
  it("refuses a stop for an unregistered production (fail-closed)", async () => {
    const store = new InMemoryStore();
    const refused = await applyTheatricalStopOutcome(
      store,
      {
        productionId: "prod-never-registered",
        venueId: "v",
        showDate: "2026-10-02",
        sourceEventId: "theatrical:axs:x",
        settlementId: "s",
        senderCode: "axs",
        city: "Chicago",
        currency: "USD",
        legs: {
          gborMicros: 100n * 100_000_000n,
          salesTaxMicros: 0n,
          cardProcessingMicros: 0n,
          facilityMaintenanceMicros: 0n,
          ffeMicros: 0n,
          groupDiscountMicros: 0n,
        },
        venueExpenseMicros: 0n,
        promoterExpenseCapMicros: 0n,
      },
      NOW,
    );
    expect(refused).toMatchObject({ ok: false, code: "theatrical_deal_not_registered" });
  });

  it("refuses a stop in a currency the deal of record does not settle", async () => {
    const store = new InMemoryStore();
    await registerTheatricalProductionDeal(store, theatricalDeal(), NOW);
    const refused = await applyTheatricalStopOutcome(
      store,
      {
        productionId: PRODUCTION,
        venueId: "v",
        showDate: "2026-10-02",
        sourceEventId: "theatrical:axs:x",
        settlementId: "s",
        senderCode: "axs",
        city: "Chicago",
        currency: "EUR",
        legs: {
          gborMicros: 100n * 100_000_000n,
          salesTaxMicros: 0n,
          cardProcessingMicros: 0n,
          facilityMaintenanceMicros: 0n,
          ffeMicros: 0n,
          groupDiscountMicros: 0n,
        },
        venueExpenseMicros: 0n,
        promoterExpenseCapMicros: 0n,
      },
      NOW,
    );
    expect(refused).toMatchObject({ ok: false, code: "stop_currency_mismatch" });
  });

  it("deducts Grand Rights BEFORE the production profit splits, top-line", async () => {
    const store = new InMemoryStore();
    await registerTheatricalProductionDeal(
      store,
      theatricalDeal({
        grandRightsRateBps: 750, // 7.5%
        publisherCode: "concord",
        publisherPayeeId: "pub-001",
        publisherPayeeName: "Concord Theatricals",
      }),
      NOW,
    );
    const applied = await applyTheatricalStopOutcome(
      store,
      {
        productionId: PRODUCTION,
        venueId: "venue-civic-opera",
        showDate: "2026-10-02",
        sourceEventId: "theatrical:axs:gr",
        settlementId: "stl-001",
        senderCode: "axs",
        city: "Chicago",
        currency: "USD",
        legs: {
          gborMicros: 1_000_000n * 100_000_000n, // $1,000,000.00 GBOR
          salesTaxMicros: 0n,
          cardProcessingMicros: 0n,
          facilityMaintenanceMicros: 0n,
          ffeMicros: 0n,
          groupDiscountMicros: 0n,
        },
        venueExpenseMicros: 0n,
        promoterExpenseCapMicros: 0n,
      },
      NOW,
    );
    if (!applied.ok) throw new Error(applied.message);
    // Grand Rights: 7.5% × $1,000,000 = $75,000 to the publisher.
    expect(applied.sheet.grandRightsCents).toBe(7_500_000);
    // The profit pool the investors walk: AGBOR − GR = $925,000 — 100% to
    // investors (the budget is $10M). The publisher's take came out FIRST.
    expect(applied.recoupment?.appliedCents).toBe(92_500_000);
    expect(applied.recoupment?.switchover).toBe(false);
    expect(applied.accrual?.allocations).toEqual([
      { payee_id: "investor-001", payee_name: "The Investors", role: "investor", share_cents: 92_500_000 },
    ]);
  });

  it("recoups venue expenses at the promoter cap before the net tour splits", async () => {
    const store = new InMemoryStore();
    await registerTheatricalProductionDeal(store, theatricalDeal(), NOW);
    const applied = await applyTheatricalStopOutcome(
      store,
      {
        productionId: PRODUCTION,
        venueId: "venue-civic-opera",
        showDate: "2026-10-02",
        sourceEventId: "theatrical:axs:cap",
        settlementId: "stl-001",
        senderCode: "axs",
        city: "Chicago",
        currency: "USD",
        legs: {
          gborMicros: 100_000n * 100_000_000n, // $100,000.00 GBOR
          salesTaxMicros: 0n,
          cardProcessingMicros: 0n,
          facilityMaintenanceMicros: 0n,
          ffeMicros: 0n,
          groupDiscountMicros: 0n,
        },
        venueExpenseMicros: 5_000n * 100_000_000n, // $5,000.00 expense
        promoterExpenseCapMicros: 3_500n * 100_000_000n, // $3,500.00 cap
      },
      NOW,
    );
    if (!applied.ok) throw new Error(applied.message);
    // $3,500 recoups; the $1,500 overage stays visible as the promoter's.
    expect(applied.sheet.venueExpenseRecoupedCents).toBe(350_000);
    expect(applied.sheet.venueExpenseCappedCents).toBe(150_000);
    // The investors walk the net after the capped recoupment: $96,500.
    expect(applied.recoupment?.appliedCents).toBe(9_650_000);
  });

  it("switches over to 50/50 exactly at the budget boundary", async () => {
    const store = new InMemoryStore();
    await registerTheatricalProductionDeal(
      store,
      theatricalDeal({ capitalizationBudgetCents: 1_000_000 }), // $10,000.00
      NOW,
    );
    // Stop 1: $9,000 net → all to investors.
    const stopOne = await applyTheatricalStopOutcome(
      store,
      {
        productionId: PRODUCTION,
        venueId: "v",
        showDate: "2026-10-02",
        sourceEventId: "theatrical:axs:sw-1",
        settlementId: "s1",
        senderCode: "axs",
        city: "Chicago",
        currency: "USD",
        legs: {
          gborMicros: 9_000n * 100_000_000n, // $9,000.00
          salesTaxMicros: 0n,
          cardProcessingMicros: 0n,
          facilityMaintenanceMicros: 0n,
          ffeMicros: 0n,
          groupDiscountMicros: 0n,
        },
        venueExpenseMicros: 0n,
        promoterExpenseCapMicros: 0n,
      },
      NOW,
    );
    if (!stopOne.ok) throw new Error(stopOne.message);
    expect(stopOne.recoupment?.switchover).toBe(false);
    expect(stopOne.accrual?.allocations).toEqual([
      { payee_id: "investor-001", payee_name: "The Investors", role: "investor", share_cents: 900_000 },
    ]);
    // Stop 2: $3,000 net → $1,000 completes the budget; $2,000 splits 50/50.
    const stopTwo = await applyTheatricalStopOutcome(
      store,
      {
        productionId: PRODUCTION,
        venueId: "v",
        showDate: "2026-10-03",
        sourceEventId: "theatrical:axs:sw-2",
        settlementId: "s2",
        senderCode: "axs",
        city: "Chicago",
        currency: "USD",
        legs: {
          gborMicros: 3_000n * 100_000_000n, // $3,000.00
          salesTaxMicros: 0n,
          cardProcessingMicros: 0n,
          facilityMaintenanceMicros: 0n,
          ffeMicros: 0n,
          groupDiscountMicros: 0n,
        },
        venueExpenseMicros: 0n,
        promoterExpenseCapMicros: 0n,
      },
      NOW,
    );
    if (!stopTwo.ok) throw new Error(stopTwo.message);
    expect(stopTwo.recoupment?.appliedCents).toBe(100_000);
    expect(stopTwo.recoupment?.switchover).toBe(true);
    expect(stopTwo.accrual?.allocations).toEqual([
      { payee_id: "investor-001", payee_name: "The Investors", role: "investor", share_cents: 100_000 },
      { payee_id: "producer-001", payee_name: "The Producer", role: "producer", share_cents: 100_000 },
      { payee_id: "investor-001", payee_name: "The Investors", role: "investor", share_cents: 100_000 },
    ]);
    // The deal's running position advanced exactly once per stop.
    const deal = await store.getTheatricalProductionDeal(PRODUCTION);
    expect(deal?.recouped_cents).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// The waterfall — the comedy class's greater-of guarantee.
// ---------------------------------------------------------------------------

describe("applyTheatricalStopOutcome — comedy class", () => {
  it("pays the percentage leg when 85% of the net beats the flat guarantee", async () => {
    const store = new InMemoryStore();
    await registerTheatricalProductionDeal(store, comedyDeal(), NOW);
    const applied = await applyTheatricalStopOutcome(
      store,
      {
        productionId: PRODUCTION,
        venueId: "v",
        showDate: "2026-10-02",
        sourceEventId: "theatrical:axs:c-1",
        settlementId: "s1",
        senderCode: "axs",
        city: "Chicago",
        currency: "USD",
        legs: {
          gborMicros: 1_000_000n * 100_000_000n, // $1,000,000.00
          salesTaxMicros: 0n,
          cardProcessingMicros: 0n,
          facilityMaintenanceMicros: 0n,
          ffeMicros: 0n,
          groupDiscountMicros: 0n,
        },
        venueExpenseMicros: 0n,
        promoterExpenseCapMicros: 0n,
      },
      NOW,
    );
    if (!applied.ok) throw new Error(applied.message);
    expect(applied.guarantee?.winner).toBe("percentage");
    expect(applied.guarantee?.percentageLegCents).toBe(85_000_000);
    expect(applied.sheet.dealPayoutCents).toBe(85_000_000);
    expect(applied.accrual?.allocations).toEqual([
      { payee_id: "artist-001", payee_name: "The Comedian", role: "artist", share_cents: 85_000_000 },
    ]);
  });

  it("pays the flat guarantee when the net is weak — and the basis is net of Grand Rights and venue recoupment", async () => {
    const store = new InMemoryStore();
    await registerTheatricalProductionDeal(
      store,
      comedyDeal({
        grandRightsRateBps: 600, // 6%
        publisherCode: "rodgers_hammerstein",
        publisherPayeeId: "pub-002",
        publisherPayeeName: "Rodgers & Hammerstein",
      }),
      NOW,
    );
    const applied = await applyTheatricalStopOutcome(
      store,
      {
        productionId: PRODUCTION,
        venueId: "v",
        showDate: "2026-10-02",
        sourceEventId: "theatrical:axs:c-2",
        settlementId: "s2",
        senderCode: "axs",
        city: "Chicago",
        currency: "USD",
        legs: {
          gborMicros: 100_000n * 100_000_000n, // $100,000.00 AGBOR
          salesTaxMicros: 0n,
          cardProcessingMicros: 0n,
          facilityMaintenanceMicros: 0n,
          ffeMicros: 0n,
          groupDiscountMicros: 0n,
        },
        venueExpenseMicros: 5_000n * 100_000_000n, // $5,000.00 (under cap)
        promoterExpenseCapMicros: 1_000_000_000_000n, // $10,000.00 cap
      },
      NOW,
    );
    if (!applied.ok) throw new Error(applied.message);
    // Basis: $100,000 − 6% GR ($6,000) − $5,000 venue recoupment = $89,000;
    // 85% of that = $75,650 — above the $10,000 flat leg, so 85% wins.
    expect(applied.guarantee?.winner).toBe("percentage");
    expect(applied.guarantee?.percentageLegCents).toBe(7_565_000);
    // Now the flat-wins direction: a weak stop nets $500 after recoupment.
    const weak = await applyTheatricalStopOutcome(
      store,
      {
        productionId: PRODUCTION,
        venueId: "v",
        showDate: "2026-10-03",
        sourceEventId: "theatrical:axs:c-3",
        settlementId: "s3",
        senderCode: "axs",
        city: "Milwaukee",
        currency: "USD",
        legs: {
          gborMicros: 10_000n * 100_000_000n, // $10,000.00
          salesTaxMicros: 0n,
          cardProcessingMicros: 0n,
          facilityMaintenanceMicros: 0n,
          ffeMicros: 0n,
          groupDiscountMicros: 0n,
        },
        venueExpenseMicros: 9_400n * 100_000_000n, // $9,400.00
        promoterExpenseCapMicros: 1_000_000_000_000n, // $10,000.00 cap
      },
      NOW,
    );
    if (!weak.ok) throw new Error(weak.message);
    // Basis: $10,000 − $600 GR − $9,400 venue = $0 net; 85% = $0. The flat
    // $10,000 guarantee is the floor obligation — it pays.
    expect(weak.guarantee?.winner).toBe("flat");
    expect(weak.guarantee?.percentageLegCents).toBe(0);
    expect(weak.sheet.dealPayoutCents).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// Replay idempotency — a re-shipped report is counted no-ops.
// ---------------------------------------------------------------------------

describe("replay idempotency", () => {
  it("applies a stop's money exactly once per source event id", async () => {
    const store = new InMemoryStore();
    await registerTheatricalProductionDeal(store, theatricalDeal(), NOW);
    const stopInput = {
      productionId: PRODUCTION,
      venueId: "v",
      showDate: "2026-10-02",
      sourceEventId: "theatrical:axs:replay",
      settlementId: "s1",
      senderCode: "axs" as const,
      city: "Chicago",
      currency: "USD",
      legs: {
        gborMicros: 100_000n * 100_000_000n,
        salesTaxMicros: 0n,
        cardProcessingMicros: 0n,
        facilityMaintenanceMicros: 0n,
        ffeMicros: 0n,
        groupDiscountMicros: 0n,
      },
      venueExpenseMicros: 0n,
      promoterExpenseCapMicros: 0n,
    };
    const first = await applyTheatricalStopOutcome(store, stopInput, NOW);
    if (!first.ok) throw new Error(first.message);
    expect(first.alreadyRecorded).toBe(false);
    const replay = await applyTheatricalStopOutcome(store, stopInput, NOW);
    if (!replay.ok) throw new Error(replay.message);
    expect(replay.alreadyRecorded).toBe(true);
    // The position moved once: the $100,000 net applied exactly once.
    const deal = await store.getTheatricalProductionDeal(PRODUCTION);
    expect(deal?.recouped_cents).toBe(10_000_000);
    expect(deal?.recouped_cents).not.toBe(20_000_000);
  });

  it("runs the whole pass idempotently — quarantined dispositions never reach the waterfall", async () => {
    const store = new InMemoryStore();
    await registerTheatricalProductionDeal(store, theatricalDeal(), NOW);
    const detail = stopDetail({
      gborMicros: "10000000000000", // $100,000.00 in micros (string — the lane detail)
    });
    const moneyOutcome = outcome(detail, "theatrical:axs:pass-1");
    const heldOutcome = outcome(stopDetail({ settlementId: "stl-held" }), "theatrical:axs:pass-2", {
      disposition: "held_negative_net" as const,
    });
    const zeroOutcome = outcome(stopDetail({ settlementId: "stl-zero" }), "theatrical:axs:pass-3", {
      disposition: "zero_net" as const,
    });
    const first = await runTheatricalWaterfallPass(
      store,
      [moneyOutcome, heldOutcome, zeroOutcome],
      NOW,
    );
    expect(first.applied).toBe(1);
    expect(first.alreadyRecorded).toBe(0);
    expect(first.dealPayoutCents).toBe(10_000_000); // $100,000 net to investors
    expect(first.grandRightsCents).toBe(0);
    // The re-shipped report: same event ids — the counted no-ops.
    const replay = await runTheatricalWaterfallPass(
      store,
      [moneyOutcome, heldOutcome, zeroOutcome],
      NOW,
    );
    expect(replay.applied).toBe(0);
    expect(replay.alreadyRecorded).toBe(1);
    // The quarantined rows stayed quarantined, and the position never moved.
    const deal = await store.getTheatricalProductionDeal(PRODUCTION);
    expect(deal?.recouped_cents).toBe(10_000_000);
  });
});
