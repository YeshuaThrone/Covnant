/**
 * Contract template catalog — directive §4 (twenty deterministic agreements).
 *
 * Five browsing categories span the industries the platform serves:
 *
 *   - MUSIC    — Music & Record Label (6)
 *   - FILM_TV  — Film, TV & Hollywood (4)
 *   - GAMING   — Gaming & Interactive (3)
 *   - CREATORS — Podcasts, Creators & Streamers (3)
 *   - FASHION  — Fashion & Apparel (4)
 *
 * The category is a catalog/presentation concept only. Persistence keeps the
 * `contracts.industry` column inside its existing CHECK domain
 * ('MUSIC' | 'FILM_MEDIA_MERCH' — 0002_contracts.sql, untouched), so every
 * template carries a persistence-safe `industry` derived from its category.
 * Template ids are stable machine keys: ids of surviving agreements are kept
 * across renames so previously stored contracts still resolve.
 */

export type ContractCategory = 'MUSIC' | 'FILM_TV' | 'GAMING' | 'CREATORS' | 'FASHION';

/** Persisted domain — must stay inside the contracts.industry CHECK constraint. */
export type ContractIndustry = 'MUSIC' | 'FILM_MEDIA_MERCH';

/** Browsing order for the five-way /templates and vault grouping. */
export const CATEGORY_ORDER: readonly ContractCategory[] = [
  'MUSIC',
  'FILM_TV',
  'GAMING',
  'CREATORS',
  'FASHION',
];

export const CATEGORY_LABELS: Record<ContractCategory, string> = {
  MUSIC: 'Music & Record Label',
  FILM_TV: 'Film, TV & Hollywood',
  GAMING: 'Gaming & Interactive',
  CREATORS: 'Podcasts, Creators & Streamers',
  FASHION: 'Fashion & Apparel',
};

/** Category blurbs shown atop each /templates section. */
export const CATEGORY_BLURBS: Record<ContractCategory, string> = {
  MUSIC: 'Split sheets, producer and publishing terms, master purchases, and sync licenses for recorded music.',
  FILM_TV: 'Options, score, director, and on-screen talent agreements for scripted productions.',
  GAMING: 'Interactive sync, studio royalty splits, and voiceover/mocap releases for game audio and performance.',
  CREATORS: 'Co-host splits, brand deals, and channel revenue shares for podcasts, streamers, and channels.',
  FASHION: 'Design licenses, production terms, brand collaborations, and runway talent releases for fashion houses and apparel lines.',
};

/** Industry persistence mapping — collapses the five categories onto the CHECK domain. */
export function industryForCategory(category: ContractCategory): ContractIndustry {
  return category === 'MUSIC' ? 'MUSIC' : 'FILM_MEDIA_MERCH';
}

/** Labels for the persisted industry values (legacy rows render with these). */
export const INDUSTRY_LABELS: Record<ContractIndustry, string> = {
  MUSIC: 'Music & Record Label',
  FILM_MEDIA_MERCH: 'Film, TV & Hollywood',
};

export interface ContractTemplate {
  /** Stable machine id, e.g. 'MUSIC_SPLIT_SHEET' | 'GAMING_MUSIC_SYNC'. */
  id: string;
  /** Browsing category driving the five-way /templates and vault grouping. */
  category: ContractCategory;
  /** Persistence-safe industry (contracts.industry CHECK domain). */
  industry: ContractIndustry;
  name: string;
  /** Named clauses the template assembles, in document order. */
  clauseOrder: string[];
  /** One-line summary shown on the vault card. */
  summary: string;
}

const template = (
  id: string,
  category: ContractCategory,
  name: string,
  clauseOrder: string[],
  summary: string,
): ContractTemplate => ({
  id,
  category,
  industry: industryForCategory(category),
  name,
  clauseOrder,
  summary,
});

export const TEMPLATES: readonly ContractTemplate[] = [
  // ── Music & Record Label (6) ──────────────────────────────────────────────
  template(
    'MUSIC_SPLIT_SHEET',
    'MUSIC',
    'Songwriter Split Sheet',
    ['preamble', 'workIdentified', 'poolSheets', 'control', 'signatures'],
    'Authoritative ownership percentages across all three Covenant pools.',
  ),
  template(
    'MUSIC_PRODUCER_AGREEMENT',
    'MUSIC',
    'Producer Agreement',
    ['parties', 'engagement', 'deliverables', 'compensation', 'credit', 'masterOwnership', 'signatures'],
    'Engages a producer on a master with ownership and credit terms.',
  ),
  template(
    'MUSIC_MASTER_PURCHASE',
    'MUSIC',
    'Master Recording Rights Purchase',
    ['parties', 'masters', 'purchasePrice', 'delivery', 'warranties', 'signatures'],
    'Transfers ownership of master recording rights for a fixed price.',
  ),
  template(
    'MUSIC_SYNC_LICENSE',
    'MUSIC',
    'Sync License Agreement',
    ['parties', 'licensedWork', 'use', 'territory', 'term', 'fee', 'credit', 'signatures'],
    'Grants an audiovisual synchronization use of the work.',
  ),
  template(
    'MUSIC_PUBLISHING_SPLIT',
    'MUSIC',
    'Co-Publishing Agreement',
    ['parties', 'composition', 'writerShares', 'administration', 'collections', 'signatures'],
    'Fixes co-publisher and writer shares of the composition copyright.',
  ),
  template(
    'MUSIC_WORK_FOR_HIRE',
    'MUSIC',
    'Work For Hire (Session Artist / Engineer)',
    ['parties', 'engagement', 'workMadeForHire', 'compensation', 'ownership', 'waiver', 'signatures'],
    'Commissions a session or engineering contribution as a work made for hire.',
  ),
  // ── Film, TV & Hollywood (4) ──────────────────────────────────────────────
  template(
    'FILM_SCREENPLAY_OPTION',
    'FILM_TV',
    'Screenplay Option & Purchase',
    ['parties', 'property', 'optionGrant', 'term', 'optionFee', 'purchasePrice', 'credit', 'signatures'],
    'Options a screenplay with fee, term, and purchase price.',
  ),
  template(
    'FILM_SCORE_COMPOSER',
    'FILM_TV',
    'Film/TV Score Composer Contract',
    ['parties', 'engagement', 'scoreDelivery', 'masterOwnership', 'credit', 'compensation', 'signatures'],
    'Composes the original score with cue delivery and ownership terms.',
  ),
  template(
    'FILM_DIRECTOR_ENGAGEMENT',
    'FILM_TV',
    'Director Engagement',
    ['parties', 'directorialServices', 'credit', 'compensation', 'term', 'termination', 'signatures'],
    'Engages a director on exclusive terms with credit and commissioning rights.',
  ),
  template(
    'FILM_TALENT_RELEASE',
    'FILM_TV',
    'On-Screen Talent Release',
    ['parties', 'production', 'releaseGrant', 'consideration', 'publicity', 'signatures'],
    'Releases an on-screen performance for production and publicity use (EIDR-mapped works).',
  ),
  // ── Gaming & Interactive (3) ──────────────────────────────────────────────
  template(
    'GAMING_MUSIC_SYNC',
    'GAMING',
    'In-Game Music Sync Licensing',
    ['parties', 'licensedWork', 'interactiveUse', 'territory', 'term', 'fee', 'restrictions', 'signatures'],
    'Licenses music into interactive gameplay across platforms and builds.',
  ),
  template(
    'GAMING_STUDIO_ROYALTY_SPLIT',
    'GAMING',
    'Video Game Developer/Studio Royalty Split',
    ['parties', 'workIdentified', 'poolSheets', 'studioRoyalty', 'collections', 'signatures'],
    'Fixes developer and studio shares of net game receipts.',
  ),
  template(
    'GAMING_VOICEOVER_MOCAP_RELEASE',
    'GAMING',
    'Voiceover/MoCap Release',
    ['parties', 'production', 'performanceRelease', 'consideration', 'publicity', 'signatures'],
    'Releases voice and motion-capture performance for the game and its marketing.',
  ),
  // ── Podcasts, Creators & Streamers (3) ────────────────────────────────────
  template(
    'PODCAST_COHOST_GUEST_SPLIT',
    'CREATORS',
    'Podcast Co-Host & Guest Split',
    ['parties', 'coHostEpisodes', 'poolSheets', 'compensation', 'collections', 'signatures'],
    'Records co-host and guest shares of episode ownership and receipts.',
  ),
  template(
    'FILM_BRAND_ENDORSEMENT',
    'CREATORS',
    'Sponsorship & Brand Deal Contract',
    ['parties', 'campaign', 'sponsorshipDeliverables', 'term', 'compensation', 'usage', 'signatures'],
    'Engages a creator to sponsor a brand across agreed content deliverables.',
  ),
  template(
    'PODCAST_CHANNEL_REVENUE_SHARE',
    'CREATORS',
    'Channel Revenue Share Release',
    ['parties', 'workIdentified', 'poolSheets', 'channelShare', 'signatures'],
    'Releases channel and platform receipts to participants at recorded percentages.',
  ),
  // ── Fashion & Apparel (4) ─────────────────────────────────────────────
  template(
    'FASHION_DESIGN_LICENSE',
    'FASHION',
    'Fashion Design License Agreement',
    ['parties', 'workIdentified', 'designLicense', 'territory', 'term', 'fee', 'credit', 'signatures'],
    'Licenses a fashion design for garment production and distribution.',
  ),
  template(
    'FASHION_APPAREL_PRODUCTION',
    'FASHION',
    'Apparel Manufacturing & Production Agreement',
    ['parties', 'production', 'apparelProduction', 'compensation', 'delivery', 'warranties', 'signatures'],
    'Commissions manufacture of an apparel line to recorded specs and schedules.',
  ),
  template(
    'FASHION_BRAND_COLLABORATION',
    'FASHION',
    'Brand Collaboration Agreement',
    ['parties', 'campaign', 'collabContent', 'term', 'compensation', 'usage', 'signatures'],
    'Fixes a co-branded capsule collaboration with credited contributions.',
  ),
  template(
    'FASHION_RUNWAY_TALENT_RELEASE',
    'FASHION',
    'Runway/Event Talent Release',
    ['parties', 'production', 'runwayRelease', 'consideration', 'publicity', 'signatures'],
    'Releases a runway walk and event performance for documentation and promotion.',
  ),
] as const;

export function getTemplate(id: string): ContractTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function templatesByCategory(category: ContractCategory): readonly ContractTemplate[] {
  return TEMPLATES.filter((t) => t.category === category);
}

/** Clause display labels shared across templates; renderers live in generator.ts. */
export const CLAUSE_LABELS: Record<string, string> = {
  preamble: 'Preamble',
  workIdentified: 'Work Identified',
  poolSheets: 'Pool Split Sheets',
  control: 'Control & Direction',
  parties: 'Parties',
  engagement: 'Engagement',
  deliverables: 'Deliverables',
  compensation: 'Compensation',
  credit: 'Credit',
  masterOwnership: 'Ownership of Masters',
  contribution: 'Contribution',
  licensedWork: 'Licensed Work',
  scope: 'Scope of License',
  territory: 'Territory',
  term: 'Term',
  fee: 'Fee',
  restrictions: 'Restrictions',
  workMadeForHire: 'Work Made For Hire',
  ownership: 'Ownership',
  waiver: 'Waiver of Rights',
  composition: 'Composition',
  writerShares: 'Writer & Publisher Shares',
  administration: 'Administration',
  collections: 'Collections',
  use: 'Use',
  masters: 'Masters Purchased',
  purchasePrice: 'Purchase Price',
  delivery: 'Delivery',
  warranties: 'Warranties',
  originalWork: 'Original Work',
  remixScope: 'Remix Scope',
  clearance: 'Clearance',
  property: 'Property',
  optionGrant: 'Option Grant',
  optionFee: 'Option Fee',
  production: 'Production',
  releaseGrant: 'Release Grant',
  consideration: 'Consideration',
  publicity: 'Publicity',
  artwork: 'Artwork',
  consignmentTerm: 'Consignment Term',
  commission: 'Commission',
  insurance: 'Insurance',
  settlement: 'Settlement',
  campaign: 'Campaign',
  usage: 'Usage Rights',
  expenses: 'Expenses',
  termination: 'Termination',
  signatures: 'Signatures',
  interactiveUse: 'Interactive Use',
  performanceRelease: 'Performance Release',
  channelShare: 'Channel Revenue Share',
  scoreDelivery: 'Score Delivery',
  directorialServices: 'Directorial Services',
  coHostEpisodes: 'Episodes & Contributions',
  sponsorshipDeliverables: 'Sponsorship Deliverables',
  studioRoyalty: 'Royalty Split',
  designLicense: 'Design License',
  apparelProduction: 'Production Terms',
  collabContent: 'Collaboration Deliverables',
  runwayRelease: 'Runway Performance Release',
};
