// Film multi-territory withholding + the cross-collateralization firewall
// (PR 18, founder directive patch canon round 2).
//
// The founder film directive's multi-territory patch over PR 8's waterfall
// engine. Three mechanics, one canon:
//
//   1. FOREIGN WITHHOLDING AT THE COUNTRY LEVEL — a film statement line
//      carries territory_code (the film tax jurisdiction) and
//      foreign_tax_withheld (addendum 6, migration 0011). When the flag is
//      set, the line's withholding is computed on the SOURCE-currency
//      amount FIRST, at the territory's pinned rate, and logged per line
//      (rate and amount on the record) BEFORE anything converts into the
//      Don ledger's base currency. The rate tables are versioned contracts
//      (the guild-residuals discipline): a renegotiated treaty rate lands
//      as a new version row, the calculation never rewrites history, and a
//      withheld line whose territory has no versioned rate FAILS CLOSED —
//      no guessed rate. The withheld money left at the border (the foreign
//      tax authority took it before the distributor remitted); the log row
//      is the foreign-tax-credit evidence, and only the remitted net posts
//      onward.
//
//   2. TERRITORY-PARTITIONED WATERFALL ENVELOPES — the deal (PR 8's six-tier
//      definition) routes ONCE PER TERRITORY, each envelope consuming ONLY
//      that territory's money and carrying ONLY that territory's paid
//      state. Recoupment and expense nets are computed per territory; the
//      territories add ONLY in the reporting summary. There is no pooled
//      routing to reach for — but the firewall verifier recomputes every
//      envelope from the territory's own gross and refuses any applied
//      routing that cannot be reproduced that way, so Territory A expenses
//      can never reduce Territory B senior debt (the isolation proof is
//      exact, not procedural).
//
//   3. THE CROSS-COLLATERALIZATION FIREWALL — default-deny. A territory
//      whose obligations its own receipts cannot cover may NOT draw on
//      another territory's money: the firewall refuses with a coded error
//      naming the debtor and creditor candidates. ONLY when the signed
//      CAMA explicitly permits cross-collateralization (the override flag,
//      fail-closed on anything but true, against a non-empty agreement
//      ref) does the cross-territorial sweep run — and even then it draws
//      ONLY from creditors' tier-5 residue (the profit pool, the money
//      already past every obligation), never from money routed to a
//      creditor's senior tiers. Senior debt payout balances in one
//      territory are unreachable from another territory's expenses, with
//      or without the override; the override's reach ends at the profit
//      pool. Every application is on the record: debtor, creditor, leg,
//      exact cents.
//
// This module is PURE — no Store, no I/O, no clock — the waterfall engine's
// own discipline (routeWaterfallTransaction does the per-territory routing;
// this module partitions, withholds, verifies, and sweeps). Integer cents
// and basis points throughout; source amounts ride the exact statement
// micros as bigint; every share is a floor, so nothing can overdraw.

import { BPS_DENOMINATOR } from "@/modules/don/constants";
import {
  routeWaterfallTransaction,
  type FilmWaterfallDefinition,
  type WaterfallLegRouting,
  type WaterfallPaidState,
  type WaterfallRouting,
} from "./engine";

// ---------------------------------------------------------------------------
// Foreign withholding — the versioned rate contracts (guild-residuals shape).
// ---------------------------------------------------------------------------

/** One territory's withholding rate table version — a pinned treaty rate. */
export interface ForeignWithholdingRateVersion {
  /** Version label — stable, rides the log row. */
  version: string;
  /** ISO date the version takes effect. */
  effectiveFrom: string;
  /** Whole basis points per territory code (2500 bps = 25% at source). */
  rates: Readonly<Record<string, number>>;
  note: string;
}

/**
 * The versioned withholding rate contracts. Rates are the founder's 10-30
 * percent local-tax examples, PINNED values of each version — never
 * float-adjusted, never interpolated. Adding a version is additive; existing
 * versions are immutable history. A withheld line for a territory absent
 * from the effective table fails closed (no guessed rate).
 */
export const FOREIGN_WITHHOLDING_RATE_TABLES: readonly ForeignWithholdingRateVersion[] = [
  {
    version: "2026-founding",
    effectiveFrom: "2026-01-01",
    rates: {
      // The founder's examples: 10 to 30 percent local withholding at source.
      AU: 1000,
      CA: 2500,
      DE: 1500,
      ES: 2400,
      FR: 3000,
      GB: 2500,
      IT: 3000,
      JP: 1000,
    },
    note: "2026 founding table — the directive's 10-30% local-tax examples, pinned per territory.",
  },
];

/**
 * The withholding rate for one territory on one period — the latest version
 * effective on or before the period's first day (ISO YYYY-MM-DD). Returns
 * { rate_bps, version } or undefined when NO effective version carries the
 * territory — the caller fails closed (no guessed rate). Pure.
 */
export function foreignWithholdingRateForTerritory(
  territoryCode: string,
  periodFirstDay: string,
): { rate_bps: number; version: string } | undefined {
  let effective: ForeignWithholdingRateVersion | undefined;
  for (const table of FOREIGN_WITHHOLDING_RATE_TABLES) {
    if (table.effectiveFrom <= periodFirstDay) {
      if (effective === undefined || table.effectiveFrom >= effective.effectiveFrom) {
        effective = table;
      }
    }
  }
  if (effective === undefined) return undefined;
  const rate = effective.rates[territoryCode];
  return rate === undefined ? undefined : { rate_bps: rate, version: effective.version };
}

/** 1 ledger cent = 10^6 statement micros — the posting seam's own constant, restated (module stays independent of the worker layer). */
const MICROS_PER_CENT = 1_000_000n;

/** A line's source-currency identity as the withholding computation consumes it. */
export interface TerritoryWithholdingLineInput {
  /** The content-derived match_queue event id — the log's replay/uniqueness key. */
  event_id: string;
  /** The film the line receipts against. */
  film_id: string;
  /** The film tax jurisdiction (ISO 3166-1 alpha-2) — addendum 6's column. */
  territory_code: string;
  /** Addendum 6's flag: did the foreign tax authority withhold at source? */
  foreign_tax_withheld: boolean;
  /** The statement's source currency (the remittance's own denomination). */
  source_currency: string;
  /** The line's gross in exact source micros — never a float. */
  gross_source_micros: bigint;
  /** The statement period's first day (ISO date) — the rate table's selector. */
  period_first_day: string;
}

/**
 * The FX conversion the withholding log rides — injected so the module stays
 * pure (fixtures pin exact rates; production wires the covenant-sdk FX node).
 * Input is whole source-currency cents; the output is the whole base-currency
 * cents plus the applied rate (micros of base per source unit) for the log.
 */
export type TerritorialFxConvert = (
  amountCents: number,
  sourceCurrency: string,
) => { ok: true; convertedAmountCents: number; fxRateMicros: number } | { ok: false; code: string; message: string };

/** One line's withholding log — rate and amount logged BEFORE base conversion. */
export interface FilmTerritoryWithholdingComputation {
  event_id: string;
  film_id: string;
  territory_code: string;
  foreign_tax_withheld: boolean;
  /** The applied treaty rate, bps — 0 when the line was not withheld. */
  withholding_rate_bps: number;
  /** The rate table version consulted — null when the line was not withheld. */
  rate_table_version: string | null;
  source_currency: string;
  /** Exact source amounts, decimal micros — never floats. */
  gross_source_micros: string;
  withheld_source_micros: string;
  net_source_micros: string;
  base_currency: string;
  /** The applied FX rate (micros of base per source unit), from the converter. */
  fx_rate_micros: number;
  /** Whole base-currency cents the escrow will post (net) and the log carries. */
  gross_base_cents: number;
  withheld_base_cents: number;
  net_base_cents: number;
}

export type TerritoryWithholdingFailure = {
  ok: false;
  code:
    | "invalid_event_id"
    | "invalid_film_id"
    | "invalid_territory_code"
    | "territory_code_required_when_withheld"
    | "no_withholding_rate_for_territory"
    | "invalid_gross_micros"
    | "unsupported_currency"
    | "fx_conversion_failed";
  message: string;
};

export type TerritoryWithholdingSuccess = {
  ok: true;
  computation: FilmTerritoryWithholdingComputation;
};

function isIsoTerritoryCode(value: string): boolean {
  return /^[A-Z]{2}$/.test(value);
}

/**
 * Computes ONE film line's foreign withholding — the per-line, pre-conversion
 * record. Order is the canon: the rate lookup runs against the SOURCE
 * currency amount (exact bigint micros, floor of the bps share), and only
 * then do the source amounts convert into base currency. The computation
 * logs rate and amount either way; a not-withheld line logs rate 0 with a
 * null version (the rate table was never consulted).
 *
 * Fail-closed: a withheld line with a blank territory, an unknown territory,
 * or a territory outside every effective rate version refuses (no guessed
 * rate); an unsupported currency or failed conversion refuses (the line
 * quarantines in its queue row — never rounded, never silently dropped).
 * Pure.
 */
export function computeFilmTerritoryWithholding(
  input: TerritoryWithholdingLineInput,
  baseCurrency: string,
  convert: TerritorialFxConvert,
): TerritoryWithholdingSuccess | TerritoryWithholdingFailure {
  if (input.event_id.trim() === "") {
    return { ok: false, code: "invalid_event_id", message: "A withholding record keys on its content-derived event id." };
  }
  if (input.film_id.trim() === "") {
    return { ok: false, code: "invalid_film_id", message: "A withholding record names its film." };
  }
  const territory = input.territory_code.trim().toUpperCase();
  if (!isIsoTerritoryCode(territory)) {
    return {
      ok: false,
      code: "invalid_territory_code",
      message: `territory_code "${input.territory_code}" is not an ISO 3166-1 alpha-2 code.`,
    };
  }
  if (input.gross_source_micros < 0n) {
    return { ok: false, code: "invalid_gross_micros", message: "A film line's gross micros are non-negative." };
  }

  // --- The withholding, on the SOURCE amount, BEFORE conversion. Zero when
  // the flag is unset (the tax authority took nothing at source).
  let rateBps = 0;
  let rateVersion: string | null = null;
  let withheldSourceMicros = 0n;
  if (input.foreign_tax_withheld) {
    const rate = foreignWithholdingRateForTerritory(territory, input.period_first_day);
    if (rate === undefined) {
      return {
        ok: false,
        code: "no_withholding_rate_for_territory",
        message: `foreign_tax_withheld is set but territory "${territory}" has no effective withholding rate version — fail closed, no guessed rate.`,
      };
    }
    rateBps = rate.rate_bps;
    rateVersion = rate.version;
    withheldSourceMicros = (input.gross_source_micros * BigInt(rateBps)) / BigInt(BPS_DENOMINATOR);
  }
  const netSourceMicros = input.gross_source_micros - withheldSourceMicros;

  // --- THEN the conversion. The gross and the withheld convert separately
  // (the log carries both); the net is their difference so the cents
  // conserve exactly through the floor — the ledger never invents money.
  const grossSourceCents = Number(input.gross_source_micros / MICROS_PER_CENT);
  if (!Number.isSafeInteger(grossSourceCents) || grossSourceCents < 0) {
    return { ok: false, code: "invalid_gross_micros", message: "The line's gross micros exceed the safe integer-cent range." };
  }
  const withheldSourceCents = Number(withheldSourceMicros / MICROS_PER_CENT);
  const grossConverted = convert(grossSourceCents, input.source_currency);
  if (!grossConverted.ok) {
    return { ok: false, code: "unsupported_currency", message: grossConverted.message };
  }
  const withheldConverted =
    withheldSourceCents > 0 ? convert(withheldSourceCents, input.source_currency) : { ok: true as const, convertedAmountCents: 0, fxRateMicros: grossConverted.fxRateMicros };
  if (!withheldConverted.ok) {
    return { ok: false, code: "unsupported_currency", message: withheldConverted.message };
  }

  return {
    ok: true,
    computation: {
      event_id: input.event_id,
      film_id: input.film_id,
      territory_code: territory,
      foreign_tax_withheld: input.foreign_tax_withheld,
      withholding_rate_bps: rateBps,
      rate_table_version: rateVersion,
      source_currency: input.source_currency,
      gross_source_micros: input.gross_source_micros.toString(),
      withheld_source_micros: withheldSourceMicros.toString(),
      net_source_micros: netSourceMicros.toString(),
      base_currency: baseCurrency,
      fx_rate_micros: grossConverted.fxRateMicros,
      gross_base_cents: grossConverted.convertedAmountCents,
      withheld_base_cents: withheldConverted.convertedAmountCents,
      net_base_cents: grossConverted.convertedAmountCents - withheldConverted.convertedAmountCents,
    },
  };
}

// ---------------------------------------------------------------------------
// Territory-partitioned waterfall envelopes.
// ---------------------------------------------------------------------------

/** One territory's receipt — one envelope input row per territory. */
export interface TerritoryReceiptInput {
  territory_code: string;
  /** The territory's remitted gross for this routing, integer cents (post-withholding remittance). */
  amount_cents: number;
  /** The territory's own cumulative gross — the FDG trigger reads THIS territory only. */
  cumulative_gross_cents: number;
}

/** One territory's routing outcome — the envelope and its own cascade. */
export interface TerritoryEnvelopeRouting {
  territory_code: string;
  gross_cents: number;
  /** The cascade run ONLY on this territory's money with ONLY its paid state. */
  routing: WaterfallRouting;
}

/** The summed reporting totals — the ONLY place envelopes add. */
export interface TerritoryReportingTotals {
  gross_cents: number;
  fdg_bypass_cents: number;
  routed_cents: number;
  unpaid_total_cents: number;
  dust_cents: number;
  profit_pool_cents: number;
}

export interface TerritoryWaterfallReport {
  ok: true;
  /** One envelope per input territory, territory-code order. */
  envelopes: TerritoryEnvelopeRouting[];
  /** The summed reporting view — never a routing input. */
  totals: TerritoryReportingTotals;
}

export type TerritoryRoutingFailure = {
  ok: false;
  code:
    | "duplicate_territory_receipt"
    | "invalid_territory_receipt"
    | "invalid_paid_state";
  message: string;
};

/**
 * Routes every territory's money through its OWN envelope: the deal routes
 * once per territory (routeWaterfallTransaction, the PR 8 pure router) with
 * that territory's own cumulative gross (its own FDG trigger) and its own
 * paid state (its own carry). Recoupment and expense nets are computed per
 * territory; the returned totals are the summed REPORTING view and nothing
 * else — no pooled routing exists for a caller to reach for.
 *
 * Fail-closed: one receipt row per territory (duplicates refuse — the caller
 * aggregates repeated remittances into the envelope's single input row);
 * every amount a safe non-negative integer; paid states non-negative. Pure.
 */
export function routeTerritoryWaterfalls(
  definition: FilmWaterfallDefinition,
  receipts: readonly TerritoryReceiptInput[],
  paidByTerritory: Readonly<Record<string, WaterfallPaidState>> = {},
): TerritoryWaterfallReport | TerritoryRoutingFailure {
  const seen = new Set<string>();
  for (const receipt of receipts) {
    if (
      typeof receipt.territory_code !== "string" ||
      !isIsoTerritoryCode(receipt.territory_code.trim().toUpperCase())
    ) {
      return {
        ok: false,
        code: "invalid_territory_receipt",
        message: `Territory receipt "${receipt.territory_code}" is not an ISO 3166-1 alpha-2 code.`,
      };
    }
    const territory = receipt.territory_code.trim().toUpperCase();
    if (seen.has(territory)) {
      return {
        ok: false,
        code: "duplicate_territory_receipt",
        message: `Territory "${territory}" appears more than once — aggregate repeated remittances into one envelope input row.`,
      };
    }
    if (!Number.isSafeInteger(receipt.amount_cents) || receipt.amount_cents < 0) {
      return {
        ok: false,
        code: "invalid_territory_receipt",
        message: `Territory "${territory}" gross ${receipt.amount_cents} is not a safe non-negative integer.`,
      };
    }
    if (!Number.isSafeInteger(receipt.cumulative_gross_cents) || receipt.cumulative_gross_cents < 0) {
      return {
        ok: false,
        code: "invalid_territory_receipt",
        message: `Territory "${territory}" cumulative gross ${receipt.cumulative_gross_cents} is not a safe non-negative integer.`,
      };
    }
    seen.add(territory);
  }
  for (const [territory, paid] of Object.entries(paidByTerritory)) {
    for (const [legId, paidCents] of Object.entries(paid)) {
      if (!Number.isSafeInteger(paidCents) || paidCents < 0) {
        return {
          ok: false,
          code: "invalid_paid_state",
          message: `Paid state for territory "${territory}" leg "${legId}" (${paidCents}) is not a safe non-negative integer.`,
        };
      }
    }
  }

  const envelopes: TerritoryEnvelopeRouting[] = receipts
    .map((receipt) => {
      const territory = receipt.territory_code.trim().toUpperCase();
      const routing = routeWaterfallTransaction(
        definition,
        receipt.amount_cents,
        receipt.cumulative_gross_cents,
        paidByTerritory[territory] ?? {},
      );
      return { territory_code: territory, gross_cents: receipt.amount_cents, routing };
    })
    .sort((a, b) => (a.territory_code < b.territory_code ? -1 : a.territory_code > b.territory_code ? 1 : 0));

  const totals: TerritoryReportingTotals = {
    gross_cents: envelopes.reduce((total, envelope) => total + envelope.gross_cents, 0),
    fdg_bypass_cents: envelopes.reduce((total, envelope) => total + envelope.routing.fdg_bypass_cents, 0),
    routed_cents: envelopes.reduce((total, envelope) => total + envelope.routing.tier_allocations.reduce((sum, tier) => sum + tier.amount_cents, 0), 0),
    unpaid_total_cents: envelopes.reduce((total, envelope) => total + envelope.routing.unpaid_total_cents, 0),
    dust_cents: envelopes.reduce((total, envelope) => total + envelope.routing.dust_cents, 0),
    profit_pool_cents: envelopes.reduce((total, envelope) => total + envelope.routing.profit_pool_cents, 0),
  };

  return { ok: true, envelopes, totals };
}

// ---------------------------------------------------------------------------
// The cross-collateralization firewall — default-deny, CAMA-permitted sweep.
// ---------------------------------------------------------------------------

/**
 * The signed CAMA's cross-collateralization terms. DEFAULT-DENY: the flag is
 * fail-closed on anything but explicit true, and the agreement of record
 * must be named — an override with no paper behind it is not an override.
 */
export interface CrossCollateralizationTerms {
  /** The signed CAMA agreement ref — non-empty (the release's own evidence). */
  cama_agreement_ref: string;
  /** Explicit override flag — absent/false keeps the firewall up. */
  cross_collateralization_permitted: boolean;
}

/** One cross-territorial application — the audit record of money that crossed. */
export interface TerritoryCrossApplication {
  /** The territory whose obligation drew. */
  debtor_territory: string;
  /** The territory whose profit pool funded it. */
  creditor_territory: string;
  /** The debtor's obligation leg the application satisfied. */
  debtor_leg_id: string;
  /** Exact integer cents that crossed. */
  applied_cents: number;
}

export type CrossCollateralizationFailure = {
  ok: false;
  code:
    | "cama_agreement_ref_required"
    | "cross_collateralization_denied"
    | "no_creditor_residue";
  message: string;
};

export type CrossCollateralizationResult = {
  ok: true;
  /** Every application in deterministic order — debtor territory order, then leg order, then creditor order. */
  applications: TerritoryCrossApplication[];
  /** Total cents that crossed territories (conserved with the applications). */
  applied_total_cents: number;
  /** The honest carry after the sweep: the debtors' remaining unpaid. */
  remaining_unpaid_cents: number;
  /** The CAMA terms honored (the release stamps these on the distribution record). */
  terms: CrossCollateralizationTerms;
};

/** One debtor obligation's carry against the sweep — the walk's input row. */
export interface DebtorObligationCarry {
  territory_code: string;
  leg_id: string;
  unpaid_cents: number;
}

/**
 * The FIREWALL and the CAMA override in one gate.
 *
 * Called with a territory report whose envelopes carry honest per-territory
 * shortfalls (unpaid obligations from their own routing) and the debtors'
 * obligation carry, it answers the founder's question: may Territory A's
 * shortfall draw on Territory B's money?
 *
 *   - DEFAULT (no terms, permitted false, agreement ref blank): DENIED. The
 *     refusal names the debtor and the creditor candidates — the firewall is
 *     the answer, and nothing crosses.
 *   - CAMA-permitted: the sweep runs, but ONLY against creditors' tier-5
 *     residue (the profit pool — money already past every obligation). A
 *     creditor's senior-tier money (its debt balances included) is
 *     structurally unreachable: the sweep's funding source is the profit
 *     pool total alone. Applications are deterministic — debtors in
 *     territory order, each debtor's legs in routing order, creditors in
 *     territory order, each creditor's residue consumed sequentially — and
 *     conserve to the cent.
 *
 * A no-op when no debtor carries a shortfall (the gate has nothing to
 * answer and the CAMA terms are never even consulted — honoring the
 * override and needing it are different facts). Pure.
 */
export function applyCrossCollateralization(
  report: TerritoryWaterfallReport,
  debtors: readonly DebtorObligationCarry[],
  terms: CrossCollateralizationTerms | null,
): CrossCollateralizationResult | CrossCollateralizationFailure {
  const carries = debtors.filter((carry) => carry.unpaid_cents > 0);
  if (carries.length === 0) {
    return { ok: true, applications: [], applied_total_cents: 0, remaining_unpaid_cents: 0, terms: terms ?? { cama_agreement_ref: "", cross_collateralization_permitted: false } };
  }

  if (terms === null) {
    const debtorList = [...new Set(carries.map((carry) => carry.territory_code))].sort().join(", ");
    const creditorList = report.envelopes.map((envelope) => envelope.territory_code).sort().join(", ");
    return {
      ok: false,
      code: "cross_collateralization_denied",
      message: `Cross-collateralization firewall: territory [${debtorList}] carries unpaid obligations and may not draw on territory [${creditorList}] money — no cross-collateralization terms exist, so the firewall is up by default.`,
    };
  }
  if (terms.cama_agreement_ref.trim() === "") {
    return {
      ok: false,
      code: "cama_agreement_ref_required",
      message: "A cross-collateralization override requires the signed CAMA agreement of record — no paper, no override.",
    };
  }
  if (terms.cross_collateralization_permitted !== true) {
    const debtorList = [...new Set(carries.map((carry) => carry.territory_code))].sort().join(", ");
    const creditorList = report.envelopes.map((envelope) => envelope.territory_code).sort().join(", ");
    return {
      ok: false,
      code: "cross_collateralization_denied",
      message: `Cross-collateralization firewall: territory [${debtorList}] carries unpaid obligations and may not draw on territory [${creditorList}] money — the signed CAMA does not explicitly permit cross-collateralization.`,
    };
  }

  // The creditors' funding source: tier-5 residue ONLY (the profit pool, the
  // money already past every obligation — senior-tier money is unreachable).
  const residueByTerritory = new Map<string, number>(
    report.envelopes.map((envelope) => [envelope.territory_code, envelope.routing.profit_pool_cents]),
  );

  // Deterministic order: debtors by territory then leg; creditors by territory.
  const orderedDebtors = [...carries].sort(
    (a, b) =>
      a.territory_code.localeCompare(b.territory_code) ||
      a.leg_id.localeCompare(b.leg_id),
  );
  const applications: TerritoryCrossApplication[] = [];
  let appliedTotal = 0;
  for (const carry of orderedDebtors) {
    let remaining = carry.unpaid_cents;
    const creditorTerritories = [...report.envelopes]
      .map((envelope) => envelope.territory_code)
      .filter((territory) => territory !== carry.territory_code)
      .sort();
    for (const creditor of creditorTerritories) {
      if (remaining === 0) break;
      const residue = residueByTerritory.get(creditor) ?? 0;
      if (residue <= 0) continue;
      const applied = Math.min(remaining, residue);
      residueByTerritory.set(creditor, residue - applied);
      applications.push({
        debtor_territory: carry.territory_code,
        creditor_territory: creditor,
        debtor_leg_id: carry.leg_id,
        applied_cents: applied,
      });
      appliedTotal += applied;
      remaining -= applied;
    }
    // A debtor no creditor could fund keeps its shortfall honestly — the
    // sweep never invents money, and the caller's carry records the rest.
  }

  if (appliedTotal === 0) {
    return {
      ok: false,
      code: "no_creditor_residue",
      message: "The CAMA permits cross-collateralization but no creditor territory holds tier-5 residue to draw — nothing crossed.",
    };
  }

  const remainingUnpaid = carries.reduce((total, carry) => total + carry.unpaid_cents, 0) - appliedTotal;
  return {
    ok: true,
    applications,
    applied_total_cents: appliedTotal,
    remaining_unpaid_cents: remainingUnpaid,
    terms,
  };
}

// ---------------------------------------------------------------------------
// The isolation verifier — the firewall's exact proof.
// ---------------------------------------------------------------------------

export type TerritoryIsolationViolation = {
  ok: false;
  code: "territory_isolation_violation";
  territory_code: string;
  leg_id: string;
  message: string;
};

export type TerritoryIsolationProof = {
  ok: true;
  message: string;
};

/**
 * Proves an applied multi-territory routing is genuinely territory-partitioned:
 * every envelope must reproduce EXACTLY — leg for leg, cent for cent — the
 * pure per-territory recomputation from the territory's OWN gross, its OWN
 * cumulative state, and ITS paid state alone. A pooled allocation (territories
 * summed, one cascade over the pool, obligations drawing across) cannot match
 * the recomputation: the first divergent leg names the territory and the leg,
 * and the firewall holds. The proof is exact, not procedural. Pure.
 */
export function verifyTerritoryIsolation(
  definition: FilmWaterfallDefinition,
  receipts: readonly TerritoryReceiptInput[],
  paidByTerritory: Readonly<Record<string, WaterfallPaidState>>,
  applied: readonly TerritoryEnvelopeRouting[],
): TerritoryIsolationProof | TerritoryIsolationViolation {
  const recomputed = routeTerritoryWaterfalls(definition, receipts, paidByTerritory);
  if (!recomputed.ok) {
    return {
      ok: false,
      code: "territory_isolation_violation",
      territory_code: "",
      leg_id: "",
      message: `Isolation proof could not recompute the envelopes: ${recomputed.message}`,
    };
  }
  const appliedByTerritory = new Map(applied.map((envelope) => [envelope.territory_code, envelope]));
  for (const expected of recomputed.envelopes) {
    const found = appliedByTerritory.get(expected.territory_code);
    if (found === undefined) {
      return {
        ok: false,
        code: "territory_isolation_violation",
        territory_code: expected.territory_code,
        leg_id: "",
        message: `Territory "${expected.territory_code}" has no applied envelope — the applied routing dropped a territory.`,
      };
    }
    const divergence = firstLegDivergence(expected.routing.legs, found.routing.legs);
    if (divergence !== null) {
      return {
        ok: false,
        code: "territory_isolation_violation",
        territory_code: expected.territory_code,
        leg_id: divergence.leg_id,
        message: `Territory "${expected.territory_code}" leg "${divergence.leg_id}" does not reproduce from its own envelope alone (${divergence.detail}) — a pooled or cross-territorial allocation cannot pass the firewall.`,
      };
    }
    if (found.gross_cents !== expected.gross_cents) {
      return {
        ok: false,
        code: "territory_isolation_violation",
        territory_code: expected.territory_code,
        leg_id: "",
        message: `Territory "${expected.territory_code}" gross ${found.gross_cents} does not match its receipt ${expected.gross_cents} — an envelope cannot route money it does not own.`,
      };
    }
  }
  for (const territory of appliedByTerritory.keys()) {
    if (!recomputed.envelopes.some((envelope) => envelope.territory_code === territory)) {
      return {
        ok: false,
        code: "territory_isolation_violation",
        territory_code: territory,
        leg_id: "",
        message: `Applied envelope "${territory}" has no input receipt — an envelope cannot exist without its territory's money.`,
      };
    }
  }
  return {
    ok: true,
    message: `Every territory's routing reproduces exactly from its own envelope alone (${recomputed.envelopes.length} territories, ${recomputed.totals.routed_cents} routed cents) — no cross-territorial siphon.`,
  };
}

/** The first divergent leg — demand, routed, unpaid, and cumulative all compared. Pure. */
function firstLegDivergence(
  expected: readonly WaterfallLegRouting[],
  applied: readonly WaterfallLegRouting[],
): { leg_id: string; detail: string } | null {
  if (expected.length !== applied.length) {
    return { leg_id: "", detail: `leg count ${applied.length} !== ${expected.length}` };
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedLeg = expected[index]!;
    const appliedLeg = applied[index]!;
    if (
      expectedLeg.leg_id !== appliedLeg.leg_id ||
      expectedLeg.demand_cents !== appliedLeg.demand_cents ||
      expectedLeg.routed_cents !== appliedLeg.routed_cents ||
      expectedLeg.unpaid_cents !== appliedLeg.unpaid_cents ||
      expectedLeg.cumulative_paid_cents !== appliedLeg.cumulative_paid_cents
    ) {
      return {
        leg_id: expectedLeg.leg_id,
        detail: `routed ${appliedLeg.routed_cents} !== ${expectedLeg.routed_cents} (demand ${appliedLeg.demand_cents} !== ${expectedLeg.demand_cents}, unpaid ${appliedLeg.unpaid_cents} !== ${expectedLeg.unpaid_cents}, cumulative ${appliedLeg.cumulative_paid_cents} !== ${expectedLeg.cumulative_paid_cents})`,
      };
    }
  }
  return null;
}
