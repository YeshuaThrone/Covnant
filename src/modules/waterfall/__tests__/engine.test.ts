// The film waterfall engine (PR 8) — the pure router's battery.
//
// Locked invariants under test, per the founder film directive: funds route
// STRICTLY in tier order, never proportional; the distribution commission is
// a bps rate of every receipt (optionally capped); P&A, CAMA, guild, and
// deferral obligations recoup their fixed lifetime balances sequentially;
// senior debt repays principal plus interest and equity repays principal
// plus the negotiated preferred return (the founder's example range:
// 115-120%); the tier-5 net profit pool receives whatever survives; First
// Dollar Gross participant points bypass the cascade off the top of the
// receipt when the deal's cumulative-gross trigger fires; unpaid balances
// are HONEST (obligation − paid − routed, carried by the caller's cumulative
// state into later periods); corrupt cumulative state (paid exceeding an
// obligation) throws, never clamps; integer cents and basis points
// throughout, every share a floor.
//
// Amount literals are integer cents with _ as a thousands separator
// (10_000 = $100.00), the repo-wide test convention.

import { describe, expect, it } from "vitest";
import {
  WATERFALL_TIER_LEVELS,
  cumulativePaidFromDistributions,
  routeWaterfallTransaction,
  validateFilmWaterfallDefinition,
  waterfallLegObligationCents,
} from "@/modules/waterfall/engine";
import type {
  FilmWaterfallDefinition,
  WaterfallLegRouting,
  WaterfallLegStructure,
  WaterfallRouting,
} from "@/modules/waterfall/engine";

// ---------------------------------------------------------------------------
// The canonical deal — one leg of each structure the cascade routes, at
// hand-checkable sizes.
// ---------------------------------------------------------------------------

const DIST_FEE = {
  leg_id: "dist-fee",
  label: "Distribution commission (20%)",
  payee_id: "payee-distributor",
  payee_name: "Distribution Co",
  structure: { type: "per_receipt_bps", bps: 2000, cap_cents: null },
} as const;

const PA_CAP = {
  leg_id: "pa-cap",
  label: "P&A marketing expense cap",
  payee_id: "payee-pa",
  payee_name: "P&A Lender",
  structure: { type: "fixed_obligation", obligation_cents: 50_000 },
} as const;

const SENIOR_DEBT = {
  leg_id: "senior-debt",
  label: "Senior debt + gap (10% interest)",
  payee_id: "payee-bank",
  payee_name: "Senior Lender",
  structure: { type: "debt_recoupment", principal_cents: 10_000, interest_bps: 1000 },
} as const;

const CAMA_FEES = {
  leg_id: "cama-fees",
  label: "CAMA collection account fees",
  payee_id: "payee-cama",
  payee_name: "CAMA Administrator",
  structure: { type: "fixed_obligation", obligation_cents: 5_000 },
} as const;

const GUILD_RESIDUALS = {
  leg_id: "guild-residuals",
  label: "Guild residual compliance holds",
  payee_id: "payee-guilds",
  payee_name: "SAG-AFTRA / DGA / WGA",
  structure: { type: "fixed_obligation", obligation_cents: 3_000 },
} as const;

const EQUITY = {
  leg_id: "equity",
  label: "Equity recoupment (115% preferred)",
  payee_id: "payee-equity",
  payee_name: "Equity Investors",
  structure: { type: "equity_recoupment", principal_cents: 20_000, preferred_return_bps: 1500 },
} as const;

const DEFERRALS = {
  leg_id: "deferrals",
  label: "Deferred compensation",
  payee_id: "payee-deferrals",
  payee_name: "Deferred Crew",
  structure: { type: "fixed_obligation", obligation_cents: 4_000 },
} as const;

const PROFIT_POOL = {
  leg_id: "profit-pool",
  label: "Net profit pool",
  payee_id: "payee-pool",
  payee_name: "Producer / Investor pools",
  structure: { type: "profit_pool" },
} as const;

function makeDefinition(overrides?: Partial<FilmWaterfallDefinition>): FilmWaterfallDefinition {
  return {
    film_id: "film-77",
    label: "Standard film deal",
    tiers: [
      { tier_level: 0, label: "Off-the-top fees", legs: [{ ...DIST_FEE }, { ...PA_CAP }] },
      { tier_level: 1, label: "Senior debt & gap", legs: [{ ...SENIOR_DEBT }] },
      { tier_level: 2, label: "CAMA & guilds", legs: [{ ...CAMA_FEES }, { ...GUILD_RESIDUALS }] },
      { tier_level: 3, label: "Equity recoupment", legs: [{ ...EQUITY }] },
      { tier_level: 4, label: "Deferrals", legs: [{ ...DEFERRALS }] },
      { tier_level: 5, label: "Net profit pool", legs: [{ ...PROFIT_POOL }] },
    ],
    fdg: {
      participants: [
        {
          payee_id: "payee-actor",
          payee_name: "Lead Actor",
          role: "creator",
          share_bps: 500,
        },
      ],
      threshold_cents: null,
    },
    ...overrides,
  };
}

function leg(routing: WaterfallRouting, legId: string): WaterfallLegRouting {
  const found = routing.legs.find((candidate) => candidate.leg_id === legId);
  if (found === undefined) {
    throw new Error(`routing has no leg "${legId}"`);
  }
  return found;
}

/** The applied-distribution row shape the cumulative fold consumes. */
function appliedRow(routing: WaterfallRouting): {
  status: string;
  legs: WaterfallLegRouting[];
} {
  return { status: "applied", legs: routing.legs };
}

// ---------------------------------------------------------------------------
// Sequential recoupment fixtures — every number hand-derived.
// ---------------------------------------------------------------------------

describe("routeWaterfallTransaction — sequential recoupment", () => {
  it("routes the first $100 receipt strictly in tier order and reports honest exhaustion", () => {
    // $100.00 receipt. FDG fires first-dollar (threshold null): 5% bypass =
    // $5.00 (500¢). The $95.00 residue: tier 0 takes the 20% commission
    // ($20.00 — a rate of the RECEIPT) and $75.00 of the $500.00 P&A cap;
    // the money runs out before tier 1 sees a cent.
    const routing = routeWaterfallTransaction(makeDefinition(), 10_000, 10_000, {});

    expect(routing.fdg_triggered).toBe(true);
    expect(routing.fdg_bypass_cents).toBe(500);
    expect(routing.fdg_participants).toEqual([
      {
        payee_id: "payee-actor",
        payee_name: "Lead Actor",
        role: "creator",
        share_bps: 500,
        amount_cents: 500,
      },
    ]);

    // The commission measures the RECEIPT (20% of $100.00), not the post-FDG
    // residue, and an uncapped bps leg carries no lifetime balance.
    expect(leg(routing, "dist-fee")).toEqual({
      tier_level: 0,
      leg_id: "dist-fee",
      label: "Distribution commission (20%)",
      payee_id: "payee-distributor",
      demand_cents: 2_000,
      routed_cents: 2_000,
      unpaid_cents: 0,
      cumulative_paid_cents: 0,
    });

    // The P&A cap demands its full $500.00 but the residue after the
    // commission is $75.00 — it takes the money and reports the honest carry.
    expect(leg(routing, "pa-cap")).toMatchObject({
      demand_cents: 50_000,
      routed_cents: 7_500,
      cumulative_paid_cents: 7_500,
      unpaid_cents: 42_500,
    });

    // Downstream tiers saw zero money — demand reported, nothing routed.
    expect(leg(routing, "senior-debt").routed_cents).toBe(0);
    expect(leg(routing, "senior-debt").demand_cents).toBe(11_000);
    expect(leg(routing, "cama-fees").routed_cents).toBe(0);
    expect(leg(routing, "guild-residuals").routed_cents).toBe(0);
    expect(leg(routing, "equity").routed_cents).toBe(0);
    expect(leg(routing, "deferrals").routed_cents).toBe(0);
    expect(leg(routing, "profit-pool").routed_cents).toBe(0);

    // Exactly one tier saw money; the totals conserve every cent.
    expect(routing.tier_allocations).toEqual([{ tier_level: 0, amount_cents: 9_500 }]);
    expect(routing.profit_pool_cents).toBe(0);
    expect(routing.dust_cents).toBe(0);
    expect(routing.unpaid_total_cents).toBe(
      42_500 + 11_000 + 5_000 + 3_000 + 23_000 + 4_000,
    );
    expect(routing.exhausted).toBe(true);
  });

  it("carries shortfall into the next period through the caller's cumulative state", () => {
    // Period 1: the same $100.00 receipt routed above.
    const first = routeWaterfallTransaction(makeDefinition(), 10_000, 10_000, {});
    // Period 2: another $100.00; the P&A cap resumes from its $75.00 paid.
    const paid = cumulativePaidFromDistributions([appliedRow(first)]);
    const second = routeWaterfallTransaction(makeDefinition(), 10_000, 20_000, paid);

    expect(leg(second, "pa-cap")).toMatchObject({
      demand_cents: 42_500,
      routed_cents: 7_500,
      cumulative_paid_cents: 15_000,
      unpaid_cents: 35_000,
    });
    expect(second.tier_allocations).toEqual([{ tier_level: 0, amount_cents: 9_500 }]);
    expect(second.unpaid_total_cents).toBe(35_000 + 11_000 + 5_000 + 3_000 + 23_000 + 4_000);

    // Period 3: the P&A cap resumes again — each period's residue pays
    // $75.00 against the $500.00 cap, so it is still recouping and tier 1
    // stays unopened.
    const paid2 = cumulativePaidFromDistributions([appliedRow(first), appliedRow(second)]);
    const third = routeWaterfallTransaction(makeDefinition(), 10_000, 30_000, paid2);

    expect(leg(third, "pa-cap")).toMatchObject({
      demand_cents: 35_000,
      routed_cents: 7_500,
      cumulative_paid_cents: 22_500,
      unpaid_cents: 27_500,
    });
    expect(leg(third, "senior-debt").routed_cents).toBe(0);
    expect(third.unpaid_total_cents).toBe(
      27_500 + 11_000 + 5_000 + 3_000 + 23_000 + 4_000,
    );
    expect(third.exhausted).toBe(true);
  });

  it("pays the profit pool only after every upstream obligation completes", () => {
    // All obligations fully paid by prior periods; the residue flows through
    // the commission to tier 5.
    const paid = {
      "pa-cap": 50_000,
      "senior-debt": 11_000,
      "cama-fees": 5_000,
      "guild-residuals": 3_000,
      equity: 23_000,
      deferrals: 4_000,
    };
    const routing = routeWaterfallTransaction(makeDefinition(), 10_000, 1_000_000, paid);

    expect(leg(routing, "pa-cap").demand_cents).toBe(0);
    expect(leg(routing, "senior-debt").demand_cents).toBe(0);
    expect(leg(routing, "equity").demand_cents).toBe(0);

    // Tier 0 keeps the commission ($20.00); the surviving $75.00 reaches the
    // pool.
    expect(routing.tier_allocations).toEqual([
      { tier_level: 0, amount_cents: 2_000 },
      { tier_level: 5, amount_cents: 7_500 },
    ]);
    expect(routing.profit_pool_cents).toBe(7_500);
    expect(leg(routing, "profit-pool").routed_cents).toBe(7_500);
    expect(routing.unpaid_total_cents).toBe(0);
    expect(routing.exhausted).toBe(false);
    expect(routing.dust_cents).toBe(0);
  });
});

describe("routeWaterfallTransaction — recoupment multipliers", () => {
  it("computes debt obligations as principal plus floor(principal × interest bps)", () => {
    expect(
      waterfallLegObligationCents({
        type: "debt_recoupment",
        principal_cents: 10_000,
        interest_bps: 1000,
      }),
    ).toBe(11_000);
    // Interest floors: 1 bps of $333.33 principal is 3 cents (never rounds
    // up) — the obligation is principal + 3.
    expect(
      waterfallLegObligationCents({
        type: "debt_recoupment",
        principal_cents: 33_333,
        interest_bps: 1,
      }),
    ).toBe(33_336);
  });

  it("computes equity obligations as principal plus floor(principal × preferred return bps)", () => {
    // 115% — the founder's example range.
    expect(
      waterfallLegObligationCents({
        type: "equity_recoupment",
        principal_cents: 20_000,
        preferred_return_bps: 1500,
      }),
    ).toBe(23_000);
    // 120%.
    expect(
      waterfallLegObligationCents({
        type: "equity_recoupment",
        principal_cents: 20_000,
        preferred_return_bps: 2000,
      }),
    ).toBe(24_000);
    // 0 bps = 100% principal recoupment.
    expect(
      waterfallLegObligationCents({
        type: "equity_recoupment",
        principal_cents: 20_000,
        preferred_return_bps: 0,
      }),
    ).toBe(20_000);
  });

  it("demands an equity leg's remaining preferred balance, not its principal", () => {
    // $100.00 of the $230.00 equity obligation paid in prior periods: the
    // demand is the remaining $130.00.
    const routing = routeWaterfallTransaction(
      makeDefinition(),
      50_000,
      50_000,
      {
        equity: 10_000,
        "pa-cap": 50_000,
        "senior-debt": 11_000,
        "cama-fees": 5_000,
        "guild-residuals": 3_000,
      },
    );
    expect(leg(routing, "equity")).toMatchObject({
      demand_cents: 13_000,
      routed_cents: 13_000,
      cumulative_paid_cents: 23_000,
      unpaid_cents: 0,
    });
  });

  it("reports null obligations for flow-through and pool legs", () => {
    expect(
      waterfallLegObligationCents({ type: "per_receipt_bps", bps: 2000, cap_cents: null }),
    ).toBeNull();
    expect(waterfallLegObligationCents({ type: "profit_pool" })).toBeNull();
  });
});

describe("routeWaterfallTransaction — capped commissions", () => {
  it("stops the commission at its cumulative lifetime cap and carries no unpaid balance", () => {
    const definition = makeDefinition({
      tiers: [
        {
          tier_level: 0,
          label: "Off-the-top fees",
          legs: [{ ...DIST_FEE, structure: { type: "per_receipt_bps", bps: 2000, cap_cents: 4_500 } }],
        },
        { tier_level: 1, label: "Senior debt & gap", legs: [{ ...SENIOR_DEBT }] },
        { tier_level: 2, label: "CAMA & guilds", legs: [{ ...CAMA_FEES }, { ...GUILD_RESIDUALS }] },
        { tier_level: 3, label: "Equity recoupment", legs: [{ ...EQUITY }] },
        { tier_level: 4, label: "Deferrals", legs: [{ ...DEFERRALS }] },
        { tier_level: 5, label: "Net profit pool", legs: [{ ...PROFIT_POOL }] },
      ],
    });

    // Three $100.00 receipts: 20% each until the $45.00 cap binds.
    const first = routeWaterfallTransaction(definition, 10_000, 10_000, {});
    expect(leg(first, "dist-fee")).toMatchObject({
      demand_cents: 2_000,
      routed_cents: 2_000,
      cumulative_paid_cents: 2_000,
    });

    const paidAfterFirst = cumulativePaidFromDistributions([appliedRow(first)]);
    const second = routeWaterfallTransaction(definition, 10_000, 20_000, paidAfterFirst);
    expect(leg(second, "dist-fee")).toMatchObject({
      routed_cents: 2_000,
      cumulative_paid_cents: 4_000,
    });

    const paidAfterSecond = cumulativePaidFromDistributions([
      appliedRow(first),
      appliedRow(second),
    ]);
    const third = routeWaterfallTransaction(definition, 10_000, 30_000, paidAfterSecond);
    // $5.00 of cap room left — the demand shrinks to the cap, not the 20%
    // share.
    expect(leg(third, "dist-fee")).toMatchObject({
      demand_cents: 500,
      routed_cents: 500,
      cumulative_paid_cents: 4_500,
      unpaid_cents: 0,
    });

    // The cap is spent: a fourth receipt demands nothing from the leg.
    const paidAfterThird = cumulativePaidFromDistributions([
      appliedRow(first),
      appliedRow(second),
      appliedRow(third),
    ]);
    const fourth = routeWaterfallTransaction(definition, 10_000, 40_000, paidAfterThird);
    expect(leg(fourth, "dist-fee")).toMatchObject({
      demand_cents: 0,
      routed_cents: 0,
      cumulative_paid_cents: 4_500,
      unpaid_cents: 0,
    });
  });
});

describe("routeWaterfallTransaction — First Dollar Gross bypass", () => {
  it("holds the bypass until the cumulative gross crosses the threshold", () => {
    const definition = makeDefinition({
      fdg: {
        participants: [
          { payee_id: "payee-actor", payee_name: "Lead Actor", role: "creator", share_bps: 500 },
        ],
        threshold_cents: 100_000,
      },
    });

    // One cent short of the trigger: no bypass, the full receipt cascades.
    const before = routeWaterfallTransaction(definition, 10_000, 99_999, {});
    expect(before.fdg_triggered).toBe(false);
    expect(before.fdg_bypass_cents).toBe(0);
    expect(before.fdg_participants.map((participant) => participant.amount_cents)).toEqual([0]);
    expect(before.tier_allocations).toEqual([{ tier_level: 0, amount_cents: 10_000 }]);

    // Exactly at the threshold: the trigger fires (>=).
    const at = routeWaterfallTransaction(definition, 10_000, 100_000, {});
    expect(at.fdg_triggered).toBe(true);
    expect(at.fdg_bypass_cents).toBe(500);
  });

  it("defines no FDG routing when the deal carries no gross points", () => {
    const routing = routeWaterfallTransaction(makeDefinition({ fdg: null }), 10_000, 10_000, {});
    expect(routing.fdg_triggered).toBe(false);
    expect(routing.fdg_participants).toEqual([]);
    expect(routing.fdg_bypass_cents).toBe(0);
    // Nothing bypassed — the full receipt cascades.
    expect(routing.tier_allocations).toEqual([{ tier_level: 0, amount_cents: 10_000 }]);
  });

  it("splits the bypass across participants by floored share", () => {
    const definition = makeDefinition({
      fdg: {
        participants: [
          { payee_id: "payee-actor", payee_name: "Lead Actor", role: "creator", share_bps: 3300 },
          { payee_id: "payee-director", payee_name: "Director", role: "creator", share_bps: 1700 },
        ],
        threshold_cents: null,
      },
    });
    // A $9.99 receipt: floors are $3.29 and $1.69 (33% and 17%).
    const routing = routeWaterfallTransaction(definition, 999, 999, {});
    expect(routing.fdg_participants.map((participant) => participant.amount_cents)).toEqual([
      329,
      169,
    ]);
    expect(routing.fdg_bypass_cents).toBe(498);
  });
});

describe("routeWaterfallTransaction — impossible inputs refuse", () => {
  it("refuses non-integer and negative amounts", () => {
    expect(() => routeWaterfallTransaction(makeDefinition(), -1, 0, {})).toThrow(RangeError);
    expect(() => routeWaterfallTransaction(makeDefinition(), 100.5, 0, {})).toThrow(RangeError);
  });

  it("refuses a negative or fractional cumulative gross", () => {
    expect(() => routeWaterfallTransaction(makeDefinition(), 100, -1, {})).toThrow(RangeError);
    expect(() => routeWaterfallTransaction(makeDefinition(), 100, 99.9, {})).toThrow(RangeError);
  });

  it("refuses a negative paid entry", () => {
    expect(() =>
      routeWaterfallTransaction(makeDefinition(), 100, 0, { "pa-cap": -5 }),
    ).toThrow(RangeError);
  });

  it("refuses corrupt cumulative state — paid exceeding an obligation — and never clamps", () => {
    // The P&A cap's obligation is $500.00; $500.01 paid is impossible while
    // definitions lock once distributed.
    expect(() =>
      routeWaterfallTransaction(makeDefinition(), 10_000, 0, { "pa-cap": 50_001 }),
    ).toThrow(/exceeds its obligation/);
  });
});

// ---------------------------------------------------------------------------
// cumulativePaidFromDistributions — the applied-rows-only fold.
// ---------------------------------------------------------------------------

describe("cumulativePaidFromDistributions", () => {
  const legRow = (legId: string, routedCents: number): WaterfallLegRouting => ({
    tier_level: 0,
    leg_id: legId,
    label: legId,
    payee_id: `payee-${legId}`,
    demand_cents: routedCents,
    routed_cents: routedCents,
    unpaid_cents: 0,
    cumulative_paid_cents: routedCents,
  });

  it("folds only applied rows and sums per leg", () => {
    const paid = cumulativePaidFromDistributions([
      { status: "applied", legs: [legRow("pa-cap", 7_500), legRow("senior-debt", 11_000)] },
      { status: "routed", legs: [legRow("pa-cap", 99_900)] },
      { status: "applied", legs: [legRow("pa-cap", 2_500)] },
    ]);
    // The routed (never-executed) row is invisible to the carry.
    expect(paid).toEqual({ "pa-cap": 10_000, "senior-debt": 11_000 });
  });

  it("returns an empty state with no history", () => {
    expect(cumulativePaidFromDistributions([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Registration validation — the gate the store writes through.
// ---------------------------------------------------------------------------

describe("validateFilmWaterfallDefinition", () => {
  it("accepts the canonical deal", () => {
    const result = validateFilmWaterfallDefinition(makeDefinition());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.film_id).toBe("film-77");
      expect(result.definition.tiers.map((tier) => tier.tier_level)).toEqual(
        WATERFALL_TIER_LEVELS,
      );
      expect(result.definition.fdg?.participants).toHaveLength(1);
    }
  });

  it.each([
    [null, "invalid_definition"],
    [42, "invalid_definition"],
    [{ ...makeDefinition(), film_id: "" }, "invalid_film_id"],
    [{ ...makeDefinition(), label: "" }, "invalid_label"],
    [{ ...makeDefinition(), tiers: [] }, "invalid_tiers"],
    [
      {
        ...makeDefinition(),
        tiers: makeDefinition().tiers.slice(0, 5),
      },
      "invalid_tiers",
    ],
    [
      {
        ...makeDefinition(),
        tiers: makeDefinition().tiers.map((tier, index) => ({
          ...tier,
          tier_level: index === 0 ? 6 : tier.tier_level,
        })),
      },
      "invalid_tier_level",
    ],
    [
      {
        ...makeDefinition(),
        tiers: [
          makeDefinition().tiers[0]!,
          makeDefinition().tiers[1]!,
          makeDefinition().tiers[2]!,
          makeDefinition().tiers[3]!,
          makeDefinition().tiers[4]!,
          makeDefinition().tiers[0]!,
        ],
      },
      "duplicate_tier",
    ],
    [
      {
        ...makeDefinition(),
        // Two profit_pool legs — each is individually legal on tier 5, but
        // the pool is exactly ONE profit_pool leg.
        tiers: makeDefinition().tiers.map((tier) =>
          tier.tier_level === 5
            ? { ...tier, legs: [{ ...PROFIT_POOL }, { ...PROFIT_POOL }] }
            : tier,
        ),
      },
      "invalid_profit_pool",
    ],
    [
      {
        ...makeDefinition(),
        // An empty tier 5 is no pool at all.
        tiers: makeDefinition().tiers.map((tier) =>
          tier.tier_level === 5 ? { ...tier, legs: [] } : tier,
        ),
      },
      "invalid_profit_pool",
    ],
    [
      {
        ...makeDefinition(),
        tiers: makeDefinition().tiers.map((tier) =>
          tier.tier_level === 1 ? { ...tier, legs: [{ ...CAMA_FEES }] } : tier,
        ),
      },
      "duplicate_leg_id",
    ],
    [
      {
        ...makeDefinition(),
        tiers: makeDefinition().tiers.map((tier) =>
          tier.tier_level === 2
            ? { ...tier, legs: [{ ...DIST_FEE }] }
            : tier,
        ),
      },
      "invalid_leg_structure",
    ],
    [
      {
        ...makeDefinition(),
        tiers: makeDefinition().tiers.map((tier) =>
          tier.tier_level === 5
            ? { ...tier, legs: [{ ...DIST_FEE, structure: { type: "fixed_obligation", obligation_cents: 1 } }] }
            : tier,
        ),
      },
      // A fixed obligation on tier 5 fails the placement rule before the
      // pool-shape check sees it.
      "invalid_leg_structure",
    ],
    [
      {
        ...makeDefinition(),
        fdg: {
          participants: [
            { payee_id: "p", payee_name: "P", role: "creator", share_bps: 500 },
            { payee_id: "q", payee_name: "Q", role: "creator", share_bps: 9600 },
          ],
          threshold_cents: null,
        },
      },
      "fdg_shares_exceed_gross",
    ],
    [
      {
        ...makeDefinition(),
        fdg: {
          participants: [
            { payee_id: "p", payee_name: "P", role: "creator", share_bps: 8500 },
          ],
          threshold_cents: null,
        },
      },
      // FDG 8500 + the 2000 bps commission promise more than 100% of a
      // receipt — the bypass contract refuses the registration.
      "bypass_exceeds_receipt",
    ],
    [
      {
        ...makeDefinition(),
        fdg: {
          participants: [
            { payee_id: "p", payee_name: "P", role: "creator", share_bps: 100 },
          ],
          threshold_cents: -5,
        },
      },
      "invalid_fdg_threshold",
    ],
    [
      {
        ...makeDefinition(),
        fdg: {
          participants: [
            { payee_id: "p", payee_name: "P", role: "creator", share_bps: 10001 },
          ],
          threshold_cents: null,
        },
      },
      "invalid_fdg",
    ],
  ] as Array<[unknown, string]>)("refuses %j with code %s", (input, code) => {
    const result = validateFilmWaterfallDefinition(input);
    expect(result).toMatchObject({ ok: false, code });
  });

  it("treats absent FDG terms as a no-gross-points deal", () => {
    const raw = makeDefinition();
    delete (raw as { fdg?: unknown }).fdg;
    const result = validateFilmWaterfallDefinition(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.fdg).toBeNull();
    }
  });

  it("round-trips every leg structure the cascade routes", () => {
    const structures: WaterfallLegStructure[] = [
      { type: "per_receipt_bps", bps: 2500, cap_cents: 10_000 },
      { type: "per_receipt_bps", bps: 2500, cap_cents: null },
      { type: "fixed_obligation", obligation_cents: 1 },
      { type: "debt_recoupment", principal_cents: 1, interest_bps: 0 },
      { type: "equity_recoupment", principal_cents: 1, preferred_return_bps: 10000 },
      { type: "profit_pool" },
    ];
    for (const structure of structures) {
      const definition = makeDefinition({
        tiers: [
          { tier_level: 0, label: "t0", legs: [{ ...DIST_FEE, structure }] },
          { tier_level: 1, label: "t1", legs: [{ ...SENIOR_DEBT }] },
          { tier_level: 2, label: "t2", legs: [{ ...CAMA_FEES }] },
          { tier_level: 3, label: "t3", legs: [{ ...EQUITY }] },
          { tier_level: 4, label: "t4", legs: [{ ...DEFERRALS }] },
          { tier_level: 5, label: "t5", legs: [{ ...PROFIT_POOL }] },
        ],
        fdg: null,
      });
      // Only structures legal at tier 0 validate; the tier-restricted ones
      // (debt/equity/pool) refuse with the placement error, which is itself
      // the round-trip proof the validator sees them.
      const result = validateFilmWaterfallDefinition(definition);
      if (structure.type === "per_receipt_bps" || structure.type === "fixed_obligation") {
        expect(result.ok).toBe(true);
      } else {
        expect(result).toMatchObject({ ok: false, code: "invalid_leg_structure" });
      }
    }
  });
});
