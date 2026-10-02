/**
 * CVT recon worker — the book/magazine lane's pure money engine (PR 26,
 * founder publishing directive: the book POD print parser + editorial split
 * ledger). The store-touching passes live in booksQueue.ts / booksPosting.ts
 * and the cascade module (src/lib/server/bookEditorialCascade.ts); this
 * module is the math and the identity spaces — no store, no clock, no IO —
 * the same discipline as the merch, webtoon, livestream, and gaming engines.
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
 *   1. POD PRINT DEDUCTION — a physical print-on-demand sale row's net
 *      realized royalty is gross retail − base printing COGS × units −
 *      distribution fee − channel discount, where the channel discount is
 *      40–55% of the gross retail (the wholesale band, validated at parse;
 *      keyed on isbn + format_type per row). The legs ride the row verbatim
 *      (the founder's recorded-rate rule); the net is exact bigint micros.
 *
 *   2. E-BOOK AGENCY MODEL — the platform retails at the agency price and
 *      remits a 70% author royalty inside the $2.99–$9.99 tier (INCLUSIVE
 *      at both boundaries), 35% outside it. The tier keys on the row's
 *      recorded list price; the applied rate is recorded per row.
 *
 *   3. ANTHOLOGY PRO-RATA — a titled anthology's net realized royalty splits
 *      across its contributing authors pro-rata by page count or word count
 *      (one basis per schedule, counts positive). Shares floor; the dust is
 *      the visible complement (never rounded into a contributor's credit).
 *
 *   4. MAGAZINE EDITORIAL CUTS — the issue's roster earns its cuts:
 *      flat-per-issue contributors earn their contracted flat cents ONCE per
 *      issue; percentage contributors earn bps of the subscription revenue
 *      per funding event. Mode is per contributor, configurable.
 *
 *   5. SEQUENTIAL ADVANCE RECOUPMENT — a title's advance pools recoup in
 *      sequence order (co-author, then ghostwriter, per the registered
 *      sequence): 100% of the stream's net royalty flows to recoupment
 *      until every pool clears, and the FIRST excess cent after the last
 *      pool's clearance is where the standard net percentage splits begin.
 *      The switchover is exact — the clearing event keeps its remainder as
 *      the splits' basis.
 *
 *   6. AUDIOBOOK POOL ISOLATION — audiobook_production_unrecouped is its
 *      own recoupment pool class: audiobook royalty events recoup ONLY the
 *      audiobook pool; e-book and print events can never cross-
 *      collateralize into it and vice versa (the webtoon print/coin
 *      isolation rule, applied to books).
 *
 * Event-id spaces, content-derived per row identity (the webtoon
 * fingerprint discipline — identity, never money): `book:print:` per
 * (platform, order, isbn, format), `book:ebook:` per (platform, order,
 * isbn), `book:magazine:` per (platform, event id), `book:audio:` per
 * (platform, order, isbn). A re-shipped report replays as counted no-ops
 * through the queue's UNIQUE event_id.
 */

import { createHash } from "node:crypto";

import type { BookLineDetail } from "./records";

/** House micro-dollar scale: 1 dollar = 1e8 statement micros (the SDK's 1e-8 space). */
export const MICROS_PER_DOLLAR = 100_000_000n;

/** The wholesale channel-discount band the directive pins: 40–55 percent. */
export const CHANNEL_DISCOUNT_MIN_BPS = 4_000;
export const CHANNEL_DISCOUNT_MAX_BPS = 5_500;

/** The agency tier's inclusive price bounds, in micros: [$2.99, $9.99]. */
export const AGENCY_TIER_MIN_MICROS = 299_000_000n;
export const AGENCY_TIER_MAX_MICROS = 999_000_000n;

/** The agency rates, in whole basis points (the 70/35 directive). */
export const AGENCY_TIER_ROYALTY_BPS = 7_000;
export const AGENCY_OUTSIDE_ROYALTY_BPS = 3_500;

/** The audiobook pool's recoupment class — isolated from e-book and print. */
export const BOOK_RECOUPMENT_POOL_CLASSES = [
  "ebook_advance",
  "print_advance",
  "audiobook_production_unrecouped",
] as const;
export type BookRecoupmentPoolClass = (typeof BOOK_RECOUPMENT_POOL_CLASSES)[number];

export function isBookRecoupmentPoolClass(value: string): value is BookRecoupmentPoolClass {
  return (BOOK_RECOUPMENT_POOL_CLASSES as readonly string[]).includes(value);
}

/** The queue row's stream class a book line recoups through — the
 * isolation firewall: the line's row kind names its pool class explicitly,
 * exactly the webtoon apply's explicit-class discipline. */
export function bookStreamPoolClass(detail: BookLineDetail): BookRecoupmentPoolClass | null {
  switch (detail.kind) {
    case "print_sale":
      return "print_advance";
    case "ebook_sale":
      return "ebook_advance";
    case "audiobook_sale":
      return "audiobook_production_unrecouped";
    // Magazine rows carry no advance pool — their money routes through the
    // editorial cut schedule, never a recoupment pool.
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Parse-time validators (RangeError codes, the merch engine's style — the
// profiles catch and re-scope them to the row).
// ---------------------------------------------------------------------------

/** A positive whole-units cell — book rows ship physical or digital units. */
export function validateBookUnits(units: number, rowNumber: number): number {
  if (!Number.isInteger(units) || units <= 0) {
    throw new RangeError(`invalid_book_units:${units}:row_${rowNumber}`);
  }
  return units;
}

/**
 * The channel-discount band — a POD row whose discount falls outside the
 * 40–55% wholesale band is hostile (a mis-keyed gross or a fee posing as a
 * discount); fail closed at parse.
 */
export function validateChannelDiscountBps(bps: number, rowNumber: number): number {
  if (!Number.isInteger(bps) || bps < CHANNEL_DISCOUNT_MIN_BPS || bps > CHANNEL_DISCOUNT_MAX_BPS) {
    throw new RangeError(`channel_discount_out_of_band:${bps}:row_${rowNumber}`);
  }
  return bps;
}

/** A positive list price — the agency tier keys on it; zero or negative is hostile. */
export function validateAgencyPriceMicros(micros: bigint, rowNumber: number): bigint {
  if (micros <= 0n) {
    throw new RangeError(`invalid_list_price:${micros}:row_${rowNumber}`);
  }
  return micros;
}

// ---------------------------------------------------------------------------
// 1 · POD print deduction — gross retail − printing COGS × units −
// distribution fee − channel discount = net realized royalty.
// ---------------------------------------------------------------------------

/**
 * The channel discount's exact amount — floor(gross × bps / 10_000) in
 * micros; the discount never rounds up into the title's royalty.
 */
export function channelDiscountMicros(grossRetailMicros: bigint, channelDiscountBps: number): bigint {
  return (grossRetailMicros * BigInt(channelDiscountBps)) / 10_000n;
}

/**
 * The POD print deduction equation, term for term the directive's:
 * gross retail − base printing COGS × units − distribution fee − channel
 * discount. Every leg is the row's own recorded cell. A negative result
 * means the row's cost legs exceed its retail — the posting pass refuses it
 * (an operator quarantine, never a negative settlement).
 */
export function podPrintNetRoyaltyMicros(detail: BookLineDetail & { kind: "print_sale" }): bigint {
  const grossRetailMicros = BigInt(detail.grossRetailMicros);
  const discount = channelDiscountMicros(grossRetailMicros, detail.channelDiscountBps);
  return (
    grossRetailMicros -
    BigInt(detail.printingCostPerUnitMicros) * BigInt(detail.units) -
    BigInt(detail.distributionFeeMicros) -
    discount
  );
}

/** The print row's total recorded deductions, exact micros (the audit leg). */
export function podPrintDeductionMicros(detail: BookLineDetail & { kind: "print_sale" }): bigint {
  return (
    BigInt(detail.printingCostPerUnitMicros) * BigInt(detail.units) +
    BigInt(detail.distributionFeeMicros) +
    channelDiscountMicros(BigInt(detail.grossRetailMicros), detail.channelDiscountBps)
  );
}

// ---------------------------------------------------------------------------
// 2 · E-book agency model — 70% inside the $2.99–$9.99 tier (inclusive at
// both boundaries), 35% outside.
// ---------------------------------------------------------------------------

export type EbookAgencyTier = "seventy_percent" | "thirty_five_percent";

/**
 * The tier discriminator — the list price INCLUSIVE bounds decide: exactly
 * $2.99 and exactly $9.99 are tier (70%); $2.98 and $10.00 are outside
 * (35%). The boundary is the directive's exact rule, pinned by tests.
 */
export function ebookAgencyTier(listPriceMicros: bigint): EbookAgencyTier {
  return listPriceMicros >= AGENCY_TIER_MIN_MICROS && listPriceMicros <= AGENCY_TIER_MAX_MICROS
    ? "seventy_percent"
    : "thirty_five_percent";
}

/**
 * The agency royalty — list price × units × the tier's rate, exact bigint
 * micros (floor of the product; a 70% royalty of a price whose micros
 * product has sub-micro residue never rounds up).
 */
export function ebookAgencyRoyaltyMicros(detail: BookLineDetail & { kind: "ebook_sale" }): {
  royaltyMicros: bigint;
  tier: EbookAgencyTier;
  royaltyBps: number;
} {
  const listPriceMicros = BigInt(detail.listPriceMicros);
  const tier = ebookAgencyTier(listPriceMicros);
  const royaltyBps = tier === "seventy_percent" ? AGENCY_TIER_ROYALTY_BPS : AGENCY_OUTSIDE_ROYALTY_BPS;
  const gross = listPriceMicros * BigInt(detail.units);
  const royaltyMicros = (gross * BigInt(royaltyBps)) / 10_000n;
  return { royaltyMicros, tier, royaltyBps };
}

/** The ebook row's gross (list × units) — the queue row's reported gross. */
export function ebookGrossMicros(detail: BookLineDetail & { kind: "ebook_sale" }): bigint {
  return BigInt(detail.listPriceMicros) * BigInt(detail.units);
}

// ---------------------------------------------------------------------------
// 3 · Anthology pro-rata — one basis per schedule (page or word counts),
// floored shares, visible dust.
// ---------------------------------------------------------------------------

/** One anthology contributor's pro-rata input — identity + count only. */
export interface AnthologyContributorCount {
  readonly payeeId: string;
  readonly payeeName: string;
  readonly count: number;
}

export interface AnthologyProRataAllocation {
  readonly payeeId: string;
  readonly payeeName: string;
  readonly shareCents: number;
}

export interface AnthologyProRataResult {
  readonly basis: "page_count" | "word_count";
  readonly totalCents: number;
  readonly allocations: readonly AnthologyProRataAllocation[];
  /** The pro-rata floor residue — visible, never redistributed silently. */
  readonly dustCents: number;
}

/**
 * The anthology pro-rata split — each contributor's share is
 * floor(net × count / totalCount), exact integer cents. Counts must be
 * positive whole numbers (a zero or negative count is a hostile schedule);
 `totalCents` may be zero (nothing to split — all shares zero, dust zero).
 */
export function anthologyProRataSplits(
  netCents: number,
  basis: "page_count" | "word_count",
  contributors: readonly AnthologyContributorCount[],
): AnthologyProRataResult {
  for (const contributor of contributors) {
    if (!Number.isInteger(contributor.count) || contributor.count <= 0) {
      throw new RangeError(`invalid_anthology_count:${contributor.payeeId}:${contributor.count}`);
    }
  }
  const totalCount = contributors.reduce((sum, contributor) => sum + contributor.count, 0);
  if (totalCount <= 0) {
    throw new RangeError("invalid_anthology_total:schedule_counts_sum_to_zero");
  }
  const scaled = BigInt(Math.max(0, netCents)) * 10_000n;
  const allocations = contributors.map((contributor) => ({
    payeeId: contributor.payeeId,
    payeeName: contributor.payeeName,
    shareCents: Number(scaled * BigInt(contributor.count) / BigInt(totalCount) / 10_000n),
  }));
  const allocated = allocations.reduce((sum, allocation) => sum + allocation.shareCents, 0);
  return {
    basis,
    totalCents: Math.max(0, netCents),
    allocations,
    dustCents: Math.max(0, netCents) - allocated,
  };
}

// ---------------------------------------------------------------------------
// 4 · Magazine editorial cuts — flat per-issue (once per issue) and
// percentage-of-subscription (per funding event) modes.
// ---------------------------------------------------------------------------

/** The flat per-issue cut — the contributor's contracted fee, integer cents. */
export function magazineFlatPerIssueCutCents(flatCents: number): number {
  if (!Number.isInteger(flatCents) || flatCents < 1) {
    throw new RangeError(`invalid_flat_cut:${flatCents}`);
  }
  return flatCents;
}

/**
 * The percentage cut of a subscription funding event — floor(micros × bps /
 * 10_000), exact bigint micros; the cut never rounds up into a
 * contributor's credit.
 */
export function magazinePercentageCutMicros(subscriptionMicros: bigint, percentageBps: number): bigint {
  if (!Number.isInteger(percentageBps) || percentageBps < 0 || percentageBps > 10_000) {
    throw new RangeError(`invalid_percentage_cut:${percentageBps}`);
  }
  return (subscriptionMicros * BigInt(percentageBps)) / 10_000n;
}

// ---------------------------------------------------------------------------
// 5 · Sequential advance recoupment — pools fill in sequence order; the
// switchover point is the first event where every pool is clear.
// ---------------------------------------------------------------------------

/** One pool's position going into an application — the caller reads the
 * pool rows and passes their OPEN state; this function is pure. */
export interface SequentialPoolPosition {
  readonly poolId: string;
  /** The pool's open balance before this application, integer cents. */
  readonly remainingCents: number;
}

export interface SequentialRecoupmentApplication {
  readonly poolId: string;
  readonly appliedCents: number;
  readonly recoupedBeforeCents: number;
  readonly remainingCents: number;
}

export interface SequentialRecoupmentResult {
  readonly applications: readonly SequentialRecoupmentApplication[];
  /** The integer cents applied to pools this event (0 when all clear). */
  readonly recoupedCents: number;
  /**
   * The post-clearance excess — the standard net percentage splits' basis.
   * Zero while any pool remains open (100% of the royalty is recouping);
   * positive from the clearing event onward (the switchover).
   */
  readonly excessCents: number;
}

/**
 * The sequential recoupment — royalties fill the pools in the given
 * sequence order, each taking min(remaining, what's left of the event);
 * the excess after the last open pool clears is the splits' basis. The
 * switchover is exact: the clearing event's remainder flows to splits the
 * SAME event (100% of initial royalties recoup UNTIL the advance clears —
 * not one cent past it).
 */
export function sequentialAdvanceRecoupment(
  royaltyCents: number,
  pools: readonly SequentialPoolPosition[],
): SequentialRecoupmentResult {
  if (!Number.isSafeInteger(royaltyCents) || royaltyCents < 0) {
    throw new RangeError(`invalid_recoupment_royalty:${royaltyCents}`);
  }
  const applications: SequentialRecoupmentApplication[] = [];
  let remainingRoyalty = royaltyCents;
  for (const pool of pools) {
    if (remainingRoyalty <= 0) break;
    if (!Number.isSafeInteger(pool.remainingCents) || pool.remainingCents < 0) {
      throw new RangeError(`invalid_pool_position:${pool.poolId}:${pool.remainingCents}`);
    }
    if (pool.remainingCents === 0) continue; // already clear — the sequence moves on
    const applied = Math.min(pool.remainingCents, remainingRoyalty);
    applications.push({
      poolId: pool.poolId,
      appliedCents: applied,
      recoupedBeforeCents: 0, // positional bookkeeping is the caller's ledger truth
      remainingCents: pool.remainingCents - applied,
    });
    remainingRoyalty -= applied;
  }
  return {
    applications,
    recoupedCents: royaltyCents - remainingRoyalty,
    excessCents: remainingRoyalty,
  };
}

// ---------------------------------------------------------------------------
// Event-id identity spaces — content-derived per row (identity, never
// money; the webtoon fingerprint discipline).
// ---------------------------------------------------------------------------

/** The sha256 identity fingerprint — identity fields only, never money. */
function bookIdentityHash(fields: readonly string[]): string {
  return createHash("sha256").update(fields.join("|")).digest("hex");
}

export function bookPrintEventId(detail: BookLineDetail & { kind: "print_sale" }): string {
  return `book:print:${bookIdentityHash([
    detail.platform,
    detail.orderId,
    detail.isbn,
    detail.formatType,
  ])}`;
}

export function bookEbookEventId(detail: BookLineDetail & { kind: "ebook_sale" }): string {
  return `book:ebook:${bookIdentityHash([detail.platform, detail.orderId, detail.isbn])}`;
}

export function bookMagazineEventId(detail: BookLineDetail & { kind: "magazine_issue" | "magazine_subscription" }): string {
  return `book:magazine:${bookIdentityHash([detail.platform, detail.eventId])}`;
}

export function bookAudiobookEventId(detail: BookLineDetail & { kind: "audiobook_sale" }): string {
  return `book:audio:${bookIdentityHash([detail.platform, detail.orderId, detail.isbn])}`;
}
