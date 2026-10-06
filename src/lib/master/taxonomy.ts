/**
 * Master Entertainment Taxonomy — the founder's GlobalEntertainmentCategory
 * canon (CovnantMasterDataSDK drop, 2026-09-20). The six verticals are the
 * master category system for EVERY admin data surface: the ledger engine's
 * category vocabulary, the tab bars' swap keys, and the template library's
 * presentation grouping all read from here — no surface invents its own.
 *
 * Non-standard labels are banned by canon ('Film, TV & Hollywood' et al.):
 * these six names and their subcategories are the only category vocabulary
 * the admin pages render.
 */

import type { MediaMedium } from '@/engine/covenant-master-sdk';

/**
 * The seven master verticals — the founder's GlobalEntertainmentCategory
 * canon (six drops, 2026-09-20) plus the generation-4 expansion vertical
 * SportsAndAthletics (approved build, 2026-09-22): the athletic economy —
 * athlete contracts and tournament prize purses — gets its own vertical.
 */
export type GlobalEntertainmentCategory =
  | 'FILM_AND_TELEVISION'
  | 'AUDIO_AND_RECORDED_SOUND'
  | 'PUBLISHING_AND_LITERARY'
  | 'LIVE_PERFORMANCE_AND_COMEDY'
  | 'SPORTS_AND_ATHLETICS'
  | 'INTERACTIVE_AND_DIGITAL_MEDIA'
  | 'COMMERCIAL_AND_BRAND_LICENSING';

/** Canonical display order — the tab bar order on every master surface. */
export const MASTER_CATEGORY_ORDER: readonly GlobalEntertainmentCategory[] = [
  'FILM_AND_TELEVISION',
  'AUDIO_AND_RECORDED_SOUND',
  'PUBLISHING_AND_LITERARY',
  'LIVE_PERFORMANCE_AND_COMEDY',
  'SPORTS_AND_ATHLETICS',
  'INTERACTIVE_AND_DIGITAL_MEDIA',
  'COMMERCIAL_AND_BRAND_LICENSING',
];

/** Display names — the seven master categories, verbatim. */
export const MASTER_CATEGORY_LABELS: Record<GlobalEntertainmentCategory, string> = {
  FILM_AND_TELEVISION: 'Film & Television',
  AUDIO_AND_RECORDED_SOUND: 'Audio & Recorded Sound',
  PUBLISHING_AND_LITERARY: 'Publishing & Literary',
  LIVE_PERFORMANCE_AND_COMEDY: 'Live Performance & Comedy',
  SPORTS_AND_ATHLETICS: 'Sports & Athletics',
  INTERACTIVE_AND_DIGITAL_MEDIA: 'Interactive & Digital Media',
  COMMERCIAL_AND_BRAND_LICENSING: 'Commercial & Brand Licensing',
};

/** One-line vertical description for the master surfaces' context rows. */
export const MASTER_CATEGORY_BLURBS: Record<GlobalEntertainmentCategory, string> = {
  FILM_AND_TELEVISION:
    'Theatrical, streaming, broadcast, syndication, and unscripted rights — every screen vertical in one ledger.',
  AUDIO_AND_RECORDED_SOUND:
    'Recorded music, spoken word, podcasts, radio, and sample libraries — the sound economy’s master ledger.',
  PUBLISHING_AND_LITERARY:
    'Print, digital, periodical, journal, and score publishing — the written-work ledger of record.',
  LIVE_PERFORMANCE_AND_COMEDY:
    'Stand-up, theater, touring, and venue ticketing — the live-economy settlement ledger.',
  SPORTS_AND_ATHLETICS:
    'Athlete contracts, tournament prize purses, and sponsorship guarantees — the athletic-economy settlement ledger.',
  INTERACTIVE_AND_DIGITAL_MEDIA:
    'Games, immersive experiences, software, and digital collectibles — interactive rights, settled.',
  COMMERCIAL_AND_BRAND_LICENSING:
    'Partnerships, placement, endorsements, and merchandising — the brand-licensing ledger.',
};

/** Subcategories per vertical — the founder's canon lists, verbatim. */
export const MASTER_SUBCATEGORIES: Record<GlobalEntertainmentCategory, readonly string[]> = {
  FILM_AND_TELEVISION: [
    'Theatrical',
    'SVOD / Streaming VOD',
    'Broadcast TV',
    'Cable Syndication',
    'Unscripted & Documentary',
  ],
  AUDIO_AND_RECORDED_SOUND: [
    'Commercial Music Releases',
    'Audiobooks',
    'Podcasts',
    'Radio & Satellite Streaming',
    'Sound Effects & Sample Libraries',
  ],
  PUBLISHING_AND_LITERARY: [
    'Print Books',
    'e-Books',
    'Periodicals',
    'Academic & Trade Journals',
    'Sheet Music & Scores',
  ],
  LIVE_PERFORMANCE_AND_COMEDY: [
    'Stand-Up & Comedy Specials',
    'Live Theater & Broadway',
    'Concerts & Festival Touring',
    'Venue Ticketing Ledgers',
  ],
  SPORTS_AND_ATHLETICS: [
    'Traditional Sponsorship',
    'Tournament Prize Pools',
    'Athlete Endorsements',
  ],
  INTERACTIVE_AND_DIGITAL_MEDIA: [
    'Video Games',
    'Immersive & XR',
    'Software Assets',
    'Digital Collectibles & Microtransactions',
  ],
  COMMERCIAL_AND_BRAND_LICENSING: [
    'Brand Partnerships',
    'Product Placement',
    'Endorsements',
    'Merchandising & Physical Goods',
  ],
};

/**
 * The four-letter category code in the sovereign ledgerId
 * (CVN-<CAT4>-2026-00N) — stable machine keys, never derived at call time.
 */
export const MASTER_CATEGORY_CODES: Record<GlobalEntertainmentCategory, string> = {
  FILM_AND_TELEVISION: 'FILM',
  AUDIO_AND_RECORDED_SOUND: 'AUDIO',
  PUBLISHING_AND_LITERARY: 'PUBS',
  LIVE_PERFORMANCE_AND_COMEDY: 'LIVE',
  SPORTS_AND_ATHLETICS: 'SPRT',
  INTERACTIVE_AND_DIGITAL_MEDIA: 'INTR',
  COMMERCIAL_AND_BRAND_LICENSING: 'COMM',
};

/** Narrow a string from a query param onto the taxonomy; null when unknown. */
export function masterCategoryFromParam(value: string | undefined): GlobalEntertainmentCategory | null {
  return MASTER_CATEGORY_ORDER.find((category) => category === value) ?? null;
}

/** Guard for store/engine boundaries. */
export function isGlobalEntertainmentCategory(value: unknown): value is GlobalEntertainmentCategory {
  return (
    typeof value === 'string' &&
    (MASTER_CATEGORY_ORDER as readonly string[]).includes(value)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The founder's 26 ATOMIC SECTORS (CovnantAtomicDataSDK canon) — the granular
// sector vocabulary of the atomic registry — plus the three generation-4
// expansion sectors (SPORTS_AND_ATHLETICS, ESPORTS, SPONSORSHIP, approved
// build 2026-09-22). Lives beside the master verticals
// because the vertical tab system maps sectors onto tabs; this module is the
// client-safe home (no store imports), so the Control Board's tab handlers
// can read the sector→vertical mapping in the browser.
// ─────────────────────────────────────────────────────────────────────────────

/** The founder's 26 atomic sectors plus the three expansion sectors. */
export type AtomicSector =
  | 'MUSIC'
  | 'GAMING'
  | 'ESPORTS'
  | 'INTERACTIVE'
  | 'PODCASTING'
  | 'STREAMING'
  | 'SOCIAL_MEDIA'
  | 'PUBLISHING'
  | 'MOVIES'
  | 'FILM'
  | 'TV'
  | 'VIDEO'
  | 'SPORTS'
  | 'MOTORSPORT'
  | 'ARENA'
  | 'ATHLETICS'
  | 'SPORTS_AND_ATHLETICS'
  | 'FASHION'
  | 'MODELING'
  | 'CAD'
  | 'VISUAL_ARTS'
  | 'DESIGN'
  | 'SPONSORSHIP'
  | 'BOOKS'
  | 'LITERATURE'
  | 'DIGITAL_ASSETS'
  | 'SOFTWARE'
  | 'VTUBING'
  | 'VIRTUAL_AVATARS';

/** Canon display order of the sectors — the registry manifest order. */
export const ATOMIC_SECTOR_ORDER: readonly AtomicSector[] = Object.freeze([
  'MUSIC',
  'GAMING',
  'ESPORTS',
  'INTERACTIVE',
  'PODCASTING',
  'STREAMING',
  'SOCIAL_MEDIA',
  'PUBLISHING',
  'MOVIES',
  'FILM',
  'TV',
  'VIDEO',
  'SPORTS',
  'MOTORSPORT',
  'ARENA',
  'ATHLETICS',
  'SPORTS_AND_ATHLETICS',
  'FASHION',
  'MODELING',
  'CAD',
  'VISUAL_ARTS',
  'DESIGN',
  'SPONSORSHIP',
  'BOOKS',
  'LITERATURE',
  'DIGITAL_ASSETS',
  'SOFTWARE',
  'VTUBING',
  'VIRTUAL_AVATARS',
] as const);

/**
 * Atomic sector → master vertical — the frozen tab filter mapping. The
 * generation-4 expansion adds the seventh vertical: the SPORTS sector moves
 * from LIVE_PERFORMANCE_AND_COMEDY to SPORTS_AND_ATHLETICS (the athlete
 * contract and tournament classes' home), ESPORTS and SOCIAL_MEDIA ride
 * INTERACTIVE_AND_DIGITAL_MEDIA, and SPONSORSHIP rides
 * COMMERCIAL_AND_BRAND_LICENSING — both blurbs already claim that territory.
 */
export const ATOMIC_SECTOR_TO_VERTICAL: Record<AtomicSector, GlobalEntertainmentCategory> = {
  MUSIC: 'AUDIO_AND_RECORDED_SOUND',
  PODCASTING: 'AUDIO_AND_RECORDED_SOUND',
  MOVIES: 'FILM_AND_TELEVISION',
  FILM: 'FILM_AND_TELEVISION',
  TV: 'FILM_AND_TELEVISION',
  VIDEO: 'FILM_AND_TELEVISION',
  STREAMING: 'FILM_AND_TELEVISION',
  PUBLISHING: 'PUBLISHING_AND_LITERARY',
  BOOKS: 'PUBLISHING_AND_LITERARY',
  LITERATURE: 'PUBLISHING_AND_LITERARY',
  SPORTS: 'SPORTS_AND_ATHLETICS',
  SPORTS_AND_ATHLETICS: 'SPORTS_AND_ATHLETICS',
  MOTORSPORT: 'LIVE_PERFORMANCE_AND_COMEDY',
  ARENA: 'LIVE_PERFORMANCE_AND_COMEDY',
  ATHLETICS: 'LIVE_PERFORMANCE_AND_COMEDY',
  GAMING: 'INTERACTIVE_AND_DIGITAL_MEDIA',
  ESPORTS: 'INTERACTIVE_AND_DIGITAL_MEDIA',
  INTERACTIVE: 'INTERACTIVE_AND_DIGITAL_MEDIA',
  SOFTWARE: 'INTERACTIVE_AND_DIGITAL_MEDIA',
  DIGITAL_ASSETS: 'INTERACTIVE_AND_DIGITAL_MEDIA',
  CAD: 'INTERACTIVE_AND_DIGITAL_MEDIA',
  SOCIAL_MEDIA: 'INTERACTIVE_AND_DIGITAL_MEDIA',
  VTUBING: 'INTERACTIVE_AND_DIGITAL_MEDIA',
  VIRTUAL_AVATARS: 'INTERACTIVE_AND_DIGITAL_MEDIA',
  FASHION: 'COMMERCIAL_AND_BRAND_LICENSING',
  MODELING: 'COMMERCIAL_AND_BRAND_LICENSING',
  VISUAL_ARTS: 'COMMERCIAL_AND_BRAND_LICENSING',
  DESIGN: 'COMMERCIAL_AND_BRAND_LICENSING',
  SPONSORSHIP: 'COMMERCIAL_AND_BRAND_LICENSING',
};

/** The atomic sectors a master vertical tab covers — the per-tab fetch set. */
export function sectorsForVertical(vertical: GlobalEntertainmentCategory): AtomicSector[] {
  return ATOMIC_SECTOR_ORDER.filter((sector) => ATOMIC_SECTOR_TO_VERTICAL[sector] === vertical);
}

/** Narrow a raw route param onto the sector canon; null when unknown. */
export function atomicSectorFromParam(value: string): AtomicSector | null {
  return (ATOMIC_SECTOR_ORDER as readonly string[]).includes(value)
    ? (value as AtomicSector)
    : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Medium placement — where a REGISTERED asset's medium of record clears on
// the master surfaces. The engine's CBT type prefixes (CBT_PREFIX_MAP, the
// vendored engine's mint vocabulary) pair every MediaMedium with a type
// segment; the placements here carry the canonical vertical + subcategory
// each medium clears under. Sector-backed mediums ride the frozen
// ATOMIC_SECTOR_TO_VERTICAL placement law exactly (MOTORSPORT/ARENA/
// ATHLETICS stay where the founder put them — LIVE_PERFORMANCE_AND_COMEDY);
// mediums with no atomic sector (sheet music, audiobooks, e-books,
// periodicals, the orbital broadcast) place by the MASTER_SUBCATEGORIES
// canon lists — the same lists the seeded master library reads.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a registered medium of record clears — master vertical + subcategory. */
export interface MasterPlacement {
  readonly category: GlobalEntertainmentCategory;
  readonly subcategory: string;
}

/**
 * Every MediaMedium's placement — compiler-total over the engine union. A
 * new medium without an arm fails the build here, and the module-load gate
 * beneath pins every arm to a canon (vertical, subcategory) pair.
 */
const MEDIUM_PLACEMENTS: Record<MediaMedium, MasterPlacement> = {
  MUSIC_TRACK: { category: 'AUDIO_AND_RECORDED_SOUND', subcategory: 'Commercial Music Releases' },
  MUSIC_ALBUM: { category: 'AUDIO_AND_RECORDED_SOUND', subcategory: 'Commercial Music Releases' },
  PODCAST_EPISODE: { category: 'AUDIO_AND_RECORDED_SOUND', subcategory: 'Podcasts' },
  AUDIOBOOK: { category: 'AUDIO_AND_RECORDED_SOUND', subcategory: 'Audiobooks' },
  FEATURE_FILM: { category: 'FILM_AND_TELEVISION', subcategory: 'Theatrical' },
  TV_SHOW: { category: 'FILM_AND_TELEVISION', subcategory: 'Broadcast TV' },
  TV_SEASON: { category: 'FILM_AND_TELEVISION', subcategory: 'Broadcast TV' },
  TV_EPISODE: { category: 'FILM_AND_TELEVISION', subcategory: 'Broadcast TV' },
  LIVE_STREAM: { category: 'FILM_AND_TELEVISION', subcategory: 'SVOD / Streaming VOD' },
  MARS_ORBITAL_BROADCAST: { category: 'FILM_AND_TELEVISION', subcategory: 'Broadcast TV' },
  SHEET_MUSIC: { category: 'PUBLISHING_AND_LITERARY', subcategory: 'Sheet Music & Scores' },
  PRINT_BOOK: { category: 'PUBLISHING_AND_LITERARY', subcategory: 'Print Books' },
  EBOOK: { category: 'PUBLISHING_AND_LITERARY', subcategory: 'e-Books' },
  MAGAZINE_SERIAL: { category: 'PUBLISHING_AND_LITERARY', subcategory: 'Periodicals' },
  VIDEO_GAME: { category: 'INTERACTIVE_AND_DIGITAL_MEDIA', subcategory: 'Video Games' },
  LIVE_EVENT: { category: 'LIVE_PERFORMANCE_AND_COMEDY', subcategory: 'Venue Ticketing Ledgers' },
  GARMENT_LINE: { category: 'COMMERCIAL_AND_BRAND_LICENSING', subcategory: 'Merchandising & Physical Goods' },
};

/** The placement of record for a registered medium — total, never null. */
export function masterPlacementForMedium(medium: MediaMedium): MasterPlacement {
  return MEDIUM_PLACEMENTS[medium];
}

/** Every armed medium — compiler-total over the engine union (the table's keys). */
export function masterPlacementMediums(): readonly MediaMedium[] {
  return Object.keys(MEDIUM_PLACEMENTS) as MediaMedium[];
}

/**
 * The engine's medium → CBT type segment vocabulary (CBT_PREFIX_MAP), kept
 * here as the reverse lookup so a ledger row whose asset record is gone
 * still places by its own code of record. Drift from the engine's map is
 * caught by the suite's cross-check against generateCBTCode.
 */
const CBT_TYPE_TO_MEDIUM: Record<string, MediaMedium> = {
  TRK: 'MUSIC_TRACK',
  ALB: 'MUSIC_ALBUM',
  SHT: 'SHEET_MUSIC',
  FLM: 'FEATURE_FILM',
  TVS: 'TV_SHOW',
  SSN: 'TV_SEASON',
  TVE: 'TV_EPISODE',
  POD: 'PODCAST_EPISODE',
  ABK: 'AUDIOBOOK',
  PBK: 'PRINT_BOOK',
  EBK: 'EBOOK',
  MAG: 'MAGAZINE_SERIAL',
  GME: 'VIDEO_GAME',
  STR: 'LIVE_STREAM',
  MOB: 'MARS_ORBITAL_BROADCAST',
  LVE: 'LIVE_EVENT',
  FSH: 'GARMENT_LINE',
};

/**
 * The placement of record for a settled row keyed only by its CBT code —
 * the type segment self-describes the medium (every real code is engine-
 * minted through CBT_PREFIX_MAP). Null when the segment is off-canon: the
 * caller decides, and the master derivation fails loud rather than
 * mislabeling a settlement.
 */
export function masterPlacementForCbt(cbtCode: string): MasterPlacement | null {
  const type = /^CBT-([A-Z]+)-/.exec(cbtCode.trim().toUpperCase())?.[1];
  const medium = type === undefined ? undefined : CBT_TYPE_TO_MEDIUM[type];
  return medium === undefined ? null : MEDIUM_PLACEMENTS[medium];
}

/** Module-load placement gate — every arm lands on a canon subcategory pair. */
for (const [medium, placement] of Object.entries(MEDIUM_PLACEMENTS)) {
  if (!MASTER_SUBCATEGORIES[placement.category].includes(placement.subcategory)) {
    throw new Error(
      `taxonomy: medium ${medium} places at ${placement.category} / "${placement.subcategory}", which is not a canon subcategory of that vertical`,
    );
  }
}

/**
 * Tab-bar semantics shared by the vertical tab bars (client) and their host
 * pages (server — plain string helpers, safe across the client boundary):
 * every tab controls the page's single content panel (UI audit #11).
 */
export const MASTER_TAB_PANEL_ID = 'master-category-panel';

export function masterTabId(category: GlobalEntertainmentCategory | null): string {
  return `master-tab-${category ?? 'all'}`;
}
