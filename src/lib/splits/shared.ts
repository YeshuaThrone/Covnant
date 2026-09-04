/**
 * Client-safe split-engine primitives shared by the studio UI and the
 * server-side adapter.
 *
 * This module must stay free of runtime engine imports so the browser bundle
 * never pulls in the vendored SDK — engine types are imported with
 * `import type`, which is erased at build time.
 *
 * All percentage math uses the engine's integer convention: units of
 * 1/10,000 of a percent (a percentage `p` becomes `p * 10,000` units; 100% is
 * 1,000,000 units). The engine's validateSplits tolerates ±1 unit, but the
 * directive's save gate is stricter — every pool must read EXACTLY
 * 100.0000% — so the studio's live gate and the adapter's pre-write check
 * both use strict equality at the unit level.
 */
import type { MediaMedium } from '@/engine/covenant-master-sdk';
import { formatPercentUnits, percentNumberToUnits } from '@/lib/fixed-point';

export const SPLIT_SCALE = 10000;
/** 100.0000% in engine units (percentage × SPLIT_SCALE). */
export const TARGET_UNITS = 100 * SPLIT_SCALE;

export const POOL_NAMES = ['MASTER_RECORDING', 'WRITER_COMPOSITION', 'PUBLISHER_ADMIN'] as const;
export type PoolName = (typeof POOL_NAMES)[number];

export const POOL_LABELS: Record<PoolName, string> = {
  MASTER_RECORDING: 'Master Recording',
  WRITER_COMPOSITION: 'Writer / Composition',
  PUBLISHER_ADMIN: 'Publisher Administration',
};

/** Mirrors the engine's inline role union on SelfServeRightsHolder. */
export type RightsHolderRole =
  | 'COMPOSER'
  | 'LYRICIST'
  | 'PRODUCER'
  | 'DIRECTOR'
  | 'ACTOR'
  | 'PUBLISHER'
  | 'STUDIO'
  | 'HOST'
  | 'DISTRIBUTOR';

export const RIGHTS_HOLDER_ROLES: readonly RightsHolderRole[] = [
  'COMPOSER', 'LYRICIST', 'PRODUCER', 'DIRECTOR', 'ACTOR',
  'PUBLISHER', 'STUDIO', 'HOST', 'DISTRIBUTOR',
];

export type TaxFormType = 'W9_US_PERSON' | 'W8BEN_FOREIGN_INDIVIDUAL' | 'W8BEN_E_FOREIGN_ENTITY' | 'EXEMPT';

export const TAX_FORM_TYPES: readonly TaxFormType[] = [
  'W9_US_PERSON', 'W8BEN_FOREIGN_INDIVIDUAL', 'W8BEN_E_FOREIGN_ENTITY', 'EXEMPT',
];

export const TAX_FORM_LABELS: Record<TaxFormType, string> = {
  W9_US_PERSON: 'W-9 (US person)',
  W8BEN_FOREIGN_INDIVIDUAL: 'W-8BEN (foreign individual)',
  W8BEN_E_FOREIGN_ENTITY: 'W-8BEN-E (foreign entity)',
  EXEMPT: 'Exempt',
};

/** Compile-checked against the engine's MediaMedium union; erased at build. */
export const MEDIA_MEDIUMS: readonly MediaMedium[] = [
  'MUSIC_TRACK', 'MUSIC_ALBUM', 'SHEET_MUSIC', 'FEATURE_FILM', 'TV_SHOW',
  'TV_SEASON', 'TV_EPISODE', 'PODCAST_EPISODE', 'AUDIOBOOK', 'PRINT_BOOK',
  'EBOOK', 'MAGAZINE_SERIAL', 'VIDEO_GAME', 'LIVE_STREAM', 'MARS_ORBITAL_BROADCAST',
];

export const MEDIUM_LABELS: Record<MediaMedium, string> = {
  MUSIC_TRACK: 'Music Track',
  MUSIC_ALBUM: 'Music Album',
  SHEET_MUSIC: 'Sheet Music',
  FEATURE_FILM: 'Feature Film',
  TV_SHOW: 'TV Show',
  TV_SEASON: 'TV Season',
  TV_EPISODE: 'TV Episode',
  PODCAST_EPISODE: 'Podcast Episode',
  AUDIOBOOK: 'Audiobook',
  PRINT_BOOK: 'Print Book',
  EBOOK: 'eBook',
  MAGAZINE_SERIAL: 'Magazine Serial',
  VIDEO_GAME: 'Video Game',
  LIVE_STREAM: 'Live Stream',
  MARS_ORBITAL_BROADCAST: 'Mars Orbital Broadcast',
};

export interface HolderRoutingDraft {
  accountHolderName: string;
  bankName: string;
  accountNumberOrIBAN: string;
  routingOrBIC: string;
  currency: string;
  countryCode: string;
  planetaryJurisdiction: 'EARTH' | 'MARS' | 'ORBITAL';
  railType: string;
}

export interface HolderDraft {
  id: string;
  name: string;
  role: RightsHolderRole;
  /** True per-pool share, e.g. 33.3333 — the studio edits and displays this. */
  splitPercentage: number;
  taxFormType: TaxFormType;
  usTaxResident: boolean;
  treatyCountryCode?: string;
  treatyWithholdingRate?: number;
  isVerified: boolean;
  routing: HolderRoutingDraft;
}

export interface PoolDraft {
  pool: PoolName;
  holders: HolderDraft[];
}

/**
 * Sum shares into the engine's integer unit space (1 unit = 0.0001%).
 *
 * Returns a number only because the engine's `splitPercentage` is a number;
 * the arithmetic itself runs in BigInt (via the fixed-point handler), so the
 * result is the exact integer the float path could only approximate.
 */
export function sumPoolUnits(shares: number[]): number {
  return Number(poolUnitsFromShares(shares));
}

/** Exact per-pool unit sum in BigInt space (1 unit = 0.0001%). */
export function poolUnitsFromShares(shares: number[]): bigint {
  return shares.reduce((acc, pct) => acc + percentNumberToUnits(pct), 0n);
}

export type PoolState = 'UNDER' | 'EXACT' | 'OVER';

/**
 * The directive's save gate: EXACTLY 100.0000% (1,000,000 units). Stricter
 * than the engine's ±1-unit tolerance on purpose — the engine still runs on
 * the stored sheet, but no pool may save while off by even a tenth of a
 * basis point.
 */
export function poolStateForUnits(units: number | bigint): PoolState {
  const value = BigInt(units);
  if (value === BigInt(TARGET_UNITS)) return 'EXACT';
  return value < BigInt(TARGET_UNITS) ? 'UNDER' : 'OVER';
}

/** Unit sum as a percentage string, e.g. 999_999 → "99.9999". Exact at 4 dp. */
export function formatUnitsAsPercent(units: number | bigint): string {
  return formatPercentUnits(BigInt(units));
}

/** Human gap for the pool chip: "needs 0.0001%" / "+0.0010% over"; empty when exact. */
export function describePoolGap(units: number | bigint): string {
  const delta = BigInt(units) - BigInt(TARGET_UNITS);
  if (delta === 0n) return '';
  const magnitude = formatPercentUnits(delta < 0n ? -delta : delta);
  return delta < 0n ? `needs ${magnitude}%` : `+${magnitude}% over`;
}
