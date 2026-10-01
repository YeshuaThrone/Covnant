// Film multi-territory withholding + the cross-collateralization firewall
// (PR 18) — the pure module's battery.
//
// Locked invariants under test, per the founder film directive patch: a
// withheld line's withholding is computed on the SOURCE-currency micros
// FIRST, at the territory's pinned versioned rate, and only then does
// anything convert into base currency (rate and amount logged either way);
// a withheld line whose territory has no effective rate version FAILS
// CLOSED — no guessed rate; the deal routes ONCE PER TERRITORY, each
// envelope consuming only that territory's money and carrying only its own
// paid state (the FDG trigger reads the territory's own cumulative gross);
// the territories add ONLY in the reporting summary; and the cross-
// collateralization firewall is DEFAULT-DENY — a short territory may not
// draw on another territory's money unless the signed CAMA explicitly
// permits it, and even then the sweep draws ONLY from creditors' tier-5
// residue (the profit pool), never senior-tier money. The isolation
// verifier recomputes every envelope from the territory's own gross and
// refuses any applied routing that cannot be reproduced that way.
//
// Amount literals are integer cents with _ as a thousands separator
// (10_000 = $100.00), the repo-wide test convention; source amounts ride
// exact statement micros as bigint.

import { describe, expect, it } from "vitest";
import {
  applyCrossCollateralization,
  computeFilmTerritoryWithholding,
  FOREIGN_WITHHOLDING_RATE_TABLES,
  foreignWithholdingRateForTerritory,
  routeTerritoryWaterfalls,
  verifyTerritoryIsolation,
} from "@/modules/waterfall/territory";
import type {
  CrossCollateralizationTerms,
  DebtorObligationCarry,
  TerritoryReceiptInput,
  TerritorialFxConvert,
} from "@/modules/waterfall/territory";
import type {
  FilmWaterfallDefinition,
} from "@/modules/waterfall/engine";
import type { TerritoryEnvelopeRouting } from "@/modules/waterfall/territory";
import { validateFilmWaterfallDefinition } from "@/modules/waterfall/engine";

// ---------------------------------------------------------------------------
// The canonical deal — six tiers (the schema's contract), hand-checkable
// sizes: 10% commission, $400 P&A cap, $110 senior debt (10% interest),
// $120 equity (20% preferred), $50 deferrals, profit pool; FDG 5% off the
// top once the territory's cumulative gross crosses $1,000.
// ---------------------------------------------------------------------------

function deal(): FilmWaterfallDefinition {
  return {
    film_id: "film-77",
    label: "Multi-territory deal",
    tiers: [
      {
        tier_level: 0,
        label: "Distribution fees",
        legs: [
          {
            leg_id: "dist-fee",
            label: "Distribution commission (10%)",
            payee_id: "payee-distributor",
            payee_name: "Distribution Co",
            structure: { type: "per_receipt_bps", bps: 1000, cap_cents: null },
          },
        ],
      },
      {
        tier_level: 1,
        label: "Recoupable expenses & senior debt",
        legs: [
          {
            leg_id: "pa-cap",
            label: "P&A marketing expense cap",
            payee_id: "payee-pa",
            payee_name: "P&A Lender",
            structure: { type: "fixed_obligation", obligation_cents: 40_000 },
          },
          {
            leg_id: "senior-debt",
            label: "Senior debt + gap (10% interest)",
            payee_id: "payee-bank",
            payee_name: "Senior Lender",
            structure: { type: "debt_recoupment", principal_cents: 10_000, interest_bps: 1000 },
          },
        ],
      },
      {
        tier_level: 2,
        label: "CAMA & guilds",
        legs: [],
      },
      {
        tier_level: 3,
        label: "Equity",
        legs: [
          {
            leg_id: "equity",
            label: "Equity + preferred return",
            payee_id: "payee-equity",
            payee_name: "Equity Investors",
            structure: { type: "equity_recoupment", principal_cents: 10_000, preferred_return_bps: 2000 },
          },
        ],
      },
      {
        tier_level: 4,
        label: "Deferrals",
        legs: [
          {
            leg_id: "deferrals",
            label: "Deferred compensation",
            payee_id: "payee-deferrals",
            payee_name: "Deferred Crew",
            structure: { type: "fixed_obligation", obligation_cents: 5_000 },
          },
        ],
      },
      {
        tier_level: 5,
        label: "Net profit pool",
        legs: [
          {
            leg_id: "profit-pool",
            label: "Net profit pool",
            payee_id: "payee-pool",
            payee_name: "Producer / Investor pools",
            structure: { type: "profit_pool" },
          },
        ],
      },
    ],
    fdg: {
      participants: [
        { payee_id: "payee-actor", payee_name: "Lead Actor", role: "creator", share_bps: 500 },
      ],
      threshold_cents: 100_000,
    },
  };
}

// The deal under test validates — the battery never routes an invalid deal.
expect(validateFilmWaterfallDefinition(deal()).ok).toBe(true);

/** A pinned EUR→USD converter: 1.08 exactly, floored to whole base cents. */
const convertEurUsd: TerritorialFxConvert = (amountCents, sourceCurrency) =>
  sourceCurrency === "EUR"
    ? {
        ok: true,
        convertedAmountCents: Math.floor((amountCents * 1_080_000) / 1_000_000),
        fxRateMicros: 1_080_000,
      }
    : { ok: false, code: "unsupported_currency", message: `unsupported currency ${sourceCurrency}` };

function receipt(territory: string, amount: number, cumulative: number): TerritoryReceiptInput {
  return { territory_code: territory, amount_cents: amount, cumulative_gross_cents: cumulative };
}

// ---------------------------------------------------------------------------
// Foreign withholding — source-micros math BEFORE conversion.
// ---------------------------------------------------------------------------

describe("computeFilmTerritoryWithholding — withholding before conversion", () => {
  it("withholds at the territory's pinned rate on the SOURCE micros, then converts gross and withheld separately", () => {
    // €100.00 gross, France's 30% treaty rate, effective 2026 table.
    // Codebase micros canon: 1 cent = 1_000_000 micros (MICROS_PER_CENT).
    const result = computeFilmTerritoryWithholding(
      {
        event_id: "evt-1",
        film_id: "film-77",
        territory_code: "FR",
        foreign_tax_withheld: true,
        source_currency: "EUR",
        gross_source_micros: 10_000_000_000n,
        period_first_day: "2026-06-01",
      },
      "USD",
      convertEurUsd,
    );
    if (!result.ok) throw new Error(`refused: ${result.code} ${result.message}`);
    const c = result.computation;
    // The rate, pinned and versioned.
    expect(c.withholding_rate_bps).toBe(3000);
    expect(c.rate_table_version).toBe("2026-founding");
    // The source math happened in micros BEFORE conversion: exactly €30.00
    // withheld, €70.00 net.
    expect(c.gross_source_micros).toBe("10000000000");
    expect(c.withheld_source_micros).toBe("3000000000");
    expect(c.net_source_micros).toBe("7000000000");
    // THEN the conversion — gross and withheld convert separately, and the
    // net is their difference so the cents conserve exactly through floors.
    expect(c.fx_rate_micros).toBe(1_080_000);
    expect(c.gross_base_cents).toBe(10_800);
    expect(c.withheld_base_cents).toBe(3_240);
    expect(c.net_base_cents).toBe(7_560);
  });

  it("floors the bps share in source micros — no rounding up, ever", () => {
    const result = computeFilmTerritoryWithholding(
      {
        event_id: "evt-2",
        film_id: "film-77",
        territory_code: "FR",
        foreign_tax_withheld: true,
        source_currency: "EUR",
        // One micro over a whole euro: 30% is 30_000_000.3 micros — floored.
        gross_source_micros: 100_000_001n,
        period_first_day: "2026-06-01",
      },
      "USD",
      convertEurUsd,
    );
    if (!result.ok) throw new Error(`refused: ${result.code}`);
    expect(result.computation.withheld_source_micros).toBe("30000000");
    expect(result.computation.net_source_micros).toBe("70000001");
  });

  it("logs a not-withheld line at rate 0 with a null version — the table was never consulted", () => {
    const result = computeFilmTerritoryWithholding(
      {
        event_id: "evt-3",
        film_id: "film-77",
        territory_code: "FR",
        foreign_tax_withheld: false,
        source_currency: "EUR",
        gross_source_micros: 10_000_000_000n,
        period_first_day: "2026-06-01",
      },
      "USD",
      convertEurUsd,
    );
    if (!result.ok) throw new Error(`refused: ${result.code}`);
    const c = result.computation;
    expect(c.foreign_tax_withheld).toBe(false);
    expect(c.withholding_rate_bps).toBe(0);
    expect(c.rate_table_version).toBeNull();
    expect(c.withheld_source_micros).toBe("0");
    expect(c.withheld_base_cents).toBe(0);
    // The whole gross remits: net = gross in both currencies.
    expect(c.net_source_micros).toBe("10000000000");
    expect(c.net_base_cents).toBe(c.gross_base_cents);
  });

  it("fails closed when a withheld line's territory has no effective rate version — no guessed rate", () => {
    // CN carries no rate in any version.
    const unknownTerritory = computeFilmTerritoryWithholding(
      {
        event_id: "evt-4",
        film_id: "film-77",
        territory_code: "CN",
        foreign_tax_withheld: true,
        source_currency: "EUR",
        gross_source_micros: 10_000_000_000n,
        period_first_day: "2026-06-01",
      },
      "USD",
      convertEurUsd,
    );
    expect(unknownTerritory).toMatchObject({ ok: false, code: "no_withholding_rate_for_territory" });

    // The founding table is not yet effective for a 2025 period — the same
    // refusal even for a territory the table knows.
    const beforeEffective = computeFilmTerritoryWithholding(
      {
        event_id: "evt-5",
        film_id: "film-77",
        territory_code: "FR",
        foreign_tax_withheld: true,
        source_currency: "EUR",
        gross_source_micros: 10_000_000_000n,
        period_first_day: "2025-12-31",
      },
      "USD",
      convertEurUsd,
    );
    expect(beforeEffective).toMatchObject({ ok: false, code: "no_withholding_rate_for_territory" });
  });

  it("refuses malformed lines instead of rounding or dropping them", () => {
    const base = {
      event_id: "evt-6",
      film_id: "film-77",
      territory_code: "FR",
      foreign_tax_withheld: true,
      source_currency: "EUR",
      gross_source_micros: 10_000_000_000n,
      period_first_day: "2026-06-01",
    };
    expect(
      computeFilmTerritoryWithholding({ ...base, event_id: "  " }, "USD", convertEurUsd),
    ).toMatchObject({ ok: false, code: "invalid_event_id" });
    expect(
      computeFilmTerritoryWithholding({ ...base, territory_code: "FRA" }, "USD", convertEurUsd),
    ).toMatchObject({ ok: false, code: "invalid_territory_code" });
    expect(
      computeFilmTerritoryWithholding({ ...base, gross_source_micros: -1n }, "USD", convertEurUsd),
    ).toMatchObject({ ok: false, code: "invalid_gross_micros" });
    // The converter's refusal quarantines the line (never rounded through).
    expect(
      computeFilmTerritoryWithholding({ ...base, source_currency: "CHF" }, "USD", convertEurUsd),
    ).toMatchObject({ ok: false, code: "unsupported_currency" });
  });

  it("selects the latest version effective on the period's first day — additive versions, immutable history", () => {
    // The founding table covers 2026-06-01; a later version for the same
    // territory would win only from its own effectiveFrom.
    const rate = foreignWithholdingRateForTerritory("FR", "2026-06-01");
    expect(rate).toEqual({ rate_bps: 3000, version: "2026-founding" });
    expect(rate?.version).toBe(FOREIGN_WITHHOLDING_RATE_TABLES[0].version);
  });
});

// ---------------------------------------------------------------------------
// Territory-partitioned envelopes — each territory's own money, own state.
// ---------------------------------------------------------------------------

describe("routeTerritoryWaterfalls — per-territory envelopes", () => {
  it("routes each territory's money through its own cascade and sums only the reporting totals", () => {
    // FR: $500 gross, cumulative $1,500 — the FDG trigger (≥ $1,000) fires
    // for THIS territory. DE: $200 gross, cumulative $500 — no FDG.
    const report = routeTerritoryWaterfalls(deal(), [
      receipt("FR", 50_000, 150_000),
      receipt("DE", 20_000, 50_000),
    ]);
    if (!report.ok) throw new Error(`refused: ${report.code} ${report.message}`);

    // One envelope per territory, territory-code order regardless of input order.
    expect(report.envelopes.map((e) => e.territory_code)).toEqual(["DE", "FR"]);

    const fr = report.envelopes[1];
    const de = report.envelopes[0];

    // FR's envelope: FDG 5% off the top ($250), then the 10% commission on
    // the full receipt ($500), then the $400 P&A cap, then senior debt
    // takes what survives ($250). Its own unpaid: $85 + $120 + $50.
    expect(fr.routing.fdg_triggered).toBe(true);
    expect(fr.routing.fdg_bypass_cents).toBe(2_500);
    const frLeg = (legId: string) => fr.routing.legs.find((l) => l.leg_id === legId);
    expect(frLeg("dist-fee")?.routed_cents).toBe(5_000);
    expect(frLeg("pa-cap")?.routed_cents).toBe(40_000);
    expect(frLeg("senior-debt")?.routed_cents).toBe(2_500);
    expect(fr.routing.unpaid_total_cents).toBe(25_500);

    // DE's envelope: no FDG, the commission takes $200, P&A recoups $180 of
    // its $400 — DE's own $220 shortfall. FR's money never touched it.
    expect(de.routing.fdg_triggered).toBe(false);
    expect(de.routing.fdg_bypass_cents).toBe(0);
    const deLeg = (legId: string) => de.routing.legs.find((l) => l.leg_id === legId);
    expect(deLeg("dist-fee")?.routed_cents).toBe(2_000);
    expect(deLeg("pa-cap")?.routed_cents).toBe(18_000);
    expect(deLeg("pa-cap")?.unpaid_cents).toBe(22_000);
    expect(de.routing.unpaid_total_cents).toBe(50_000);

    // The totals are the summed REPORTING view and nothing else: $700 gross
    // in, $250 FDG off the top, $675 routed, shortfalls summed per territory.
    expect(report.totals).toEqual({
      gross_cents: 70_000,
      fdg_bypass_cents: 2_500,
      routed_cents: 67_500,
      unpaid_total_cents: 75_500,
      dust_cents: 0,
      profit_pool_cents: 0,
    });
  });

  it("carries each territory's own paid state — FR's recoupment never advances DE's", () => {
    // FR has fully recouped the P&A cap in prior periods; DE has paid nothing.
    const report = routeTerritoryWaterfalls(
      deal(),
      [receipt("FR", 50_000, 150_000), receipt("DE", 20_000, 50_000)],
      { FR: { "pa-cap": 40_000 }, DE: {} },
    );
    if (!report.ok) throw new Error(`refused: ${report.code}`);
    const fr = report.envelopes.find((e) => e.territory_code === "FR");
    const de = report.envelopes.find((e) => e.territory_code === "DE");
    // FR's P&A is recouped — its residue flows past the cap.
    const frPa = fr?.routing.legs.find((l) => l.leg_id === "pa-cap");
    expect(frPa?.routed_cents).toBe(0);
    expect(frPa?.unpaid_cents).toBe(0);
    // DE's cap is untouched — still $220 short on its own money.
    const dePa = de?.routing.legs.find((l) => l.leg_id === "pa-cap");
    expect(dePa?.unpaid_cents).toBe(22_000);
  });

  it("refuses duplicate territory receipts, malformed rows, and corrupt paid state", () => {
    // Repeated remittances aggregate into ONE input row per territory.
    expect(
      routeTerritoryWaterfalls(deal(), [receipt("FR", 30_000, 0), receipt("FR", 20_000, 0)]),
    ).toMatchObject({ ok: false, code: "duplicate_territory_receipt" });
    expect(
      routeTerritoryWaterfalls(deal(), [receipt("France", 30_000, 0)]),
    ).toMatchObject({ ok: false, code: "invalid_territory_receipt" });
    expect(
      routeTerritoryWaterfalls(deal(), [receipt("FR", -1, 0)]),
    ).toMatchObject({ ok: false, code: "invalid_territory_receipt" });
    expect(
      routeTerritoryWaterfalls(deal(), [receipt("FR", 30_000, 0)], { FR: { "pa-cap": -5 } }),
    ).toMatchObject({ ok: false, code: "invalid_paid_state" });
  });
});

// ---------------------------------------------------------------------------
// The cross-collateralization firewall — default-deny, CAMA-permitted sweep.
// ---------------------------------------------------------------------------

describe("applyCrossCollateralization — the firewall", () => {
  // FR $500 (FDG fires, senior debt partially paid, no residue); DE $200
  // (short $220 on the P&A cap); GB $2,000 (every obligation recouped,
  // $1,120 of tier-5 residue).
  function threeTerritoryReport() {
    const report = routeTerritoryWaterfalls(deal(), [
      receipt("FR", 50_000, 150_000),
      receipt("DE", 20_000, 50_000),
      receipt("GB", 200_000, 0),
    ]);
    if (!report.ok) throw new Error(`refused: ${report.code}`);
    return report;
  }

  const debtors: DebtorObligationCarry[] = [
    { territory_code: "DE", leg_id: "pa-cap", unpaid_cents: 22_000 },
  ];

  it("denies by default — no terms, no override, nothing crosses", () => {
    const report = threeTerritoryReport();
    const denied = applyCrossCollateralization(report, debtors, null);
    expect(denied).toMatchObject({ ok: false, code: "cross_collateralization_denied" });
    if (denied.ok) throw new Error("the firewall let the denial type through as success");
    // The refusal names the debtor and the creditor candidates.
    expect(denied.message).toContain("DE");
    expect(denied.message).toContain("FR");
  });

  it("denies a flag-only override — the CAMA agreement of record must be named", () => {
    const report = threeTerritoryReport();
    const blankRef = applyCrossCollateralization(report, debtors, {
      cama_agreement_ref: "   ",
      cross_collateralization_permitted: true,
    });
    expect(blankRef).toMatchObject({ ok: false, code: "cama_agreement_ref_required" });

    const flagFalse = applyCrossCollateralization(report, debtors, {
      cama_agreement_ref: "CAMA-2026-014",
      cross_collateralization_permitted: false,
    });
    expect(flagFalse).toMatchObject({ ok: false, code: "cross_collateralization_denied" });
  });

  it("is a no-op when no debtor carries a shortfall — the override is never even consulted", () => {
    const report = threeTerritoryReport();
    const result = applyCrossCollateralization(report, [], {
      cama_agreement_ref: "CAMA-2026-014",
      cross_collateralization_permitted: false,
    });
    expect(result).toMatchObject({ ok: true, applications: [], applied_total_cents: 0 });
  });

  it("with the CAMA override, the sweep draws ONLY from creditors' tier-5 residue — senior-tier money is unreachable", () => {
    const report = threeTerritoryReport();
    const permitted = applyCrossCollateralization(report, debtors, {
      cama_agreement_ref: "CAMA-2026-014",
      cross_collateralization_permitted: true,
    });
    if (!permitted.ok) throw new Error(`refused: ${permitted.code} ${permitted.message}`);

    // DE's $220 shortfall funded from GB's profit pool ONLY. FR holds
    // senior-tier money ($250 in senior debt) but zero residue — it never
    // appears as a creditor.
    expect(permitted.applications).toEqual([
      { debtor_territory: "DE", creditor_territory: "GB", debtor_leg_id: "pa-cap", applied_cents: 22_000 },
    ]);
    expect(permitted.applied_total_cents).toBe(22_000);
    expect(permitted.remaining_unpaid_cents).toBe(0);
    expect(permitted.terms).toEqual({
      cama_agreement_ref: "CAMA-2026-014",
      cross_collateralization_permitted: true,
    });
  });

  it("serves debtors in territory-then-leg order against creditors in territory order, consuming residue sequentially and conserving to the cent", () => {
    const report = threeTerritoryReport();
    const bothShort: DebtorObligationCarry[] = [
      { territory_code: "FR", leg_id: "senior-debt", unpaid_cents: 8_500 },
      { territory_code: "DE", leg_id: "pa-cap", unpaid_cents: 22_000 },
    ];
    const permitted = applyCrossCollateralization(report, bothShort, {
      cama_agreement_ref: "CAMA-2026-014",
      cross_collateralization_permitted: true,
    });
    if (!permitted.ok) throw new Error(`refused: ${permitted.code}`);
    // DE before FR (territory order); GB funds each in turn.
    expect(permitted.applications).toEqual([
      { debtor_territory: "DE", creditor_territory: "GB", debtor_leg_id: "pa-cap", applied_cents: 22_000 },
      { debtor_territory: "FR", creditor_territory: "GB", debtor_leg_id: "senior-debt", applied_cents: 8_500 },
    ]);
    expect(permitted.applied_total_cents).toBe(30_500);
    expect(permitted.remaining_unpaid_cents).toBe(0);
  });

  it("stops at the residue — a shortfall no creditor pool can cover stays honestly unpaid", () => {
    const report = threeTerritoryReport();
    // $200,000 of shortfall against $1,120 of residue.
    const giant: DebtorObligationCarry[] = [
      { territory_code: "DE", leg_id: "pa-cap", unpaid_cents: 200_000 },
    ];
    const permitted = applyCrossCollateralization(report, giant, {
      cama_agreement_ref: "CAMA-2026-014",
      cross_collateralization_permitted: true,
    });
    if (!permitted.ok) throw new Error(`refused: ${permitted.code}`);
    expect(permitted.applied_total_cents).toBe(112_000);
    expect(permitted.remaining_unpaid_cents).toBe(88_000);
    expect(permitted.applications[0].applied_cents).toBe(112_000);
  });

  it("refuses when the CAMA permits but no creditor holds residue — nothing crossed", () => {
    // FR and DE only: neither reaches the profit pool.
    const report = routeTerritoryWaterfalls(deal(), [
      receipt("FR", 50_000, 150_000),
      receipt("DE", 20_000, 50_000),
    ]);
    if (!report.ok) throw new Error(`refused: ${report.code}`);
    const permitted = applyCrossCollateralization(report, debtors, {
      cama_agreement_ref: "CAMA-2026-014",
      cross_collateralization_permitted: true,
    });
    expect(permitted).toMatchObject({ ok: false, code: "no_creditor_residue" });
  });
});

// ---------------------------------------------------------------------------
// The isolation verifier — the firewall's exact proof.
// ---------------------------------------------------------------------------

describe("verifyTerritoryIsolation — the exact proof", () => {
  it("passes an honest per-territory routing", () => {
    const receipts = [receipt("FR", 50_000, 150_000), receipt("DE", 20_000, 50_000)];
    const paid = { FR: { "pa-cap": 40_000 }, DE: {} };
    const report = routeTerritoryWaterfalls(deal(), receipts, paid);
    if (!report.ok) throw new Error(`refused: ${report.code}`);
    const proof = verifyTerritoryIsolation(deal(), receipts, paid, report.envelopes);
    expect(proof.ok).toBe(true);
  });

  it("refuses a pooled allocation — a territory's legs must reproduce from its own envelope alone", () => {
    const receipts = [receipt("FR", 50_000, 150_000), receipt("DE", 20_000, 50_000)];
    const paid = { FR: {}, DE: {} };
    const report = routeTerritoryWaterfalls(deal(), receipts, paid);
    if (!report.ok) throw new Error(`refused: ${report.code}`);

    // The siphon: DE's P&A cap "pays" $500 more than its own money allows —
    // exactly the shape of cross-territorial expense dumping.
    const siphoned: TerritoryEnvelopeRouting[] = report.envelopes.map((envelope) =>
      envelope.territory_code === "DE"
        ? {
            ...envelope,
            routing: {
              ...envelope.routing,
              legs: envelope.routing.legs.map((leg) =>
                leg.leg_id === "pa-cap"
                  ? { ...leg, routed_cents: leg.routed_cents + 5_000 }
                  : leg,
              ),
            },
          }
        : envelope,
    );
    const violation = verifyTerritoryIsolation(deal(), receipts, paid, siphoned);
    expect(violation).toMatchObject({
      ok: false,
      code: "territory_isolation_violation",
      territory_code: "DE",
      leg_id: "pa-cap",
    });
  });

  it("refuses applied routings that drop a territory or invent one", () => {
    const receipts = [receipt("FR", 50_000, 150_000), receipt("DE", 20_000, 50_000)];
    const paid = { FR: {}, DE: {} };
    const report = routeTerritoryWaterfalls(deal(), receipts, paid);
    if (!report.ok) throw new Error(`refused: ${report.code}`);

    const dropped = verifyTerritoryIsolation(
      deal(),
      receipts,
      paid,
      report.envelopes.filter((e) => e.territory_code !== "DE"),
    );
    expect(dropped).toMatchObject({
      ok: false,
      code: "territory_isolation_violation",
      territory_code: "DE",
    });

    const invented: TerritoryEnvelopeRouting[] = [
      ...report.envelopes,
      {
        territory_code: "XX",
        gross_cents: 10_000,
        routing: report.envelopes[0].routing,
      },
    ];
    const inventedProof = verifyTerritoryIsolation(deal(), receipts, paid, invented);
    expect(inventedProof).toMatchObject({
      ok: false,
      code: "territory_isolation_violation",
      territory_code: "XX",
    });
  });

  it("refuses an envelope claiming gross it does not own", () => {
    const receipts = [receipt("FR", 50_000, 150_000)];
    const paid = { FR: {} };
    const report = routeTerritoryWaterfalls(deal(), receipts, paid);
    if (!report.ok) throw new Error(`refused: ${report.code}`);
    const inflated: TerritoryEnvelopeRouting[] = report.envelopes.map((e) => ({
      ...e,
      gross_cents: e.gross_cents + 10_000,
    }));
    const violation = verifyTerritoryIsolation(deal(), receipts, paid, inflated);
    expect(violation).toMatchObject({
      ok: false,
      code: "territory_isolation_violation",
      territory_code: "FR",
    });
  });
});

// The terms type is structural: absent flag = false keeps the firewall up.
describe("CrossCollateralizationTerms", () => {
  it("keeps the firewall up when the flag is merely absent or falsy", () => {
    const terms: CrossCollateralizationTerms = {
      cama_agreement_ref: "CAMA-2026-014",
      cross_collateralization_permitted: false,
    };
    expect(terms.cross_collateralization_permitted).toBe(false);
  });
});
