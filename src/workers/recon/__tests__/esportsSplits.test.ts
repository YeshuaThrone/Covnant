// CVT recon worker — the esports prize-pool waterfall's allocation math
// (PR 14). Pure-function pins: the founder's mandated step order, the
// mandated-only recoupment rule, the 15–30% org-cut band, roster shares
// summing to EXACTLY 10000 bps, integer-cent floors with the dust sweep,
// shortfall honesty, and conservation — every step's allocations plus dust
// equal the pool by construction, no cent invented, no cent lost.

import { describe, expect, it } from "vitest";
import {
  buildEsportsWaterfallPlan,
  isPlayingRole,
  type EsportsRosterMember,
  type EsportsWaterfallInput,
} from "../esportsSplits";
import { ESPORTS_ORG_CUT_MAX_BPS, ESPORTS_ORG_CUT_MIN_BPS } from "../livestream";

/** One starter carrying a given share — the roster's smallest member. */
function member(
  payeeId: string,
  shareBps: number,
  role: EsportsRosterMember["role"] = "starter",
): EsportsRosterMember {
  return { payeeId, payeeName: `Player ${payeeId}`, role, shareBps };
}

/** A valid five-slot roster: 2 starters, a sub, a coach, an analyst. */
function validRoster(): EsportsRosterMember[] {
  return [
    member("starter-1", 3000, "starter"),
    member("starter-2", 3000, "starter"),
    member("sub-1", 1000, "substitute"),
    member("coach-1", 2000, "coach"),
    member("analyst-1", 1000, "analyst"),
  ];
}

function validInput(
  overrides: Partial<EsportsWaterfallInput> = {},
): EsportsWaterfallInput {
  return {
    poolCents: 1_000_000,
    orgPayeeId: "org-1",
    orgPayeeName: "The Org",
    orgCutBps: 2000,
    venueExpenseCents: 0,
    travelExpenseCents: 0,
    venueMandated: false,
    travelMandated: false,
    roster: validRoster(),
    ...overrides,
  };
}

describe("buildEsportsWaterfallPlan — the mandated step order", () => {
  it("runs venue recoupment, then travel recoupment, then the org cut on what REMAINS, then the roster split", () => {
    // Pool 1,000,000; mandated venue 150,000; mandated travel 50,000;
    // org cut 20% of the 800,000 remainder = 160,000; roster pool 640,000.
    const result = buildEsportsWaterfallPlan(
      validInput({
        venueExpenseCents: 150_000,
        travelExpenseCents: 50_000,
        venueMandated: true,
        travelMandated: true,
        orgCutBps: 2000,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.venuePaidCents).toBe(150_000);
    expect(result.plan.travelPaidCents).toBe(50_000);
    expect(result.plan.orgPaidCents).toBe(160_000);
    expect(result.plan.rosterPoolCents).toBe(640_000);
    expect(result.plan.unrecoupedCents).toBe(0);
  });

  it("skips recoupment entirely when the contract does not mandate it — the expense exists, the pool is untouched", () => {
    const result = buildEsportsWaterfallPlan(
      validInput({ venueExpenseCents: 999_999, venueMandated: false }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.venuePaidCents).toBe(0);
    expect(result.plan.rosterPoolCents).toBe(800_000); // after the 20% org cut
  });

  it("caps recoupment at what the pool holds and reports the shortfall honestly — later steps receive what REMAINS", () => {
    // Pool 100,000; mandated venue 300,000 → recoups 100,000, shortfall 200,000;
    // org cut on 0 remaining = 0; roster pool 0.
    const result = buildEsportsWaterfallPlan(
      validInput({
        poolCents: 100_000,
        venueExpenseCents: 300_000,
        venueMandated: true,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.venuePaidCents).toBe(100_000);
    expect(result.plan.unrecoupedCents).toBe(200_000);
    expect(result.plan.orgPaidCents).toBe(0);
    expect(result.plan.rosterPoolCents).toBe(0);
    expect(result.plan.rosterAllocations.every((a) => a.amountCents === 0)).toBe(
      true,
    );
    expect(result.plan.companyDustCents).toBe(0);
  });
});

describe("buildEsportsWaterfallPlan — the org cut band", () => {
  it("accepts the band's exact endpoints (1500 and 3000 bps)", () => {
    expect(
      buildEsportsWaterfallPlan(validInput({ orgCutBps: ESPORTS_ORG_CUT_MIN_BPS })).ok,
    ).toBe(true);
    expect(
      buildEsportsWaterfallPlan(validInput({ orgCutBps: ESPORTS_ORG_CUT_MAX_BPS })).ok,
    ).toBe(true);
  });

  it("refuses below 1500 and above 3000 bps", () => {
    const low = buildEsportsWaterfallPlan(validInput({ orgCutBps: 1499 }));
    expect(low).toMatchObject({ ok: false, code: "invalid_org_cut_bps" });
    const high = buildEsportsWaterfallPlan(validInput({ orgCutBps: 3001 }));
    expect(high).toMatchObject({ ok: false, code: "invalid_org_cut_bps" });
  });

  it("floors the org cut's sub-cent residue into the roster pool (never a fractional cent)", () => {
    // Pool 1,001; 20% cut = 200.2 → floor 200; roster pool 801.
    const result = buildEsportsWaterfallPlan(
      validInput({ poolCents: 1_001, orgCutBps: 2000 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.orgPaidCents).toBe(200);
    expect(result.plan.rosterPoolCents).toBe(801);
  });
});

describe("buildEsportsWaterfallPlan — the roster split", () => {
  it("splits the roster pool at whole basis points and sweeps the floor dust to the company variance account", () => {
    // Roster pool 1,000,000 at the valid roster's shares:
    // 300000 + 300000 + 100000 + 200000 + 100000 = 1,000,000 — no dust.
    const result = buildEsportsWaterfallPlan(validInput({ poolCents: 1_250_000, orgCutBps: 2000 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Pool 1,250,000 → org 20% = 250,000 → roster pool 1,000,000.
    expect(result.plan.rosterAllocations.map((a) => a.amountCents)).toEqual([
      300_000, 300_000, 100_000, 200_000, 100_000,
    ]);
    expect(result.plan.companyDustCents).toBe(0);
  });

  it("conserves the roster pool exactly — shares + dust === pool, ALWAYS", () => {
    // A pool engineered so every share floors: 1001 cents, org 1500 bps
    // (150.15 → 150), roster pool 851: 851×3000/10000 = 255.3 → 255;
    // 851×1000/10000 = 85.1 → 85; 851×2000/10000 = 170.2 → 170.
    // Allocated 255+255+85+170+85 = 850, dust 1.
    const result = buildEsportsWaterfallPlan(
      validInput({ poolCents: 1001, orgCutBps: 1500 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const allocated = result.plan.rosterAllocations.reduce(
      (total, a) => total + a.amountCents,
      0,
    );
    expect(allocated).toBe(850);
    expect(result.plan.companyDustCents).toBe(1);
    expect(
      allocated +
        result.plan.companyDustCents +
        result.plan.orgPaidCents,
    ).toBe(1001);
  });

  it("refuses a roster whose shares do not sum to EXACTLY 10000 bps", () => {
    const over = buildEsportsWaterfallPlan(
      validInput({ roster: [...validRoster(), member("greedy-1", 1)] }),
    );
    expect(over).toMatchObject({ ok: false, code: "invalid_roster_share_sum" });
    const under = buildEsportsWaterfallPlan(
      validInput({
        roster: [
          member("starter-1", 2999, "starter"),
          member("starter-2", 3000, "starter"),
          member("sub-1", 1000, "substitute"),
          member("coach-1", 2000, "coach"),
          member("analyst-1", 1000, "analyst"),
        ],
      }),
    );
    expect(under).toMatchObject({ ok: false, code: "invalid_roster_share_sum" });
  });

  it("refuses duplicate roster payees and non-positive shares", () => {
    expect(
      buildEsportsWaterfallPlan(
        validInput({
          roster: [member("x", 5000), member("x", 5000)],
        }),
      ),
    ).toMatchObject({ ok: false, code: "invalid_roster_duplicate_payee" });
    expect(
      buildEsportsWaterfallPlan(
        validInput({
          roster: [member("x", 0)],
        }),
      ),
    ).toMatchObject({ ok: false, code: "invalid_roster_share" });
  });

  it("refuses an empty roster — a pool with no roster is unrouteable", () => {
    expect(
      buildEsportsWaterfallPlan(validInput({ roster: [] })),
    ).toMatchObject({ ok: false, code: "invalid_roster_empty" });
  });
});

describe("buildEsportsWaterfallPlan — the hostile-input refusals", () => {
  it("refuses non-positive, non-integer pools and bad org payees", () => {
    expect(
      buildEsportsWaterfallPlan(validInput({ poolCents: 0 })),
    ).toMatchObject({ ok: false, code: "invalid_prize_pool" });
    expect(
      buildEsportsWaterfallPlan(validInput({ poolCents: 100.5 })),
    ).toMatchObject({ ok: false, code: "invalid_prize_pool" });
    expect(
      buildEsportsWaterfallPlan(validInput({ orgPayeeId: "  " })),
    ).toMatchObject({ ok: false, code: "invalid_org_payee" });
  });
});

describe("isPlayingRole — withholding applies to playing talent only", () => {
  it("classifies starters and substitutes as playing roles", () => {
    expect(isPlayingRole("starter")).toBe(true);
    expect(isPlayingRole("substitute")).toBe(true);
  });

  it("classifies coaches and analysts as staff (no withholding at release)", () => {
    expect(isPlayingRole("coach")).toBe(false);
    expect(isPlayingRole("analyst")).toBe(false);
  });
});
