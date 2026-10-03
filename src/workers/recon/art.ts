/**
 * CVT recon worker — the art-market lane's pure money engine (PR 28, the
 * founder art directive: the ARR resale calculator + gallery and fabrication
 * waterfalls). The store-touching passes live in artQueue.ts / artPosting.ts
 * and the cascade module (src/lib/server/artMarketCascade.ts); this module is
 * the math and the identity spaces — no store, no clock, no IO — the same
 * discipline as the books, merch, webtoon, livestream, and gaming engines.
 *
 * House rules, restated as the module's contract:
 * - DETERMINISTIC BIGINT INTEGER MATH ONLY — the 1e-8 micros fixed-point
 *   discipline; a float anywhere in this file is a bug.
 * - SUB-CENT RESIDUE NEVER ROUNDS UP — every division floors; the ledger
 *   never invents money.
 * - FAIL-CLOSED — any row the lane cannot fully verify is a typed rejection
 *   at parse time (the profiles) or a refused post (the posting pass);
 *   nothing defaults to allowing.
 *
 * The money models the directive pins:
 *
 *   1. PRIMARY GALLERY SALE — a gallery invoice row's net artist realized
 *      payout is the sale price minus the gallery commission minus the
 *      production, framing, and shipping COGS. The commission is a recorded
 *      rate inside the 40–50% founder band (validated at parse); the COGS
 *      legs ride the row verbatim. The commission never rounds up into the
 *      gallery's take. A negative result means the row's cost legs outrun
 *      its price — the posting pass refuses it (an operator quarantine,
 *      never a negative settlement).
 *
 *   2. ARR / DROIT DE SUITE — a secondary resale in a qualifying EU/UK
 *      jurisdiction earns the statutory sliding scale on the resale price
 *      NET of cross-border VAT (the tax never enters the royalty basis).
 *      The scale is PORTION-based: each euro portion of the price pays its
 *      own tier's rate — 4% up to €50,000, 3% to €200,000, 1% to €350,000,
 *      0.5% to €500,000, 0.25% above — so a boundary price computes the
 *      same royalty whether it arrives at one cent below or the tier break
 *      exactly. Import/export duties offset AGAINST the computed royalty
 *      (floored at zero — a duty never turns the artist's royalty
 *      negative); both tax legs ride the row verbatim. The scale is
 *      EUR-denominated by statute — the profile rejects non-EUR resale
 *      rows rather than inventing an FX opinion. Non-qualifying
 *      jurisdictions (no statutory resale right in this system) compute a
 *      zero royalty — recorded, never released.
 *
 *   3. SEQUENTIAL FABRICATION DEBT RECOUPMENT — an edition's (or a
 *      sculpture's) registered fabrication pools recoup in sequence order:
 *      100% of the sale's net flows to recoupment until every pool clears,
 *      and the FIRST excess cent after the last pool's clearance is where
 *      the standard net percentage splits begin (the books' advance
 *      switchover discipline, applied to fabrication debts). Print
 *      editions key master-printmaker and lithographer costs; sculpture
 *      fabrications key bronze-foundry and 3D-printing bills. The two pool
 *      classes are isolated — an edition sale can never recoup a sculpture
 *      foundry bill and vice versa (the webtoon print/coin rule, applied
 *      to art).
 *
 *   4. MUSEUM LICENSING ISOLATION — a reproduction_license_fee row's net
 *      is the license fee minus the copyright agency's collection fee
 *      (ARS/DACS, 15–20% founder band, configurable per agency). The net
 *      posts through the Don Ledger's holding seam in its own event space;
 *      it never mixes with physical piece sales' money and never recoups
 *      fabrication debts.
 *
 *   5. FOUNDATION/ESTATE AUDITS — attestation facts of record: recorded,
 *      never posted, never recouped, never split.
 *
 * Event-id spaces, content-derived per row identity (the books/webtoon
 * fingerprint discipline — identity, never money): `art:primary:` per
 * (gallery, invoice, artwork), `art:resale:` per (auction house, lot,
 * artwork), `art:edition:` per (shop, order, edition, artwork),
 * `art:licensing:` per (museum, license, artwork), `art:audit:` per
 * (audit entity, audit id). A re-shipped report replays as counted no-ops
 * through the queue's UNIQUE event_id.
 */

import { createHash } from "node:crypto";

import type { ArtLineDetail } from "./records";

/** House micro-dollar scale: 1 unit = 1e8 statement micros (the SDK's 1e-8 space). */
export const MICROS_PER_DOLLAR = 100_000_000n;

/** The gallery-commission band the directive pins: 40–50 percent. */
export const GALLERY_COMMISSION_MIN_BPS = 4_000;
export const GALLERY_COMMISSION_MAX_BPS = 5_000;

/** The copyright agency collection-fee band the directive pins: 15–20 percent. */
export const AGENCY_COLLECTION_FEE_MIN_BPS = 1_500;
export const AGENCY_COLLECTION_FEE_MAX_BPS = 2_000;

/** The fabrication recoupment pool classes — isolated from each other. */
export const ART_RECOUPMENT_POOL_CLASSES = [
  "print_edition_fabrication",
  "sculpture_fabrication",
] as const;
export type ArtRecoupmentPoolClass = (typeof ART_RECOUPMENT_POOL_CLASSES)[number];

export function isArtRecoupmentPoolClass(value: string): value is ArtRecoupmentPoolClass {
  return (ART_RECOUPMENT_POOL_CLASSES as readonly string[]).includes(value);
}

/** The creditor roles a fabrication debt can name (the pool's vocabulary). */
export const ART_CREDITOR_ROLES = [
  "master_printmaker",
  "lithographer",
  "bronze_foundry",
  "three_d_printing",
] as const;
export type ArtCreditorRole = (typeof ART_CREDITOR_ROLES)[number];

export function isArtCreditorRole(value: string): value is ArtCreditorRole {
  return (ART_CREDITOR_ROLES as readonly string[]).includes(value);
}

/** The contributor roles a post-recoupment split schedule can name. */
export const ART_CONTRIBUTOR_ROLES = [
  "artist",
  "gallery",
  "master_printmaker",
  "lithographer",
  "bronze_foundry",
  "three_d_printing",
  "studio_assistant",
  "co_creator",
] as const;
export type ArtContributorRole = (typeof ART_CONTRIBUTOR_ROLES)[number];

export function isArtContributorRole(value: string): value is ArtContributorRole {
  return (ART_CONTRIBUTOR_ROLES as readonly string[]).includes(value);
}

/** The copyright agencies the directive names — the licensing profile's bounded set. */
export const ART_COPYRIGHT_AGENCIES = ["ars", "dacs"] as const;
export type ArtCopyrightAgency = (typeof ART_COPYRIGHT_AGENCIES)[number];

export function isArtCopyrightAgency(value: string): value is ArtCopyrightAgency {
  return (ART_COPYRIGHT_AGENCIES as readonly string[]).includes(value);
}

/** The gallery invoice's piece kinds — the sculpture waterfall's router. */
export const ART_PIECE_KINDS = ["unique_work", "sculpture"] as const;
export type ArtPieceKind = (typeof ART_PIECE_KINDS)[number];

export function isArtPieceKind(value: string): value is ArtPieceKind {
  return (ART_PIECE_KINDS as readonly string[]).includes(value);
}

/** The foundation/estate audit scopes of record. */
export const ART_AUDIT_SCOPES = [
  "print_edition",
  "sculpture_fabrication",
  "museum_licensing",
  "general",
] as const;
export type ArtAuditScope = (typeof ART_AUDIT_SCOPES)[number];

export function isArtAuditScope(value: string): value is ArtAuditScope {
  return (ART_AUDIT_SCOPES as readonly string[]).includes(value);
}

/**
 * The statutory resale-right scale the directive pins, in whole basis
 * points per EUR portion — the EU/UK sliding scale: 4% up to €50,000,
 * tapering to 0.25% above €500,000. The thresholds are cumulative price
 * boundaries in micros (1 euro = 1e8 micros).
 */
export interface ArrStatutoryTier {
  /** The tier's exclusive lower price boundary, in EUR micros. */
  minMicros: bigint;
  /** The tier's exclusive upper price boundary, in EUR micros (null = unbounded). */
  maxMicros: bigint | null;
  /** The tier's rate, in whole basis points of the portion inside it. */
  rateBps: number;
}

export const ARR_STATUTORY_TIERS: readonly ArrStatutoryTier[] = [
  { minMicros: 0n, maxMicros: 50_000n * MICROS_PER_DOLLAR, rateBps: 400 },
  { minMicros: 50_000n * MICROS_PER_DOLLAR, maxMicros: 200_000n * MICROS_PER_DOLLAR, rateBps: 300 },
  {
    minMicros: 200_000n * MICROS_PER_DOLLAR,
    maxMicros: 350_000n * MICROS_PER_DOLLAR,
    rateBps: 100,
  },
  {
    minMicros: 350_000n * MICROS_PER_DOLLAR,
    maxMicros: 500_000n * MICROS_PER_DOLLAR,
    rateBps: 50,
  },
  { minMicros: 500_000n * MICROS_PER_DOLLAR, maxMicros: null, rateBps: 25 },
];

/** The EU member-state resale-right jurisdictions (ISO 3166-1 alpha-2). */
export const ARR_EU_JURISDICTION_CODES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE",
] as const;

/** The UK's resale-right codes — 'UK' and its ISO alpha-2 alias 'GB'. */
export const ARR_UK_JURISDICTION_CODES = ["UK", "GB"] as const;

/**
 * True when the jurisdiction code carries the statutory scale — the EU
 * member states plus the UK. Codes are compared uppercased.
 */
export function isArrJurisdictionCode(code: string): boolean {
  const upper = code.toUpperCase();
  return (
    (ARR_EU_JURISDICTION_CODES as readonly string[]).includes(upper) ||
    (ARR_UK_JURISDICTION_CODES as readonly string[]).includes(upper)
  );
}

/**
 * A well-formed jurisdiction code: two ASCII letters (any ISO 3166-1
 * alpha-2, qualifying or not — the scale lookup decides the royalty).
 */
export function isJurisdictionCodeFormat(code: string): boolean {
  return /^[A-Z]{2}$/.test(code.toUpperCase());
}

// ---------------------------------------------------------------------------
// Parse-time validators (RangeError codes, the books engine's style — the
// profiles catch and re-scope them to the row).
// ---------------------------------------------------------------------------

/** A positive money cell — sale/fee rows carry revenue; zero and negative are hostile. */
export function validateArtPositiveMicros(micros: bigint, what: string, rowNumber: number): bigint {
  if (micros <= 0n) {
    throw new RangeError(`invalid_money:${what}:${micros}:row_${rowNumber}`);
  }
  return micros;
}

/**
 * The gallery-commission band — an invoice row whose commission falls
 * outside the 40–50% founder band is hostile (a mis-keyed rate or a fee
 * posing as a commission); fail closed at parse.
 */
export function validateGalleryCommissionBps(bps: number, rowNumber: number): number {
  if (
    !Number.isInteger(bps) ||
    bps < GALLERY_COMMISSION_MIN_BPS ||
    bps > GALLERY_COMMISSION_MAX_BPS
  ) {
    throw new RangeError(`gallery_commission_out_of_band:${bps}:row_${rowNumber}`);
  }
  return bps;
}

/**
 * The copyright agency collection-fee band — a licensing row whose agency
 * fee falls outside the 15–20% founder band is hostile; fail closed at
 * parse. The per-agency POLICY of record (the cascade's configurable
 * upsert) is separately validated at registration with the same band.
 */
export function validateAgencyCollectionFeeBps(bps: number, rowNumber: number): number {
  if (
    !Number.isInteger(bps) ||
    bps < AGENCY_COLLECTION_FEE_MIN_BPS ||
    bps > AGENCY_COLLECTION_FEE_MAX_BPS
  ) {
    throw new RangeError(`agency_collection_fee_out_of_band:${bps}:row_${rowNumber}`);
  }
  return bps;
}

/** A positive whole-units cell — print shop rows ship edition copies. */
export function validateArtUnits(units: number, rowNumber: number): number {
  if (!Number.isInteger(units) || units <= 0) {
    throw new RangeError(`invalid_art_units:${units}:row_${rowNumber}`);
  }
  return units;
}

/**
 * The resale profile's currency firewall — the statutory scale is
 * EUR-denominated; a non-EUR resale row is rejected rather than converted
 * (the lane never invents an FX opinion).
 */
export function validateResaleCurrency(currency: string, rowNumber: number): "EUR" {
  if (currency !== "EUR") {
    throw new RangeError(`resale_currency_not_eur:${currency}:row_${rowNumber}`);
  }
  return "EUR";
}

// ---------------------------------------------------------------------------
// 1 · Primary gallery sale — sale price − gallery commission − production
// COGS − framing COGS − shipping COGS = net artist realized payout.
// ---------------------------------------------------------------------------

/**
 * The gallery commission's exact amount — floor(sale price × bps / 10_000)
 * in micros; the commission never rounds up into the gallery's take.
 */
export function galleryCommissionMicros(salePriceMicros: bigint, galleryCommissionBps: number): bigint {
  return (salePriceMicros * BigInt(galleryCommissionBps)) / 10_000n;
}

/**
 * The primary gallery sale equation, term for term the directive's: sale
 * price − gallery commission − production COGS − framing COGS − shipping
 * COGS. Every leg is the row's own recorded cell. A negative result means
 * the row's cost legs exceed its price — the posting pass refuses it (an
 * operator quarantine, never a negative settlement).
 */
export function galleryPrimarySaleNetMicros(
  detail: ArtLineDetail & { kind: "gallery_primary_sale" },
): bigint {
  const salePriceMicros = BigInt(detail.salePriceMicros);
  return (
    salePriceMicros -
    galleryCommissionMicros(salePriceMicros, detail.galleryCommissionBps) -
    BigInt(detail.productionCogsMicros) -
    BigInt(detail.framingCogsMicros) -
    BigInt(detail.shippingCogsMicros)
  );
}

// ---------------------------------------------------------------------------
// 2 · ARR / droit de suite — the portion-based sliding scale on the resale
// price net of cross-border VAT; duties offset the royalty, floored at zero.
// ---------------------------------------------------------------------------

/** The portion-based scale royalty for one EUR basis, exact micros: each
 * portion of the basis pays its own tier's rate, floored per tier. */
export function arrSlidingScaleRoyaltyMicros(basisMicros: bigint): bigint {
  if (basisMicros < 0n) {
    throw new RangeError(`arr_basis_negative:${basisMicros}`);
  }
  let royalty = 0n;
  for (const tier of ARR_STATUTORY_TIERS) {
    if (basisMicros <= tier.minMicros) break;
    const portion =
      tier.maxMicros === null || basisMicros < tier.maxMicros
        ? basisMicros - tier.minMicros
        : tier.maxMicros - tier.minMicros;
    royalty += (portion * BigInt(tier.rateBps)) / 10_000n;
  }
  return royalty;
}

/** The royalty basis — the resale price net of cross-border VAT. A VAT leg
 * larger than the price is hostile; the profile rejects it at parse. */
export function arrRoyaltyBasisMicros(
  detail: ArtLineDetail & { kind: "auction_resale" },
): bigint {
  const basis = BigInt(detail.hammerPriceMicros) - BigInt(detail.crossBorderVatMicros);
  if (basis <= 0n) {
    throw new RangeError(`arr_basis_not_positive:${basis}`);
  }
  return basis;
}

/**
 * The secondary resale's release, term for term the directive's: the
 * sliding-scale royalty on the price net of cross-border VAT, minus the
 * import/export duty, floored at zero — a duty larger than the royalty
 * exhausts it and never turns the artist's release negative. Both tax legs
 * ride the row verbatim; the offsetting happens BEFORE the net secondary
 * royalty releases.
 */
export function arrNetReleaseMicros(detail: ArtLineDetail & { kind: "auction_resale" }): {
  /** The computed sliding-scale royalty (pre-duty). */
  royaltyMicros: bigint;
  /** The royalty after the duty offset — the release, floored at zero. */
  releaseMicros: bigint;
  /** The royalty basis (price net of VAT). */
  basisMicros: bigint;
} {
  const basisMicros = arrRoyaltyBasisMicros(detail);
  const royaltyMicros = arrSlidingScaleRoyaltyMicros(basisMicros);
  const dutyMicros = BigInt(detail.importExportDutyMicros);
  const releaseMicros = royaltyMicros > dutyMicros ? royaltyMicros - dutyMicros : 0n;
  return { royaltyMicros, releaseMicros, basisMicros };
}

// ---------------------------------------------------------------------------
// 3 · Sequential fabrication debt recoupment — pools fill in sequence order,
// 100% of the net flows until every debt clears, the first excess cent is
// the splits' basis. (The books' advance switchover discipline, applied to
// fabrication debts; the pool classes stay isolated.)
// ---------------------------------------------------------------------------

/**
 * One pool's recoupment application — the caller persists it through the
 * store's append-only application ledger (UNIQUE per (pool_id,
 * source_event_id) replay guard, UNIQUE per (pool_id, recouped_before_cents)
 * position lock).
 */
export interface SequentialDebtApplication {
  poolId: string;
  poolSequence: number;
  /** The pool's recouped position the instant before this application. */
  recoupedBeforeMicros: bigint;
  /** The integer micros of revenue applied this application. */
  appliedMicros: bigint;
  /** The integer micros of the pool still open after this application. */
  remainingMicros: bigint;
}

/**
 * The sequential debt recoupment for one sale event's net, against the
 * pools' CURRENT derived positions (the caller computes each pool's
 * recouped position as the sum of its append-only applications). The
 * switchover is exact — the clearing event keeps its remainder as the
 * splits' basis. A negative or zero net applies nothing (the splits' basis
 * is the net itself when no debt remains).
 */
export function sequentialDebtRecoupment(
  pools: ReadonlyArray<{
    id: string;
    sequenceNo: number;
    debtMicros: bigint;
    recoupedMicros: bigint;
  }>,
  saleNetMicros: bigint,
): { applications: SequentialDebtApplication[]; excessMicros: bigint } {
  if (saleNetMicros < 0n) {
    throw new RangeError(`recoupment_net_negative:${saleNetMicros}`);
  }
  const applications: SequentialDebtApplication[] = [];
  let remaining = saleNetMicros;
  for (const pool of [...pools].sort((a, b) => a.sequenceNo - b.sequenceNo)) {
    if (remaining === 0n) break;
    const open = pool.debtMicros - pool.recoupedMicros;
    if (open <= 0n) continue;
    const applied = remaining < open ? remaining : open;
    applications.push({
      poolId: pool.id,
      poolSequence: pool.sequenceNo,
      recoupedBeforeMicros: pool.recoupedMicros,
      appliedMicros: applied,
      remainingMicros: open - applied,
    });
    remaining -= applied;
  }
  return { applications, excessMicros: remaining };
}

// ---------------------------------------------------------------------------
// 4 · Museum licensing isolation — the license fee net of the copyright
// agency's collection fee.
// ---------------------------------------------------------------------------

/**
 * The agency collection fee's exact amount — floor(license fee × bps /
 * 10_000) in micros; the fee never rounds up into the agency's take.
 */
export function agencyCollectionFeeMicros(
  licenseFeeMicros: bigint,
  agencyCollectionFeeBps: number,
): bigint {
  return (licenseFeeMicros * BigInt(agencyCollectionFeeBps)) / 10_000n;
}

/** The licensing net — the fee minus the agency's collection fee. */
export function museumLicensingNetMicros(
  detail: ArtLineDetail & { kind: "museum_licensing" },
): { feeMicros: bigint; agencyFeeMicros: bigint; netMicros: bigint } {
  const feeMicros = BigInt(detail.licenseFeeMicros);
  const agencyFeeMicros = agencyCollectionFeeMicros(feeMicros, detail.agencyCollectionFeeBps);
  return { feeMicros, agencyFeeMicros, netMicros: feeMicros - agencyFeeMicros };
}

// ---------------------------------------------------------------------------
// Identity — the sha256 content fingerprints (identity fields only, never
// money), one event-id space per row kind.
// ---------------------------------------------------------------------------

/** The sha256 identity fingerprint — identity fields only, never money. */
function artFingerprint(...fields: readonly string[]): string {
  return createHash("sha256").update(fields.join("|")).digest("hex");
}

/** The primary gallery sale's event id — one per (gallery, invoice, artwork). */
export function artPrimaryEventId(detail: ArtLineDetail & { kind: "gallery_primary_sale" }): string {
  return `art:primary:${artFingerprint(detail.galleryId, detail.invoiceId, detail.artworkId)}`;
}

/** The auction resale's event id — one per (auction house, lot, artwork). */
export function artResaleEventId(detail: ArtLineDetail & { kind: "auction_resale" }): string {
  return `art:resale:${artFingerprint(detail.auctionHouse, detail.lotId, detail.artworkId)}`;
}

/** The print shop sale's event id — one per (shop, order, edition, artwork). */
export function artEditionEventId(detail: ArtLineDetail & { kind: "print_shop_sale" }): string {
  return `art:edition:${artFingerprint(detail.shopId, detail.orderId, detail.editionId, detail.artworkId)}`;
}

/** The museum license's event id — one per (museum, license, artwork). */
export function artLicensingEventId(detail: ArtLineDetail & { kind: "museum_licensing" }): string {
  return `art:licensing:${artFingerprint(detail.museumId, detail.licenseId, detail.artworkId)}`;
}

/** The audit's event id — one per (audit entity, audit id). */
export function artAuditEventId(detail: ArtLineDetail & { kind: "foundation_estate_audit" }): string {
  return `art:audit:${artFingerprint(detail.auditEntityId, detail.auditId)}`;
}

/** The content-derived event id per art row kind (identity, never money). */
export function artEventId(detail: ArtLineDetail): string {
  switch (detail.kind) {
    case "gallery_primary_sale":
      return artPrimaryEventId(detail);
    case "auction_resale":
      return artResaleEventId(detail);
    case "print_shop_sale":
      return artEditionEventId(detail);
    case "museum_licensing":
      return artLicensingEventId(detail);
    case "foundation_estate_audit":
      return artAuditEventId(detail);
  }
}
