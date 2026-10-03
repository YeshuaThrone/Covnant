// Focused unit tests for the art-market lane's pure money engine (PR 28) —
// the directive's pinned math the store-backed waterfall tests do not
// isolate: the primary gallery sale equation exact to the cent (the
// 40–50% commission band at its edges), the ARR sliding scale's boundary
// cases at every tier break (4% → 3% → 1% → 0.5% → 0.25%), cross-border
// VAT/duty offsetting before the net secondary royalty releases, the
// sequential fabrication debt recoupment's exact switchover (print
// recoupment BEFORE split; sculpture debt ordering), the museum licensing
// isolation with the agency's 15–20% collection deduction, and the
// content-derived event-id identity spaces.

import { describe, expect, it } from "vitest";
import {
  AGENCY_COLLECTION_FEE_MAX_BPS,
  AGENCY_COLLECTION_FEE_MIN_BPS,
  ARR_STATUTORY_TIERS,
  GALLERY_COMMISSION_MAX_BPS,
  GALLERY_COMMISSION_MIN_BPS,
  MICROS_PER_DOLLAR,
  agencyCollectionFeeMicros,
  arrNetReleaseMicros,
  arrRoyaltyBasisMicros,
  arrSlidingScaleRoyaltyMicros,
  artAuditEventId,
  artEditionEventId,
  artEventId,
  artLicensingEventId,
  artPrimaryEventId,
  artResaleEventId,
  galleryCommissionMicros,
  galleryPrimarySaleNetMicros,
  isArrJurisdictionCode,
  isArtCopyrightAgency,
  isArtCreditorRole,
  isArtRecoupmentPoolClass,
  isJurisdictionCodeFormat,
  museumLicensingNetMicros,
  sequentialDebtRecoupment,
  validateAgencyCollectionFeeBps,
  validateArtPositiveMicros,
  validateGalleryCommissionBps,
  validateResaleCurrency,
} from "../art";
import type { ArtLineDetail } from "../records";

const EURO = MICROS_PER_DOLLAR; // 1 major unit = 1e8 micros, EUR included

function gallerySale(
  overrides: Partial<Extract<ArtLineDetail, { kind: "gallery_primary_sale" }>> = {},
): Extract<ArtLineDetail, { kind: "gallery_primary_sale" }> {
  return {
    kind: "gallery_primary_sale",
    galleryId: "gallery-one",
    invoiceId: "inv-001",
    artworkId: "art-001",
    pieceKind: "unique_work",
    salePriceMicros: "123456000000", // €1,234.56
    galleryCommissionBps: 4_500,
    productionCogsMicros: "100000000", // €1.00
    framingCogsMicros: "50000000", // €0.50
    shippingCogsMicros: "25000000", // €0.25
    period: "2026-10",
    ...overrides,
  };
}

function resale(
  overrides: Partial<Extract<ArtLineDetail, { kind: "auction_resale" }>> = {},
): Extract<ArtLineDetail, { kind: "auction_resale" }> {
  return {
    kind: "auction_resale",
    auctionHouse: "christies",
    lotId: "lot-001",
    artworkId: "art-001",
    saleType: "secondary_resale",
    hammerPriceMicros: (1_000_000n * EURO).toString(), // €1,000,000
    crossBorderVatMicros: "0",
    importExportDutyMicros: "0",
    jurisdictionCode: "FR",
    period: "2026-10",
    ...overrides,
  };
}

function license(
  overrides: Partial<Extract<ArtLineDetail, { kind: "museum_licensing" }>> = {},
): Extract<ArtLineDetail, { kind: "museum_licensing" }> {
  return {
    kind: "museum_licensing",
    museumId: "tate",
    licenseId: "lic-001",
    artworkId: "art-001",
    reproductionType: "exhibition_catalog",
    licenseFeeMicros: (1_000n * EURO).toString(), // €1,000
    agencyCode: "dacs",
    agencyCollectionFeeBps: 1_500,
    period: "2026-10",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1 · Primary gallery sale equation — exact integer micros, term for term
// the directive's: price − commission − production − framing − shipping.
// ---------------------------------------------------------------------------

describe("primary gallery sale equation — exact to the cent", () => {
  it("computes the founder equation term for term", () => {
    // €1,234.56 at 45% = €555.552 exactly (4500 bps of 123,456,000,000
    // micros); net = 1,234.56 − 555.552 − 1.00 − 0.50 − 0.25 = €677.258,
    // exact micros, no floats.
    const detail = gallerySale();
    expect(galleryCommissionMicros(123_456_000_000n, 4_500)).toBe(55_555_200_000n);
    expect(galleryPrimarySaleNetMicros(detail)).toBe(67_725_800_000n);
  });

  it("is exact at the commission band's edges (40% and 50%)", () => {
    // €1,000.00 sale with the fixture's COGS legs (1.00/0.50/0.25):
    // 40% → net €598.25; 50% → net €498.25.
    const base = gallerySale({ salePriceMicros: (1_000n * EURO).toString() });
    expect(galleryPrimarySaleNetMicros({ ...base, galleryCommissionBps: 4_000 })).toBe(59_825_000_000n);
    expect(galleryPrimarySaleNetMicros({ ...base, galleryCommissionBps: 5_000 })).toBe(49_825_000_000n);
  });

  it("floors the commission on a sub-cent price — never rounds up into it", () => {
    // 12,345 micros at 49.99%: 12,345 × 4,999 = 61,712,655; /10,000 →
    // 6,171 (floor of 6,171.2655). The 0.2655-micro residue is the
    // artist's, never the gallery's. COGS legs zeroed so the net isolates
    // the commission arithmetic.
    const price = 12_345n;
    expect(galleryCommissionMicros(price, 4_999)).toBe(6_171n);
    const detail = gallerySale({
      salePriceMicros: price.toString(),
      galleryCommissionBps: 4_999,
      productionCogsMicros: "0",
      framingCogsMicros: "0",
      shippingCogsMicros: "0",
    });
    expect(galleryPrimarySaleNetMicros(detail)).toBe(6_174n);
  });

  it("reports a negative net verbatim when the cost legs outrun the price", () => {
    // The profile records it; the posting pass refuses it — the engine
    // itself must not hide the arithmetic. €1.00 price, 50% commission,
    // €9.00 production + the fixture's €0.50 framing + €0.25 shipping:
    // 1.00 − 0.50 − 9.00 − 0.50 − 0.25 = −€9.25.
    const detail = gallerySale({
      salePriceMicros: "100000000",
      galleryCommissionBps: 5_000,
      productionCogsMicros: "900000000",
    });
    expect(galleryPrimarySaleNetMicros(detail)).toBe(-925_000_000n);
  });
});

// ---------------------------------------------------------------------------
// 2 · ARR sliding scale — the boundary cases at every tier break.
// ---------------------------------------------------------------------------

describe("ARR sliding scale — tier break boundaries", () => {
  const tiers = ARR_STATUTORY_TIERS;

  it("pins the statutory tier table", () => {
    expect(tiers.map((tier) => tier.rateBps)).toEqual([400, 300, 100, 50, 25]);
    expect(tiers.map((tier) => tier.maxMicros === null ? null : tier.maxMicros / EURO))
      .toEqual([50_000n, 200_000n, 350_000n, 500_000n, null]);
  });

  it("charges 4% on the portion up to exactly €50,000", () => {
    expect(arrSlidingScaleRoyaltyMicros(50_000n * EURO)).toBe(2_000n * EURO);
  });

  it("splits the portion at €50,000.01 — the first cent pays 3%", () => {
    // 50,000×4% + 0.01×3% = 2,000 + 0.0003 → the sub-cent floor drops it.
    expect(arrSlidingScaleRoyaltyMicros(50_000n * EURO + 1n)).toBe(2_000n * EURO);
  });

  it("is exact at €50,001 — the first whole euro above the break", () => {
    expect(arrSlidingScaleRoyaltyMicros(50_001n * EURO)).toBe(2_000n * EURO + 3_000_000n);
  });

  it("is exact at the €200,000 and €350,000 breaks", () => {
    expect(arrSlidingScaleRoyaltyMicros(200_000n * EURO)).toBe(6_500n * EURO);
    expect(arrSlidingScaleRoyaltyMicros(350_000n * EURO)).toBe(8_000n * EURO);
  });

  it("is exact at the €500,000 break and above (0.25% taper)", () => {
    expect(arrSlidingScaleRoyaltyMicros(500_000n * EURO)).toBe(8_750n * EURO);
    expect(arrSlidingScaleRoyaltyMicros(1_000_000n * EURO)).toBe(10_000n * EURO);
  });

  it("is exact at the micro floor — the first micro above €350,000", () => {
    // A 1-micro portion at 50 bps = 0.005 micros → the per-tier floor
    // drops it entirely; the royalty stays €8,000.
    expect(arrSlidingScaleRoyaltyMicros(350_000n * EURO + 1n)).toBe(8_000n * EURO);
  });

  it("keeps integral sub-cent portions in micros — €350,001 is exact", () => {
    // €1 of portion at 50 bps = €0.005 = 500,000 micros — exact, kept.
    expect(arrSlidingScaleRoyaltyMicros(350_001n * EURO)).toBe(8_000n * EURO + 500_000n);
  });
});

// ---------------------------------------------------------------------------
// 3 · Cross-border tax offsetting — VAT out of the basis, duty against
// the royalty, floored at zero.
// ---------------------------------------------------------------------------

describe("cross-border VAT and duty offsetting", () => {
  it("excludes the cross-border VAT from the royalty basis", () => {
    // €10,000 hammer with €1,700 VAT → basis €8,300 → 4% royalty €332.
    const detail = resale({
      hammerPriceMicros: (10_000n * EURO).toString(),
      crossBorderVatMicros: (1_700n * EURO).toString(),
    });
    expect(arrRoyaltyBasisMicros(detail)).toBe(8_300n * EURO);
    expect(arrNetReleaseMicros(detail).royaltyMicros).toBe(332n * EURO);
  });

  it("offsets the import/export duty before the net release", () => {
    const detail = resale({
      hammerPriceMicros: (10_000n * EURO).toString(),
      crossBorderVatMicros: (1_700n * EURO).toString(),
      importExportDutyMicros: (100n * EURO).toString(),
    });
    expect(arrNetReleaseMicros(detail).releaseMicros).toBe(232n * EURO);
  });

  it("floors the release at zero when the duty exhausts the royalty", () => {
    const detail = resale({
      hammerPriceMicros: (10_000n * EURO).toString(),
      importExportDutyMicros: (500n * EURO).toString(), // > the €400 royalty
    });
    const outcome = arrNetReleaseMicros(detail);
    expect(outcome.royaltyMicros).toBe(400n * EURO);
    expect(outcome.releaseMicros).toBe(0n);
  });

  it("refuses a resale whose VAT leg eats the whole price", () => {
    const detail = resale({
      hammerPriceMicros: (1_000n * EURO).toString(),
      crossBorderVatMicros: (1_000n * EURO).toString(),
    });
    expect(() => arrRoyaltyBasisMicros(detail)).toThrow(/arr_basis_not_positive/);
  });
});

// ---------------------------------------------------------------------------
// 4 · Print recoupment before split — the sequential debt engine's
// switchover and the founder's example cut.
// ---------------------------------------------------------------------------

describe("print edition recoupment — 100% before split", () => {
  const pools = [
    { id: "pool-master", sequenceNo: 1, debtMicros: 5_000n * EURO, recoupedMicros: 0n }, // master printmaker
    { id: "pool-litho", sequenceNo: 2, debtMicros: 3_000n * EURO, recoupedMicros: 0n }, // lithographer
  ];

  it("applies the full net to the first pool before the second exists", () => {
    const outcome = sequentialDebtRecoupment(pools, 2_000n * EURO);
    expect(outcome.applications).toHaveLength(1);
    expect(outcome.applications[0]).toMatchObject({
      poolId: "pool-master",
      recoupedBeforeMicros: 0n,
      appliedMicros: 2_000n * EURO,
      remainingMicros: 3_000n * EURO,
    });
    expect(outcome.excessMicros).toBe(0n);
  });

  it("recoups pool 1 fully, then pool 2 partially, still no split", () => {
    const outcome = sequentialDebtRecoupment(pools, 6_000n * EURO);
    expect(outcome.applications.map((a) => a.poolId)).toEqual(["pool-master", "pool-litho"]);
    expect(outcome.applications[1]?.appliedMicros).toBe(1_000n * EURO);
    expect(outcome.excessMicros).toBe(0n);
  });

  it("releases the exact excess the instant the last debt clears", () => {
    const outcome = sequentialDebtRecoupment(pools, 8_000n * EURO + 1n);
    expect(outcome.applications).toHaveLength(2);
    expect(outcome.excessMicros).toBe(1n); // the splits' basis
  });

  it("replays nothing on already-recouped pools", () => {
    const outcome = sequentialDebtRecoupment(
      pools.map((pool) => ({ ...pool, recoupedMicros: pool.debtMicros })),
      4_000n * EURO,
    );
    expect(outcome.applications).toHaveLength(0);
    expect(outcome.excessMicros).toBe(4_000n * EURO);
  });
});

// ---------------------------------------------------------------------------
// 5 · Sculpture debt ordering — bronze foundry then 3D printing, in
// sequence, before any studio-assistant release exists.
// ---------------------------------------------------------------------------

describe("sculpture fabrication — sequential debt ordering", () => {
  const pools = [
    { id: "pool-3dp", sequenceNo: 2, debtMicros: 4_000n * EURO, recoupedMicros: 0n }, // 3D printing
    { id: "pool-bronze", sequenceNo: 1, debtMicros: 6_000n * EURO, recoupedMicros: 0n }, // bronze foundry
  ];

  it("recoups in sequence order regardless of the input array's order", () => {
    // The pools arrive 3D-printing-first; the sequence numbers decide.
    const outcome = sequentialDebtRecoupment(pools, 10_000n * EURO);
    expect(outcome.applications.map((a) => a.poolId)).toEqual(["pool-bronze", "pool-3dp"]);
    expect(outcome.applications[0]?.appliedMicros).toBe(6_000n * EURO);
    expect(outcome.applications[1]?.appliedMicros).toBe(4_000n * EURO);
    expect(outcome.excessMicros).toBe(0n);
  });

  it("pays the foundry in full before the printer sees a cent", () => {
    const outcome = sequentialDebtRecoupment(pools, 5_000n * EURO);
    expect(outcome.applications[0]).toMatchObject({
      poolId: "pool-bronze",
      appliedMicros: 5_000n * EURO,
      remainingMicros: 1_000n * EURO,
    });
    expect(outcome.applications).toHaveLength(1); // the printer's pool untouched
    expect(outcome.excessMicros).toBe(0n);
  });

  it("is exact when the sculpture's debts clear mid-event", () => {
    const outcome = sequentialDebtRecoupment(pools, 10_000n * EURO);
    expect(outcome.applications.map((a) => a.poolId)).toEqual(["pool-bronze", "pool-3dp"]);
    expect(outcome.applications[1]?.appliedMicros).toBe(4_000n * EURO);
    expect(outcome.excessMicros).toBe(0n);
    const overflowing = sequentialDebtRecoupment(pools, 12_345n * EURO);
    expect(overflowing.excessMicros).toBe(2_345n * EURO);
  });

  it("applies nothing on a zero net", () => {
    const outcome = sequentialDebtRecoupment(pools, 0n);
    expect(outcome.applications).toHaveLength(0);
    expect(outcome.excessMicros).toBe(0n);
  });

  it("refuses a negative net", () => {
    expect(() => sequentialDebtRecoupment(pools, -1n)).toThrow(/recoupment_net_negative/);
  });
});

// ---------------------------------------------------------------------------
// 6 · Museum licensing isolation — the fee net of the agency's 15–20%
// collection deduction; the band's edges.
// ---------------------------------------------------------------------------

describe("museum licensing — agency fee isolation", () => {
  it("deducts the ARS/DACS collection fee exactly (15% and 20% edges)", () => {
    const fee = 1_000n * EURO;
    expect(agencyCollectionFeeMicros(fee, AGENCY_COLLECTION_FEE_MIN_BPS)).toBe(150n * EURO);
    expect(agencyCollectionFeeMicros(fee, AGENCY_COLLECTION_FEE_MAX_BPS)).toBe(200n * EURO);
  });

  it("returns the fee, the agency take, and the net as separate legs", () => {
    const detail = license({ agencyCollectionFeeBps: 1_750 }); // 17.5%
    const outcome = museumLicensingNetMicros(detail);
    expect(outcome.feeMicros).toBe(1_000n * EURO);
    expect(outcome.agencyFeeMicros).toBe(175n * EURO);
    expect(outcome.netMicros).toBe(825n * EURO);
  });

  it("floors the agency's take on an odd fee — never rounds up into it", () => {
    const detail = license({ licenseFeeMicros: (1_000n * EURO + 3n).toString() });
    const outcome = museumLicensingNetMicros(detail);
    expect(outcome.agencyFeeMicros).toBe(150n * EURO); // the 3-micro residue is the artist's
    expect(outcome.netMicros).toBe(outcome.feeMicros - outcome.agencyFeeMicros);
  });

  it("rejects an agency fee outside the founder band", () => {
    expect(() => validateAgencyCollectionFeeBps(1_499, 1)).toThrow(/agency_collection_fee_out_of_band/);
    expect(() => validateAgencyCollectionFeeBps(2_001, 1)).toThrow(/agency_collection_fee_out_of_band/);
    expect(validateAgencyCollectionFeeBps(1_500, 1)).toBe(1_500);
    expect(validateAgencyCollectionFeeBps(2_000, 1)).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// 7 · Band validators, currencies, jurisdictions — the parse-time fences.
// ---------------------------------------------------------------------------

describe("parse-time validators", () => {
  it("pins the gallery commission band at its edges", () => {
    expect(() => validateGalleryCommissionBps(GALLERY_COMMISSION_MIN_BPS - 1, 1)).toThrow(/gallery_commission_out_of_band/);
    expect(() => validateGalleryCommissionBps(GALLERY_COMMISSION_MAX_BPS + 1, 1)).toThrow(/gallery_commission_out_of_band/);
    expect(validateGalleryCommissionBps(4_000, 1)).toBe(4_000);
    expect(validateGalleryCommissionBps(5_000, 1)).toBe(5_000);
  });

  it("requires exact EUR on resale rows", () => {
    expect(validateResaleCurrency("EUR", 1)).toBe("EUR");
    // Strict — no normalization here; the profile uppercases its cell
    // before the validator sees it.
    expect(() => validateResaleCurrency("eur", 1)).toThrow(/resale_currency_not_eur/);
    expect(() => validateResaleCurrency("GBP", 1)).toThrow(/resale_currency_not_eur/);
    expect(() => validateResaleCurrency("USD", 1)).toThrow(/resale_currency_not_eur/);
  });

  it("accepts the EU and UK resale-right jurisdictions and rejects others", () => {
    expect(isArrJurisdictionCode("FR")).toBe(true);
    expect(isArrJurisdictionCode("de")).toBe(true);
    expect(isArrJurisdictionCode("UK")).toBe(true);
    expect(isArrJurisdictionCode("GB")).toBe(true);
    expect(isArrJurisdictionCode("US")).toBe(false);
    expect(isArrJurisdictionCode("CH")).toBe(false);
    expect(isJurisdictionCodeFormat("US")).toBe(true); // well-formed, non-ARR
    expect(isJurisdictionCodeFormat("U")).toBe(false);
  });

  it("refuses non-positive money", () => {
    expect(() => validateArtPositiveMicros(0n, "sale_price", 1)).toThrow(/invalid_money/);
    expect(() => validateArtPositiveMicros(-5n, "sale_price", 1)).toThrow(/invalid_money/);
    expect(validateArtPositiveMicros(1n, "sale_price", 1)).toBe(1n);
  });

  it("pins the vocabulary guards", () => {
    expect(isArtRecoupmentPoolClass("print_edition_fabrication")).toBe(true);
    expect(isArtRecoupmentPoolClass("sculpture_fabrication")).toBe(true);
    expect(isArtRecoupmentPoolClass("print_advance")).toBe(false); // the books class — never the art lane's
    expect(isArtCreditorRole("bronze_foundry")).toBe(true);
    expect(isArtCreditorRole("artist")).toBe(false); // a contributor role, not a creditor
    expect(isArtCopyrightAgency("ars")).toBe(true);
    expect(isArtCopyrightAgency("adagp")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8 · Event-id identity spaces — one content-derived identity per row
// kind, never colliding across lanes or kinds.
// ---------------------------------------------------------------------------

describe("event-id identity spaces", () => {
  it("keys each row kind into its own sha256 space — identity only, never money", () => {
    expect(artPrimaryEventId(gallerySale())).toMatch(/^art:primary:[0-9a-f]{64}$/);
    expect(artResaleEventId(resale())).toMatch(/^art:resale:[0-9a-f]{64}$/);
    expect(artLicensingEventId(license())).toMatch(/^art:licensing:[0-9a-f]{64}$/);
    expect(
      artEditionEventId({
        kind: "print_shop_sale",
        shopId: "shop-1",
        orderId: "ord-1",
        editionId: "ed-1",
        artworkId: "art-1",
        units: 1,
        grossSaleMicros: "1",
        period: "2026-10",
      }),
    ).toMatch(/^art:edition:[0-9a-f]{64}$/);
    expect(
      artAuditEventId({
        kind: "foundation_estate_audit",
        auditEntityId: "estate-1",
        auditId: "aud-1",
        artworkId: null,
        scope: "general",
        declaredFabricationCostMicros: "0",
        declaredLicenseIncomeMicros: "0",
        period: "2026-10",
      }),
    ).toMatch(/^art:audit:[0-9a-f]{64}$/);
  });

  it("is deterministic on identity and blind to money", () => {
    expect(artPrimaryEventId(gallerySale())).toBe(artPrimaryEventId(gallerySale()));
    // Same identity, different price — the id does not move.
    expect(artPrimaryEventId(gallerySale({ salePriceMicros: "999999999" }))).toBe(
      artPrimaryEventId(gallerySale()),
    );
    // Same identity fields modulo the invoice — the id does.
    expect(artPrimaryEventId(gallerySale({ invoiceId: "inv-002" }))).not.toBe(
      artPrimaryEventId(gallerySale()),
    );
  });

  it("routes the detail union to the right identity space", () => {
    expect(artEventId(gallerySale())).toBe(artPrimaryEventId(gallerySale()));
    expect(artEventId(resale())).toBe(artResaleEventId(resale()));
    expect(artEventId(license())).toBe(artLicensingEventId(license()));
  });
});
