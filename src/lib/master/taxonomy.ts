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

/** The six master verticals — the founder's GlobalEntertainmentCategory. */
export type GlobalEntertainmentCategory =
  | 'FILM_AND_TELEVISION'
  | 'AUDIO_AND_RECORDED_SOUND'
  | 'PUBLISHING_AND_LITERARY'
  | 'LIVE_PERFORMANCE_AND_COMEDY'
  | 'INTERACTIVE_AND_DIGITAL_MEDIA'
  | 'COMMERCIAL_AND_BRAND_LICENSING';

/** Canonical display order — the tab bar order on every master surface. */
export const MASTER_CATEGORY_ORDER: readonly GlobalEntertainmentCategory[] = [
  'FILM_AND_TELEVISION',
  'AUDIO_AND_RECORDED_SOUND',
  'PUBLISHING_AND_LITERARY',
  'LIVE_PERFORMANCE_AND_COMEDY',
  'INTERACTIVE_AND_DIGITAL_MEDIA',
  'COMMERCIAL_AND_BRAND_LICENSING',
];

/** Display names — the six master categories, verbatim. */
export const MASTER_CATEGORY_LABELS: Record<GlobalEntertainmentCategory, string> = {
  FILM_AND_TELEVISION: 'Film & Television',
  AUDIO_AND_RECORDED_SOUND: 'Audio & Recorded Sound',
  PUBLISHING_AND_LITERARY: 'Publishing & Literary',
  LIVE_PERFORMANCE_AND_COMEDY: 'Live Performance & Comedy',
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
