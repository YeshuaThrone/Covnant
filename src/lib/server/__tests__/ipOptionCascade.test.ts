// The IP option release PLAN (PR 21) — the pure author-first allocator's
// unit pins, mirroring the webtoon planner's test discipline. The planner is
// the arithmetic heart of the founder's inverted priority: ring-fenced
// author IP allocations FIRST (bps OF THE FEE), the agency commission
// SECOND (bps OF THE REMAINDER — never of the gross), the author of
// record's residual LAST — integer-exact, floored legs, conservation always.

import { describe, expect, it } from "vitest";
import { buildIpOptionReleasePlan } from "@/lib/server/ipOptionCascade";

const BASE = {
  option_fee_cents: 100_000,
  author_allocations: [
    { payee_id: "payee-nova", payee_name: "Nova (co-holder)", allocation_bps: 350 },
    { payee_id: "payee-rio", payee_name: "Rio (co-holder)", allocation_bps: 225 },
  ],
  agency: {
    payee_id: "payee-agency-lumen",
    payee_name: "Lumen Talent Agency",
    commission_bps: 1_000,
  },
  author: { payee_id: "payee-atlas-author", payee_name: "Atlas (author of record)" },
};

describe("buildIpOptionReleasePlan — the pure author-first allocator", () => {
  it("reserves the author IP allocations first, commissions the agency from the REMAINDER, and leaves the residual to the author of record", () => {
    const planned = buildIpOptionReleasePlan(BASE);
    if (!planned.ok) throw new Error(`unexpected refusal: ${planned.code}`);
    const plan = planned.value;

    // The allocations: bps OF THE FEE, in registration order, floored legs.
    // 350 bps of 100_000 = 3_500; 225 bps = 2_250.
    expect(plan.author_allocations.map((leg) => leg.amount_cents)).toEqual([3_500, 2_250]);
    expect(plan.author_allocated_total_cents).toBe(5_750);
    expect(plan.remainder_cents).toBe(94_250);

    // THE INVARIANT: 1_000 bps of the 94_250 REMAINDER = 9_425 — of the
    // 100_000 gross it would be 10_000. The remainder basis is the
    // founder's ordering, in arithmetic.
    expect(plan.agency_commission_cents).toBe(9_425);
    expect(plan.agency_commission_cents).not.toBe(10_000);
    expect(plan.author_residual).toEqual({
      payee_id: "payee-atlas-author",
      payee_name: "Atlas (author of record)",
      amount_cents: 84_825,
    });

    // Conservation: allocations + commission + residual === the fee, dust 0.
    expect(
      plan.author_allocated_total_cents +
        plan.agency_commission_cents +
        plan.author_residual.amount_cents +
        plan.company_dust_cents,
    ).toBe(100_000);
    expect(plan.company_dust_cents).toBe(0);
  });

  it("stays integer-exact on the 999-cent distinguisher — floored legs conserve every cent", () => {
    const planned = buildIpOptionReleasePlan({
      ...BASE,
      option_fee_cents: 999,
      author_allocations: [
        { payee_id: "payee-nova", payee_name: "Nova (co-holder)", allocation_bps: 3_333 },
      ],
    });
    if (!planned.ok) throw new Error(`unexpected refusal: ${planned.code}`);
    const plan = planned.value;

    // 999 × 3_333 bps → 332.9667… → 332 floored; remainder 667; 1_000 bps of
    // 667 → 66.7 → 66 floored (gross-based it would be 99); residual 601.
    expect(plan.author_allocations[0]!.amount_cents).toBe(332);
    expect(plan.remainder_cents).toBe(667);
    expect(plan.agency_commission_cents).toBe(66);
    expect(plan.author_residual.amount_cents).toBe(601);
    expect(
      332 + plan.agency_commission_cents + plan.author_residual.amount_cents,
    ).toBe(999);
    expect(plan.company_dust_cents).toBe(0);
  });

  it("pays the agency nothing when the allocations consume the whole fee", () => {
    const planned = buildIpOptionReleasePlan({
      ...BASE,
      author_allocations: [
        { payee_id: "payee-nova", payee_name: "Nova (co-holder)", allocation_bps: 10_000 },
      ],
    });
    if (!planned.ok) throw new Error(`unexpected refusal: ${planned.code}`);
    expect(planned.value.author_allocations[0]!.amount_cents).toBe(100_000);
    expect(planned.value.remainder_cents).toBe(0);
    expect(planned.value.agency_commission_cents).toBe(0);
    expect(planned.value.author_residual.amount_cents).toBe(0);
  });

  it("refuses allocations promising more than the fee carries (fail-closed)", () => {
    const planned = buildIpOptionReleasePlan({
      ...BASE,
      author_allocations: [
        { payee_id: "payee-nova", payee_name: "Nova (co-holder)", allocation_bps: 7_000 },
        { payee_id: "payee-rio", payee_name: "Rio (co-holder)", allocation_bps: 7_000 },
      ],
    });
    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.status).toBe(422);
      expect(planned.code).toBe("allocations_exceed_option_fee");
    }
  });

  it("refuses an agency-side allocation — the IP allocations are the AUTHOR's pool", () => {
    const planned = buildIpOptionReleasePlan({
      ...BASE,
      author_allocations: [
        {
          payee_id: "payee-agency-lumen",
          payee_name: "Lumen Talent Agency",
          allocation_bps: 1_000,
        },
      ],
    });
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.code).toBe("agency_cannot_hold_ip_allocation");
  });

  it("refuses a duplicate allocation payee — one reservation per (work, payee)", () => {
    const planned = buildIpOptionReleasePlan({
      ...BASE,
      author_allocations: [
        { payee_id: "payee-nova", payee_name: "Nova (co-holder)", allocation_bps: 1_000 },
        { payee_id: "payee-nova", payee_name: "Nova (co-holder)", allocation_bps: 1_500 },
      ],
    });
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.code).toBe("duplicate_allocation_payee");
  });

  it("refuses a malformed fee, identity, or commission out of band", () => {
    const zeroFee = buildIpOptionReleasePlan({ ...BASE, option_fee_cents: 0 });
    if (!zeroFee.ok) expect(zeroFee.code).toBe("invalid_option_fee");
    const fractionalFee = buildIpOptionReleasePlan({ ...BASE, option_fee_cents: 100.5 });
    if (!fractionalFee.ok) expect(fractionalFee.code).toBe("invalid_option_fee");
    const noAuthor = buildIpOptionReleasePlan({
      ...BASE,
      author: { payee_id: "  ", payee_name: "Atlas" },
    });
    if (!noAuthor.ok) expect(noAuthor.code).toBe("invalid_author_identity");
    const badCommission = buildIpOptionReleasePlan({
      ...BASE,
      agency: { ...BASE.agency, commission_bps: 10_001 },
    });
    if (!badCommission.ok) expect(badCommission.code).toBe("invalid_agency_commission_bps");
  });
});
