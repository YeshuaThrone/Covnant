// Focused tests for the brand-licensing royalty lane (PR 32, the founder
// Net Sales + tiered royalties + sub-license cascade directive): the Net
// Sales realization exact to the cent, the marginal tier walk's boundary
// cases at $1M and $5M with cumulative tracking across periods, the agency
// commission's ordering before the splits, the co-branded 50-50 dual-IP
// split with the odd-cent dust sweep, the treaty withholding by source
// territory (US-GB 0% vs US-JP 10% vs statutory default vs the fail-closed
// HOLD), and the sub-licensee gross rollup with the master override
// percentage behind its audit-gated release — on the strict profiles'
// checked-in fixtures and the in-memory store.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import {
  runLicensingRoyaltyCascadePass,
  releaseReconciledSubLicenseRoyalties,
} from "@/lib/server/licensingRoyaltyCascade";
import {
  MICROS_PER_DOLLAR,
  agencyCommissionCents,
  dualIpSplitCents,
  licensingRowEventId,
  masterOverrideRoyaltyCents,
  netLicensedSalesCents,
  tieredRoyaltyWalk,
  treatyWithholdingCents,
} from "../licensing";
import { writeLicensingLinesToMatchQueue } from "../licensingQueue";
import { postLicensingNetsToHolding } from "../licensingPosting";
import { isLicensingProfileKind } from "../licensingProfiles";
import { dispatchStatementProfile } from "../profiles";
import { StatementParseError } from "../records";
import { loadFixture } from "./fixtures";
import type { LicensingRoyaltyDealRecord } from "@/modules/licensing/records";

const USD = MICROS_PER_DOLLAR; // $1 = 1e8 statement micros
const NOW = new Date("2026-09-30T12:00:00Z");

/** The directive's example schedule: 8% to $1M, 10% $1M–$5M, 12% above. */
const DIRECTIVE_TIERS = [
  { upToCents: 100_000_000, rateBps: 800 },
  { upToCents: 500_000_000, rateBps: 1000 },
  { upToCents: null, rateBps: 1200 },
];

/** The apparel deal of record — single licensor, US residence, USD. */
function apparelDeal(
  overrides: Partial<LicensingRoyaltyDealRecord> = {},
): LicensingRoyaltyDealRecord {
  return {
    id: "deal-apparel-001",
    scope_key: "license:LIC-APPAREL-001",
    license_id: "LIC-APPAREL-001",
    currency: "USD",
    tiers: DIRECTIVE_TIERS,
    agency_commission_bps: 2000,
    licensor_a_payee_id: "payee-founder",
    licensor_a_payee_name: "Covnant Founder",
    licensor_a_country: "US",
    licensor_b_payee_id: null,
    licensor_b_payee_name: null,
    licensor_b_country: null,
    withholding_default_bps: null,
    cumulative_net_sales_cents: 0,
    cumulative_royalty_cents: 0,
    version: 1,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Parses one checked-in licensing fixture through the shared dispatcher. */
function parseFixture(fixture: string) {
  const content = loadFixture(fixture);
  const profile = dispatchStatementProfile(content);
  if (profile === null) throw new Error(`fixture ${fixture} failed to dispatch`);
  return { profile, lines: profile.parse(content) };
}

/** Parses + writes one fixture through the real lane writer. */
async function ingestFixture(store: InMemoryStore, fixture: string) {
  const { profile, lines } = parseFixture(fixture);
  const counts = await writeLicensingLinesToMatchQueue(store, `ingest-${fixture}`, lines);
  return { profile, counts };
}

/** Registers the EU-West sub-licensee of record for the toys master scope. */
function registerEuWest(store: InMemoryStore) {
  return store.upsertLicensingSubLicensee({
    scope_key: "license:LIC-TOYS-002",
    sub_licensee_id: "SUB-EU-WEST",
    region_code: "EU",
    master_override_bps: 2500, // the master royalty override of record
    payee_id: "payee-sub-eu",
    payee_name: "EU West Sub-Licensee",
  });
}

// ---------------------------------------------------------------------------
// The Net Sales realization — exact to the cent.
// ---------------------------------------------------------------------------

describe("the Net Sales realization", () => {
  it("computes gross minus the four approved deduction legs, exact to the cent", () => {
    // $250,000.00 gross; $12,500.00 trade discounts; $2,000.00 returned
    // goods; $3,250.00 shipping/freight; $0.00 VAT → $232,250.00 net.
    const result = netLicensedSalesCents({
      grossRevenueMicros: 250_000n * USD,
      tradeDiscountMicros: 12_500n * USD,
      returnedGoodsMicros: 2_000n * USD,
      shippingFreightMicros: 3_250n * USD,
      vatMicros: 0n,
    });
    expect(result.grossRevenueCents).toBe(25_000_000);
    expect(result.tradeDiscountCents).toBe(1_250_000);
    expect(result.returnedGoodsCents).toBe(200_000);
    expect(result.shippingFreightCents).toBe(325_000);
    expect(result.vatCents).toBe(0);
    expect(result.netSalesCents).toBe(23_225_000);
  });

  it("floors each deduction leg from its exact micros — a deduction never rounds up", () => {
    // $1,000.00 gross; $0.999999 in each deduction leg (99,999,900 micros
    // floors to 99 cents). The net is $1000.00 − 4×99 cents, never the
    // float's $996.00 and never an over-deducted cent.
    const result = netLicensedSalesCents({
      grossRevenueMicros: 1_000n * USD,
      tradeDiscountMicros: 99_999_900n,
      returnedGoodsMicros: 99_999_900n,
      shippingFreightMicros: 99_999_900n,
      vatMicros: 99_999_900n,
    });
    expect(result.tradeDiscountCents).toBe(99);
    expect(result.returnedGoodsCents).toBe(99);
    expect(result.shippingFreightCents).toBe(99);
    expect(result.vatCents).toBe(99);
    expect(result.netSalesCents).toBe(100_000 - 396);
  });

  it("reports a negative net when the deduction legs outrun the gross (the caller quarantines)", () => {
    const result = netLicensedSalesCents({
      grossRevenueMicros: 100n * USD,
      tradeDiscountMicros: 150n * USD,
      returnedGoodsMicros: 0n,
      shippingFreightMicros: 0n,
      vatMicros: 0n,
    });
    expect(result.netSalesCents).toBe(-5_000);
  });
});

// ---------------------------------------------------------------------------
// The tiered royalty walk — boundary cases at $1M and $5M, cumulative.
// ---------------------------------------------------------------------------

describe("the tiered royalty walk", () => {
  it("walks $999,999.99 entirely inside tier 1 at 8% — floored to the cent", () => {
    const walk = tieredRoyaltyWalk(99_999_999, 0, DIRECTIVE_TIERS);
    expect(walk.slices).toEqual([
      { tierIndex: 0, rateBps: 800, sliceCents: 99_999_999, royaltyCents: 7_999_999 },
    ]);
    expect(walk.royaltyCents).toBe(7_999_999);
    expect(walk.cumulativeAfterCents).toBe(99_999_999);
  });

  it("splits the boundary cent: $0.01 arriving at cumulative $999,999.99 earns 8% of a cent — floored to zero", () => {
    // The directive's example: the first cent below the bound earns 8%
    // (0.8 cents, floored); the position still advances across $1M.
    const walk = tieredRoyaltyWalk(1, 99_999_999, DIRECTIVE_TIERS);
    expect(walk.slices).toEqual([
      { tierIndex: 0, rateBps: 800, sliceCents: 1, royaltyCents: 0 },
    ]);
    expect(walk.royaltyCents).toBe(0);
    expect(walk.cumulativeAfterCents).toBe(100_000_000);
  });

  it("walks exactly $1,000,000.00 entirely inside tier 1 at 8% — $80,000.00 royalty", () => {
    const walk = tieredRoyaltyWalk(100_000_000, 0, DIRECTIVE_TIERS);
    expect(walk.royaltyCents).toBe(8_000_000);
    expect(walk.cumulativeAfterCents).toBe(100_000_000);
  });

  it("walks $1.00 arriving AT the $1M position entirely inside tier 2 at 10%", () => {
    const walk = tieredRoyaltyWalk(100, 100_000_000, DIRECTIVE_TIERS);
    expect(walk.slices).toEqual([
      { tierIndex: 1, rateBps: 1000, sliceCents: 100, royaltyCents: 10 },
    ]);
    expect(walk.royaltyCents).toBe(10);
  });

  it("walks $1.00 completing the $5M boundary, then $0.01 above it at 12%", () => {
    // $1.00 ending exactly at $5M — all tier 2 (10%).
    const toFiveM = tieredRoyaltyWalk(100, 499_999_900, DIRECTIVE_TIERS);
    expect(toFiveM.slices).toEqual([
      { tierIndex: 1, rateBps: 1000, sliceCents: 100, royaltyCents: 10 },
    ]);
    expect(toFiveM.cumulativeAfterCents).toBe(500_000_000);
    // The next cent walks tier 3 (12%) — floored to zero for a single cent.
    const aboveFiveM = tieredRoyaltyWalk(1, 500_000_000, DIRECTIVE_TIERS);
    expect(aboveFiveM.slices).toEqual([
      { tierIndex: 2, rateBps: 1200, sliceCents: 1, royaltyCents: 0 },
    ]);
    expect(aboveFiveM.royaltyCents).toBe(0);
  });

  it("walks one event across two tiers in marginal slices", () => {
    // $1,000.00 arriving at cumulative $999,999.00: the first $1.00
    // finishes tier 1 (8%), the remaining $999.00 walks tier 2 (10%).
    const walk = tieredRoyaltyWalk(100_000, 99_999_900, DIRECTIVE_TIERS);
    expect(walk.slices).toEqual([
      { tierIndex: 0, rateBps: 800, sliceCents: 100, royaltyCents: 8 },
      { tierIndex: 1, rateBps: 1000, sliceCents: 99_900, royaltyCents: 9_990 },
    ]);
    expect(walk.royaltyCents).toBe(9_998);
    expect(walk.cumulativeAfterCents).toBe(100_099_900);
  });

  it("refuses an invalid schedule before any money walks it", () => {
    expect(() => tieredRoyaltyWalk(100, 0, [])).toThrow("licensing_walk_schedule_empty");
    expect(() =>
      tieredRoyaltyWalk(100, 0, [
        { upToCents: null, rateBps: 800 },
        { upToCents: 200, rateBps: 1000 },
      ]),
    ).toThrow("licensing_walk_unbounded_not_final");
    expect(() =>
      tieredRoyaltyWalk(100, 0, [
        { upToCents: 200, rateBps: 800 },
        { upToCents: 100, rateBps: 1000 },
      ]),
    ).toThrow("licensing_walk_bound_invalid");
    expect(() =>
      tieredRoyaltyWalk(100, 0, [{ upToCents: null, rateBps: 12_000 }]),
    ).toThrow("licensing_walk_rate_invalid");
  });
});

// ---------------------------------------------------------------------------
// Agency commission ordering, the dual-IP split, withholding, the override.
// ---------------------------------------------------------------------------

describe("the agency commission", () => {
  it("prices the founder band's share of the GROSS royalty — floored", async () => {
    const { validateAgencyCommissionBps } = await import("@/modules/licensing/records");
    expect(agencyCommissionCents(1_858_000, 2000)).toBe(371_600); // 20% exactly
    expect(agencyCommissionCents(6_258, 2000)).toBe(1_251); // 1,251.6 floors
    expect(agencyCommissionCents(2_392, 2000)).toBe(478); // 478.4 floors
    expect(agencyCommissionCents(0, 3500)).toBe(0);
    // The founder band: 1500–3500 bps of earned gross royalties.
    expect(validateAgencyCommissionBps(1400)).not.toBeNull();
    expect(validateAgencyCommissionBps(1500)).toBeNull();
    expect(validateAgencyCommissionBps(3500)).toBeNull();
    expect(validateAgencyCommissionBps(3600)).not.toBeNull();
  });
});

describe("the co-branded dual-IP split", () => {
  it("divides the post-agency remainder equally — floor/floor with the odd cent swept to dust", () => {
    expect(dualIpSplitCents(1_486_400)).toEqual({
      licensorACents: 743_200,
      licensorBCents: 743_200,
      dustCents: 0,
    });
    // The odd cent: floor/floor, the residue NEVER rounds into a payee.
    expect(dualIpSplitCents(1_486_401)).toEqual({
      licensorACents: 743_200,
      licensorBCents: 743_200,
      dustCents: 1,
    });
    expect(dualIpSplitCents(1)).toEqual({ licensorACents: 0, licensorBCents: 0, dustCents: 1 });
  });
});

describe("the treaty withholding and the master override", () => {
  it("floors the withheld leg", () => {
    expect(treatyWithholdingCents(1_914, 1000)).toBe(191); // US-JP 10% — exact
    expect(treatyWithholdingCents(1_915, 1000)).toBe(191); // 191.5 floors
    expect(treatyWithholdingCents(592_000, 0)).toBe(0); // US-GB 0%
  });

  it("prices the master royalty override — floor(net × override / 10000)", () => {
    expect(masterOverrideRoyaltyCents(10_880_000, 2500)).toBe(2_720_000);
    expect(masterOverrideRoyaltyCents(7_220_000, 2500)).toBe(1_805_000);
    expect(masterOverrideRoyaltyCents(4_500_001, 2500)).toBe(1_125_000); // .25 floors
  });
});

describe("the licensing event-id spaces", () => {
  const base = {
    licenseId: "LIC-APPAREL-001",
    categoryCode: "APPAREL",
    territoryIso: "US",
    period: "2026-08",
    senderRowId: "R-1001",
  } as const;

  it("keys one identity per (sender, license, category, territory, period, row id, sub-licensee)", () => {
    const retail = licensingRowEventId({ ...base, sender: "retail" });
    // A re-shipped report replays as the SAME identity.
    expect(licensingRowEventId({ ...base, sender: "retail" })).toBe(retail);
    // Two senders' sheets for the same sale stay distinct.
    expect(licensingRowEventId({ ...base, sender: "sellthrough" })).not.toBe(retail);
    expect(licensingRowEventId({ ...base, sender: "ecommerce" })).not.toBe(retail);
    expect(licensingRowEventId({ ...base, sender: "wholesale" })).not.toBe(retail);
    // The sub-licensee rides the identity.
    expect(
      licensingRowEventId({ ...base, sender: "wholesale", subLicenseeId: "SUB-EU-WEST" }),
    ).not.toBe(
      licensingRowEventId({ ...base, sender: "wholesale", subLicenseeId: "SUB-EU-EAST" }),
    );
    // Every id names its lane and its sender space.
    expect(retail).toMatch(/^licensing:retail:[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// The ingestion profiles — strict layouts, whole-file rejection.
// ---------------------------------------------------------------------------

describe("the licensing ingestion profiles", () => {
  it("dispatches all four senders to the licensing lane's kinds", () => {
    for (const fixture of [
      "licensing_retail_sales.csv",
      "licensing_sellthrough_log.csv",
      "licensing_ecommerce_pos.csv",
      "licensing_wholesale_manifest.csv",
    ]) {
      const { profile } = parseFixture(fixture);
      expect(isLicensingProfileKind(profile.kind)).toBe(true);
    }
  });

  it("parses the wholesale manifest's rows onto the addendum 12 triple with sub-licensee attribution", () => {
    const { lines } = parseFixture("licensing_wholesale_manifest.csv");
    expect(lines).toHaveLength(3);
    const first = lines[0]!.licensingDetail!;
    expect(first.sender).toBe("wholesale");
    expect(first.licenseId).toBe("LIC-TOYS-002");
    expect(first.categoryCode).toBe("TOYS");
    expect(first.territoryIso).toBe("GB");
    expect(first.subLicenseeId).toBe("SUB-EU-WEST");
    expect(first.reportedNetMicros).toBe("10880000000000"); // $108,800.00 exact
  });

  it("rejects a manifest that disagrees with its own arithmetic — whole file, never adjusted", () => {
    // $120,000.00 gross with the manifest's legs derives $108,800.00 —
    // the row reports $99,999.00. The parse refuses every row.
    expect(() => parseFixture("licensing_wholesale_manifest_mismatch.csv")).toThrow(
      new StatementParseError("manifest_reconciliation_mismatch:M-9001:row_1"),
    );
  });
});

// ---------------------------------------------------------------------------
// The queue writer + holding post — Net Sales computed once, at write time.
// ---------------------------------------------------------------------------

describe("the licensing queue writer and holding post", () => {
  it("writes every retail row with its Net Licensed Sales and honest dispositions", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "licensing_retail_sales.csv");
    expect(counts.written).toBe(3);
    expect(counts.matched).toBe(3);
    expect(counts.unmatched).toBe(0);

    const [row1, row2, row3] = counts.lineOutcomes;
    // Row 1: $232,250.00 net — the write-time realization.
    expect(row1!.disposition).toBe("money");
    expect(row1!.netCents).toBe(23_225_000);
    expect(row1!.eventId).toMatch(/^licensing:retail:[0-9a-f]{64}$/);
    // Row 2: $92,500.00 net, GB territory of record.
    expect(row2!.disposition).toBe("money");
    expect(row2!.netCents).toBe(9_250_000);
    expect(row2!.detail.territoryIso).toBe("GB");
    // Row 3: $100.00 − $150.00 = −$50.00 — the negative-net quarantine.
    expect(row3!.disposition).toBe("held_negative_net");
    expect(row3!.netCents).toBe(0);
    expect(counts.heldNegativeNet).toBe(1);
  });

  it("computes the POS rows' nets exact to the cent", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "licensing_ecommerce_pos.csv");
    // O-3001: $897.00 − $0.00 − $89.70 − $24.99 − $0.00 = $782.31.
    expect(counts.lineOutcomes[0]!.netCents).toBe(78_231);
    // O-3002: $299.00 — the JP territory of record (the treaty leg).
    expect(counts.lineOutcomes[1]!.netCents).toBe(29_900);
    expect(counts.lineOutcomes[1]!.detail.territoryIso).toBe("JP");
  });

  it("re-ingests a re-shipped report as counted no-ops", async () => {
    const store = new InMemoryStore();
    const first = await ingestFixture(store, "licensing_retail_sales.csv");
    const second = await ingestFixture(store, "licensing_retail_sales.csv");
    expect(second.counts.written).toBe(0);
    expect(second.counts.alreadyPresent).toBe(3);
    expect(second.counts.lineOutcomes.map((o) => o.eventId)).toEqual(
      first.counts.lineOutcomes.map((o) => o.eventId),
    );
  });

  it("posts the money dispositions' nets to holding and leaves the quarantined row", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "licensing_retail_sales.csv");
    const posting = await postLicensingNetsToHolding(store, counts, NOW);
    expect(posting.posted).toBe(2); // rows 1–2
    expect(posting.heldNegativeNet).toBe(1); // row 3 — visible, never posted
    expect(posting.zeroNet).toBe(0);

    // A replayed posting pass counts the per-source replay guard's no-ops.
    const replay = await postLicensingNetsToHolding(store, counts, NOW);
    expect(replay.alreadyPosted).toBe(2);
    expect(replay.posted).toBe(0);
    expect(replay.heldNegativeNet).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The royalty cascade — tier walks, cumulative state, ordering.
// ---------------------------------------------------------------------------

describe("the royalty cascade's tier walks", () => {
  it("walks the deal's schedule from the cumulative position and commits position-locked applications", async () => {
    const store = new InMemoryStore();
    const deal = await store.upsertLicensingRoyaltyDeal(apparelDeal());
    const { counts } = await ingestFixture(store, "licensing_retail_sales.csv");
    const posting = await postLicensingNetsToHolding(store, counts, NOW);
    const cascade = await runLicensingRoyaltyCascadePass(store, counts.lineOutcomes, NOW);

    expect(posting.posted).toBe(2);
    // Two money rows walked; the quarantined row never did.
    expect(cascade.applicationsCommitted).toBe(2);
    expect(cascade.applicationsReplayed).toBe(0);
    expect(cascade.skippedNoDeal).toBe(0);
    // R-1001: floor(23,225,000 × 8%) = 1,858,000; R-1002: floor(9,250,000 × 8%) = 740,000.
    expect(cascade.royaltyGrossCents).toBe(1_858_000 + 740_000);
    // Agency 20% of each walk's GROSS — deducted before any split.
    expect(cascade.agencyCommissionCents).toBe(371_600 + 148_000);

    // The applications are the append-only audit: the walk's slices and
    // the conservation identity — royalty = agency + A + B + dust, exact.
    const applications = await store.listLicensingRoyaltyApplications(deal.id);
    expect(applications).toHaveLength(2);
    const [first, second] = applications;
    expect(first!.net_sales_cents).toBe(23_225_000);
    expect(first!.cumulative_before_cents).toBe(0);
    expect(first!.royalty_cents).toBe(1_858_000);
    expect(first!.slices).toEqual([
      { tierIndex: 0, rateBps: 800, sliceCents: 23_225_000, royaltyCents: 1_858_000 },
    ]);
    expect(
      first!.agency_commission_cents +
        first!.licensor_a_gross_cents +
        first!.licensor_b_gross_cents +
        first!.dust_cents,
    ).toBe(first!.royalty_cents);
    // Single-licensor deal: everything on licensor A, zero dust.
    expect(first!.licensor_a_gross_cents).toBe(1_486_400);
    expect(first!.licensor_b_gross_cents).toBe(0);
    expect(first!.dust_cents).toBe(0);
    // The second walk started from the FIRST walk's advanced position —
    // the cumulative state across rows (and periods) carried.
    expect(second!.cumulative_before_cents).toBe(23_225_000);
    expect(second!.royalty_cents).toBe(740_000);

    // The deal's counters advanced as bookkeeping.
    const advanced = await store.getLicensingRoyaltyDeal("license:LIC-APPAREL-001");
    expect(advanced!.cumulative_net_sales_cents).toBe(32_475_000);
    expect(advanced!.cumulative_royalty_cents).toBe(2_598_000);
  });

  it("tracks the cumulative position across reporting periods — a later period's walk starts where the last ended", async () => {
    const store = new InMemoryStore();
    const deal = await store.upsertLicensingRoyaltyDeal(apparelDeal());
    const retail = await ingestFixture(store, "licensing_retail_sales.csv");
    await runLicensingRoyaltyCascadePass(store, retail.counts.lineOutcomes, NOW);

    // The sell-through log — a DIFFERENT sender, a later statement, the
    // same deal of record: $69,500.00 net walks from the advanced position.
    const sellthrough = await ingestFixture(store, "licensing_sellthrough_log.csv");
    const cascade = await runLicensingRoyaltyCascadePass(
      store,
      sellthrough.counts.lineOutcomes,
      NOW,
    );
    expect(cascade.applicationsCommitted).toBe(1);
    expect(cascade.royaltyGrossCents).toBe(556_000); // floor(6,950,000 × 8%)

    const applications = await store.listLicensingRoyaltyApplications(deal.id);
    expect(applications).toHaveLength(3);
    const third = applications[2]!;
    expect(third.source_event_id).toBe(sellthrough.counts.lineOutcomes[0]!.eventId);
    expect(third.cumulative_before_cents).toBe(32_475_000);
    expect(third.net_sales_cents).toBe(6_950_000);
    const advanced = await store.getLicensingRoyaltyDeal("license:LIC-APPAREL-001");
    expect(advanced!.cumulative_net_sales_cents).toBe(39_425_000);
    expect(advanced!.cumulative_royalty_cents).toBe(3_154_000);
  });

  it("replays a re-walked event as a counted no-op — never a double application", async () => {
    const store = new InMemoryStore();
    await store.upsertLicensingRoyaltyDeal(apparelDeal());
    const { counts } = await ingestFixture(store, "licensing_retail_sales.csv");
    await runLicensingRoyaltyCascadePass(store, counts.lineOutcomes, NOW);
    const cascade = await runLicensingRoyaltyCascadePass(store, counts.lineOutcomes, NOW);
    expect(cascade.applicationsCommitted).toBe(0);
    expect(cascade.applicationsReplayed).toBe(2);
    const advanced = await store.getLicensingRoyaltyDeal("license:LIC-APPAREL-001");
    expect(advanced!.cumulative_net_sales_cents).toBe(32_475_000); // unchanged
  });

  it("splits the post-agency remainder 50-50 with the odd cent to dust on a co-branded deal", async () => {
    const store = new InMemoryStore();
    const deal = await store.upsertLicensingRoyaltyDeal(
      apparelDeal({
        licensor_b_payee_id: "payee-cobrand",
        licensor_b_payee_name: "Co-Brand Licensor",
        licensor_b_country: "US",
      }),
    );
    const pos = await ingestFixture(store, "licensing_ecommerce_pos.csv");
    const cascade = await runLicensingRoyaltyCascadePass(store, pos.counts.lineOutcomes, NOW);
    // O-3001: royalty 6,258 → agency 1,251 → post-agency 5,007 (odd) →
    // floor/floor 2,503 + 2,503, the odd cent swept to dust.
    expect(cascade.applicationsCommitted).toBe(2);
    const applications = await store.listLicensingRoyaltyApplications(deal.id);
    const first = applications[0]!;
    expect(first.royalty_cents).toBe(6_258);
    expect(first.agency_commission_cents).toBe(1_251);
    expect(first.licensor_a_gross_cents).toBe(2_503);
    expect(first.licensor_b_gross_cents).toBe(2_503);
    expect(first.dust_cents).toBe(1);
    expect(
      first.agency_commission_cents +
        first.licensor_a_gross_cents +
        first.licensor_b_gross_cents +
        first.dust_cents,
    ).toBe(first.royalty_cents);
  });

  it("skips fail-closed when no deal of record exists or the currency mismatches", async () => {
    const store = new InMemoryStore();
    const { counts } = await ingestFixture(store, "licensing_retail_sales.csv");
    const noDeal = await runLicensingRoyaltyCascadePass(store, counts.lineOutcomes, NOW);
    expect(noDeal.skippedNoDeal).toBe(2); // the two money rows; row 3 never walks
    expect(noDeal.applicationsCommitted).toBe(0);

    // A deal of record in EUR never prices a USD statement — no FX here.
    await store.upsertLicensingRoyaltyDeal(apparelDeal({ currency: "EUR" }));
    const mismatch = await runLicensingRoyaltyCascadePass(store, counts.lineOutcomes, NOW);
    expect(mismatch.skippedCurrencyMismatch).toBe(2);
    expect(mismatch.applicationsCommitted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The royalty cascade — treaty withholding by source territory.
// ---------------------------------------------------------------------------

describe("the royalty cascade's treaty withholding", () => {
  it("applies the US-UK 0% and US-Japan 10% treaty rates of record by territory", async () => {
    const store = new InMemoryStore();
    const deal = await store.upsertLicensingRoyaltyDeal(apparelDeal());
    await store.upsertLicensingTreatyRate({
      source_country: "GB",
      residence_country: "US",
      rate_bps: 0, // the directive's US-UK 0% IP licensing withholding
      treaty_ref: "US-UK-2026-DBA",
    });
    await store.upsertLicensingTreatyRate({
      source_country: "JP",
      residence_country: "US",
      rate_bps: 1000, // the directive's US-Japan 10%
      treaty_ref: "US-JP-2026-DBA",
    });

    const retail = await ingestFixture(store, "licensing_retail_sales.csv");
    const retailCascade = await runLicensingRoyaltyCascadePass(
      store,
      retail.counts.lineOutcomes,
      NOW,
    );
    const pos = await ingestFixture(store, "licensing_ecommerce_pos.csv");
    const posCascade = await runLicensingRoyaltyCascadePass(store, pos.counts.lineOutcomes, NOW);
    void retailCascade;

    // R-1002 (GB): 0% treaty — withheld 0, rate OF RECORD (not domestic).
    const applications = await store.listLicensingRoyaltyApplications(deal.id);
    const gbRow = applications.find(
      (a) => a.source_event_id === retail.counts.lineOutcomes[1]!.eventId,
    )!;
    expect(gbRow.withholding_rate_bps).toBe(0);
    expect(gbRow.withholding_ref).toBe("US-UK-2026-DBA");
    expect(gbRow.licensor_a_withheld_cents).toBe(0);
    expect(gbRow.licensor_a_gross_cents).toBe(592_000); // the full post-agency leg pays out
    // The domestic row (R-1001, US→US) carries NO withholding at all.
    const domesticRow = applications.find(
      (a) => a.source_event_id === retail.counts.lineOutcomes[0]!.eventId,
    )!;
    expect(domesticRow.withholding_rate_bps).toBeNull();
    expect(domesticRow.withholding_ref).toBeNull();
    expect(domesticRow.licensor_a_withheld_cents).toBe(0);
    // O-3002 (JP): 10% of the 1,914-cent post-agency leg = 191 withheld.
    expect(posCascade.withheldCents).toBe(191);
    const jpRow = await store.listLicensingRoyaltyApplications(deal.id);
    const jp = jpRow.find(
      (a) => a.source_event_id === pos.counts.lineOutcomes[1]!.eventId,
    )!;
    expect(jp.withholding_rate_bps).toBe(1000);
    expect(jp.withholding_ref).toBe("US-JP-2026-DBA");
    expect(jp.licensor_a_withheld_cents).toBe(191);
    expect(jp.licensor_a_gross_cents).toBe(1_914);
  });

  it("falls to the deal's statutory default when no treaty pair is of record", async () => {
    const store = new InMemoryStore();
    const deal = await store.upsertLicensingRoyaltyDeal(
      apparelDeal({ withholding_default_bps: 3000 }),
    );
    const { counts } = await ingestFixture(store, "licensing_retail_sales.csv");
    const cascade = await runLicensingRoyaltyCascadePass(store, counts.lineOutcomes, NOW);
    // R-1002 (GB, uncovered): the 30% statutory default applies.
    expect(cascade.withheldCents).toBe(177_600); // floor(592,000 × 30%)
    const applications = await store.listLicensingRoyaltyApplications(deal.id);
    const gbRow = applications.find(
      (a) => a.source_event_id === counts.lineOutcomes[1]!.eventId,
    )!;
    expect(gbRow.withholding_rate_bps).toBe(3000);
    expect(gbRow.withholding_ref).toBe("default");
    expect(gbRow.licensor_a_withheld_cents).toBe(177_600);
  });

  it("HOLDS the payout legs on an uncovered international pair with no default — fail-closed", async () => {
    const store = new InMemoryStore();
    const deal = await store.upsertLicensingRoyaltyDeal(apparelDeal());
    const { counts } = await ingestFixture(store, "licensing_retail_sales.csv");
    const cascade = await runLicensingRoyaltyCascadePass(store, counts.lineOutcomes, NOW);
    // R-1002 (GB): no treaty, no statutory default — the payout leg is
    // HELD (null withheld legs on the record), never guessed at 0%.
    expect(cascade.payoutLegsHeld).toBe(1);
    expect(cascade.withheldCents).toBe(0);
    const applications = await store.listLicensingRoyaltyApplications(deal.id);
    const gbRow = applications.find(
      (a) => a.source_event_id === counts.lineOutcomes[1]!.eventId,
    )!;
    expect(gbRow.withholding_rate_bps).toBeNull();
    expect(gbRow.withholding_ref).toBeNull();
    expect(gbRow.licensor_a_withheld_cents).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The sub-license cascade — rollup, override, audit-gated release.
// ---------------------------------------------------------------------------

describe("the sub-licensee gross rollup with the master override", () => {
  it("files the reports of record with their own legs and the override royalty", async () => {
    const store = new InMemoryStore();
    await registerEuWest(store);
    const { counts } = await ingestFixture(store, "licensing_wholesale_manifest.csv");
    const cascade = await runLicensingRoyaltyCascadePass(store, counts.lineOutcomes, NOW);

    // M-4001 and M-4002 filed; M-4003's sub-licensee is unregistered —
    // fail-closed, counted, never a guessed override.
    expect(cascade.subReportsWritten).toBe(2);
    expect(cascade.skippedNoSubLicensee).toBe(1);

    const [m4001, m4002] = counts.lineOutcomes;
    const report1 = await store.getLicensingSubLicenseReport(m4001!.eventId);
    expect(report1).toBeDefined();
    // The rollup's recorded legs — the manifest's own arithmetic, exact.
    expect(report1!.gross_cents).toBe(12_000_000);
    expect(report1!.trade_discount_cents).toBe(600_000);
    expect(report1!.returned_goods_cents).toBe(150_000);
    expect(report1!.shipping_freight_cents).toBe(250_000);
    expect(report1!.vat_cents).toBe(120_000);
    expect(report1!.net_sales_cents).toBe(10_880_000);
    expect(report1!.master_override_bps).toBe(2500);
    // floor($108,800.00 × 25%) = $27,200.00.
    expect(report1!.master_royalty_cents).toBe(2_720_000);
    // The audit gate's open question — 'unknown' at write time.
    expect(report1!.audit_state).toBe("unknown");
    expect(report1!.evidence_ref).toBeNull();
    expect(report1!.reconciled_by).toBeNull();

    const report2 = await store.getLicensingSubLicenseReport(m4002!.eventId);
    expect(report2!.net_sales_cents).toBe(7_220_000);
    expect(report2!.master_royalty_cents).toBe(1_805_000); // floor($72,200.00 × 25%)

    // The scope's rollup — both reports filed under the master license.
    const reports = await store.listLicensingSubLicenseReports("license:LIC-TOYS-002");
    expect(reports).toHaveLength(2);
  });

  it("releases net proceeds ONLY after the evidenced audit reconciliation — once-only", async () => {
    const store = new InMemoryStore();
    await registerEuWest(store);
    const { counts } = await ingestFixture(store, "licensing_wholesale_manifest.csv");
    await runLicensingRoyaltyCascadePass(store, counts.lineOutcomes, NOW);
    const [m4001] = counts.lineOutcomes;
    const report1 = await store.getLicensingSubLicenseReport(m4001!.eventId);

    // The sweep BEFORE reconciliation releases nothing — 'unknown' holds.
    const beforeAudit = await releaseReconciledSubLicenseRoyalties(
      store,
      "license:LIC-TOYS-002",
      NOW,
    );
    expect(beforeAudit).toEqual({ posted: 0, replayed: 0 });
    expect(await store.listUnclaimedHoldingCredits(100)).toHaveLength(0);

    // THE AUDIT RECONCILIATION CAS — evidenced, once-only: the first call
    // wins the transition; a second call loses the race (undefined).
    const reconciled = await store.reconcileLicensingSubLicenseReport(
      report1!.id,
      "audit-batch-2026-08-eu-west",
      "auditor-founder",
    );
    expect(reconciled?.audit_state).toBe("reconciled");
    expect(reconciled?.evidence_ref).toBe("audit-batch-2026-08-eu-west");
    expect(reconciled?.reconciled_by).toBe("auditor-founder");
    expect(
      await store.reconcileLicensingSubLicenseReport(
        report1!.id,
        "audit-batch-2026-08-eu-west",
        "auditor-founder",
      ),
    ).toBeUndefined();

    // The sweep AFTER reconciliation releases exactly the reconciled
    // report's master royalty to holding; M-4002 stays held ('unknown').
    const afterAudit = await releaseReconciledSubLicenseRoyalties(
      store,
      "license:LIC-TOYS-002",
      NOW,
    );
    expect(afterAudit).toEqual({ posted: 1, replayed: 0 });
    const holding = await store.listUnclaimedHoldingCredits(100);
    expect(holding).toHaveLength(1);
    expect(holding[0]!.amount_cents).toBe(2_720_000);
    expect(holding[0]!.currency).toBe("USD");
    // The release's source identity rides the line-item linkage (the
    // holding post's match_queue mapping), not a split run.
    expect(holding[0]!.line_item_id).toBe("licensing:subrelease:" + report1!.source_event_id);

    // A second sweep replays through the per-source guard — no double pay.
    const again = await releaseReconciledSubLicenseRoyalties(store, "license:LIC-TOYS-002", NOW);
    expect(again).toEqual({ posted: 0, replayed: 1 });
    expect(await store.listUnclaimedHoldingCredits(100)).toHaveLength(1);
  });

  it("re-ships a manifest after reconciliation as replayed reports plus the gated release attempt", async () => {
    const store = new InMemoryStore();
    await registerEuWest(store);
    const first = await ingestFixture(store, "licensing_wholesale_manifest.csv");
    await runLicensingRoyaltyCascadePass(store, first.counts.lineOutcomes, NOW);
    const [m4001] = first.counts.lineOutcomes;
    const report1 = await store.getLicensingSubLicenseReport(m4001!.eventId);
    await store.reconcileLicensingSubLicenseReport(
      report1!.id,
      "audit-batch-2026-08-eu-west",
      "auditor-founder",
    );

    // The re-shipped manifest: the two filed reports replay on their
    // once-only keys; M-4003's unregistered sub-licensee still skips —
    // it never wrote a report to replay. The reconciled report's release
    // posts on its first attempt; the un-reconciled report stays held.
    const second = await ingestFixture(store, "licensing_wholesale_manifest.csv");
    expect(second.counts.alreadyPresent).toBe(3);
    const cascade = await runLicensingRoyaltyCascadePass(store, second.counts.lineOutcomes, NOW);
    expect(cascade.subReportsWritten).toBe(0);
    expect(cascade.subReportsReplayed).toBe(2);
    expect(cascade.subReleasesPosted).toBe(1);
    expect(cascade.subReleasesReplayed).toBe(0);
    expect(cascade.subHeldPendingAudit).toBe(1);
    expect(await store.listUnclaimedHoldingCredits(100)).toHaveLength(1);
  });
});
