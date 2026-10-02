/**
 * CVT recon worker — the webtoon lane's pure coin-conversion / KENP engine
 * (PR 19, founder webtoon + serialized-publishing directive). The
 * store-touching passes live in webtoonQueue.ts / webtoonPosting.ts; this
 * module is the math and the identity spaces, no store, no clock, no IO —
 * the same discipline as the podcast, gaming, and livestream engines.
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
 * The two money movements the directive pins:
 *
 *   1. VIRTUAL COIN CONVERSION — a Fast-Pass or paid coin unlock row's
 *      fiat gross is coins × the recorded exchange rate, exact bigint math
 *      at 1e-8 (virtual × rate / 1e8, floor — the gaming DevEx converter's
 *      exact product). The rate is RECORDED on each conversion log row —
 *      the queue row carries virtual_currency_code, virtual_amount, and
 *      exchange_rate verbatim, so the conversion is auditable from the row
 *      alone. The deductions apply AFTER the conversion, in the directive's
 *      layered order: the Apple/Google App Store cut first (the pinned 30%)
 *      on the coin-purchase fiat, then the platform's 30-50% split on the
 *      same gross — both floor at 1e-8, and the posting pass credits the
 *      creator NET to holding while the row's records carry the layers.
 *
 *   2. KENP PAGE-READ POOL — an Amazon KDP Select Global Fund row's payout
 *      is pages read × the period's pool rate (e.g. $0.004 per page), an
 *      exact integer product keyed on format_type: KENP money exists for
 *      ebook page reads and for nothing else. The rate is RECORDED per row
 *      and must be consistent per (period, marketplace) — a month's pool
 *      rate is one fact, and the profiles reject a report whose rows
 *      disagree (the Global Fund's monthly update applies per period).
 *
 * Subscription vs pay-per-chapter deduplication: a monthly all-access pass
 * read and a pay-per-chapter coin payout for the SAME reading event share
 * one content-derived event id (`webtoon:read:` over the reading-event
 * fingerprint — access type deliberately excluded, the podcast cross-feed
 * principle: identity is what was read, never how it was monetized). The
 * queue's UNIQUE event_id is the dedup arbiter across ingests — one payout
 * per reading event, structurally, in either arrival order; the reader
 * log's pass claim landing first quarantines the pay-per-chapter row
 * (the founder's double-dip rule), and a payout landing first makes the
 * later pass row an honest counted no-op.
 */

import { createHash } from "node:crypto";

import type {
  WebtoonAccessType,
  WebtoonLanePlatform,
  WebtoonLineDetail,
} from "./records";

export type { WebtoonAccessType, WebtoonLanePlatform };

/** House micro-dollar scale: 1 dollar = 1e8 statement micros (the SDK's 1e-8 space). */
export const MICROS_PER_DOLLAR = 100_000_000n;

/**
 * The Apple/Google App Store cut on in-app coin purchases — the founder
 * pinned the storefronts' standard 30% exactly (pinned-exact, like Steam's
 * commission): a row reporting any other storefront cut is hostile.
 */
export const APPLE_GOOGLE_STORE_CUT_BPS = 3000;

/**
 * The platform's split band — Webtoon/Tapas/KakaoPage keep 30-50% of the
 * post-storefront coin fiat (their published 30/50% creator terms); outside
 * the band is a hostile row, rejected at parse time.
 */
export const PLATFORM_SPLIT_MIN_BPS = 3000;
export const PLATFORM_SPLIT_MAX_BPS = 5000;

/** The webtoon lane's platform vocabulary (the directive's three senders). */
export const WEBTOON_PLATFORMS: readonly WebtoonLanePlatform[] = [
  "webtoon",
  "tapas",
  "kakaopage",
];

export function isWebtoonPlatform(platform: string): platform is WebtoonLanePlatform {
  return WEBTOON_PLATFORMS.includes(platform as WebtoonLanePlatform);
}

/**
 * The coin denominations the directive names — Webtoon Coins and Tapas
 * Ink (KakaoPage reports in Webtoon-compatible coins). A payout row in any
 * other denomination is hostile: the conversion rates this lane audits are
 * the two products' recorded rates.
 */
export const WEBTOON_COINS = "WEBTOON_COINS";
export const TAPAS_INK = "TAPAS_INK";
export const WEBTOON_COIN_DENOMINATIONS: readonly string[] = [
  WEBTOON_COINS,
  TAPAS_INK,
];

/**
 * The reader-log access types — `monthly_pass` is the all-access
 * subscription read (the double-dip claim's subject); `fast_pass` and
 * `paid_coin_unlock` are coin-money reads (Fast-Pass is a coin product).
 * The type vocabulary lives in records.ts; this constant backs validation.
 */
export const WEBTOON_ACCESS_TYPES: readonly WebtoonAccessType[] = [
  "paid_coin_unlock",
  "fast_pass",
  "monthly_pass",
];

export function isWebtoonAccessType(value: string): value is WebtoonAccessType {
  return WEBTOON_ACCESS_TYPES.includes(value as WebtoonAccessType);
}

/**
 * The virtual coin conversion — coins × the recorded exchange rate, exact
 * bigint math in the 1e-8 space: both operands are 1e-8 fixed-point, so
 * the product is 1e-16 and the fiat gross (1e-8) is the product / 1e8,
 * floored (the gaming DevEx converter's exact product). A rate or coin
 * amount that does not divide evenly leaves sub-micro residue on the
 * floor — never rounded up into invented money.
 */
export function coinGrossMicros(
  coinAmountMicros: bigint,
  exchangeRateMicros: bigint,
): bigint {
  if (coinAmountMicros < 0n || exchangeRateMicros < 0n) {
    throw new Error(
      `negative_coin_operand:${coinAmountMicros}:${exchangeRateMicros}`,
    );
  }
  return (coinAmountMicros * exchangeRateMicros) / MICROS_PER_DOLLAR;
}

/**
 * Validates the storefront cut is the pinned 30% — the founder's exact
 * rate for Apple and Google in-app purchases.
 */
export function validateStoreCutBps(bps: number): void {
  if (bps !== APPLE_GOOGLE_STORE_CUT_BPS) {
    throw new RangeError(`store_cut_out_of_band:${bps}`);
  }
}

/**
 * Validates the platform split against the 30-50% band. The split is
 * contract-configurable within the band; outside it is a hostile row.
 */
export function validatePlatformSplitBps(bps: number): void {
  if (bps < PLATFORM_SPLIT_MIN_BPS || bps > PLATFORM_SPLIT_MAX_BPS) {
    throw new RangeError(`platform_split_out_of_band:${bps}`);
  }
}

/**
 * The layered share deductions, applied AFTER the coin→fiat conversion in
 * the directive's order: the pinned App Store cut first, then the
 * platform's split — each an exact bigint floor (gross × bps / 10000), and
 * the creator net the complement by construction (cut + split + net ===
 * gross, so no rounding can invent or lose a micro).
 */
export function layeredShareDeductions(
  grossMicros: bigint,
  platformSplitBps: number,
): {
  appStoreCutMicros: bigint;
  platformSplitMicros: bigint;
  creatorNetMicros: bigint;
} {
  if (grossMicros < 0n) {
    throw new Error(`negative_gross:${grossMicros}`);
  }
  validatePlatformSplitBps(platformSplitBps);
  const appStoreCutMicros = (grossMicros * BigInt(APPLE_GOOGLE_STORE_CUT_BPS)) / 10000n;
  const platformSplitMicros = (grossMicros * BigInt(platformSplitBps)) / 10000n;
  return {
    appStoreCutMicros,
    platformSplitMicros,
    creatorNetMicros: grossMicros - appStoreCutMicros - platformSplitMicros,
  };
}

/**
 * The KENP pool payout — pages read × the period's pool rate, an exact
 * integer product in the 1e-8 space (e.g. 1000 pages × $0.004 = $4.00
 * exactly; 3 pages × $0.004 = 1.2 cents, and the sub-cent residue is the
 * posting pass's floor, never a round-up). The pool rate is RECORDED per
 * row (the Global Fund's monthly update) — the math consumes the row's own
 * rate, never a recomputation.
 */
export function kenpPoolPayoutMicros(
  pagesRead: number,
  rateMicros: bigint,
): bigint {
  if (!Number.isSafeInteger(pagesRead) || pagesRead <= 0) {
    throw new Error(`invalid_kenp_pages:${pagesRead}`);
  }
  if (rateMicros <= 0n) {
    throw new Error(`invalid_kenp_rate:${rateMicros}`);
  }
  return BigInt(pagesRead) * rateMicros;
}

/**
 * The reading-event fingerprint — content-derived, ingest-independent:
 * one reader's read of one chapter in one period, across every report that
 * describes it. Identity is WHAT was read (platform, series, chapter,
 * reader, period), never how it was monetized — the access type is a
 * state, not an identity attribute, exactly as the podcast fingerprint
 * excludes the revenue channel. Two reports of one reading event (a pass
 * read and a pay-per-chapter payout row) derive the same hex and collapse
 * to one match_queue event — the dedup arbiter with no new table.
 */
export function webtoonReadFingerprint(detail: WebtoonLineDetail): string {
  const identity = [
    detail.platform,
    detail.seriesId,
    detail.chapterId,
    detail.readerId,
    detail.period,
  ].join("|");
  return createHash("sha256").update(identity).digest("hex");
}

/**
 * The event-id spaces. `webtoon:read:` is THE reading-event space — shared
 * by the reader log's monthly-pass claims (zero-gross rows) and the coin
 * payout's pay-per-chapter money rows; the queue's UNIQUE event_id is the
 * dedup arbiter across ingests, in either arrival order. `webtoon:consumed:`
 * records coin-access reader-log facts (visible consumption records, never
 * money, never claims — a reader log row for a coin read must not block the
 * payout statement's legitimate money). `webtoon:held:` quarantines a
 * pay-per-chapter row a pass claim collides with (visible, never dropped,
 * never posted). `webtoon:kenp:` carries the KDP pool money content-derived
 * per (period, marketplace, title) — a re-shipped monthly report replays as
 * counted no-ops. `webtoon:conv:` is the durable conversion log's space.
 */
export function webtoonReadingEventId(detail: WebtoonLineDetail): string {
  return `webtoon:read:${webtoonReadFingerprint(detail)}`;
}

export function webtoonConsumedEventId(detail: WebtoonLineDetail): string {
  return `webtoon:consumed:${webtoonReadFingerprint(detail)}`;
}

export function webtoonHeldEventId(detail: WebtoonLineDetail): string {
  return `webtoon:held:${webtoonReadFingerprint(detail)}`;
}

export function webtoonKenpLineEventId(
  period: string,
  marketplace: string,
  titleId: string,
): string {
  return `webtoon:kenp:${period}:${marketplace}:${titleId}`;
}

export function webtoonConversionEventId(lineEventId: string): string {
  return `webtoon:conv:${lineEventId}`;
}
