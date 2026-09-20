/**
 * The master ledger store — the data seam behind every admin master data
 * surface. Two honest modes, one record shape:
 *
 *   - DEMO (isDevSeedMode): the seeded master library — the founder's
 *     8-records-per-vertical richness floor, 48 records, every allocation
 *     computed through the real settle path in settleSovereignRecord.
 *     Rendered ONLY under the DEMO DATA disclosure.
 *   - REAL: derived from the live stores — each settled royalty row becomes
 *     a sovereign record through the SAME allocation path (audio vertical,
     'Commercial Music Releases', the rebuilt platform's registered medium).
 *     Thin where the real ledger is thin — never padded with demo rows.
 */

import { isDevSeedMode } from '@/lib/server/devSeed';
import { listAssets } from '@/lib/sdk';
import { listLedger } from '@/lib/ledger/store';
import { listContracts } from '@/lib/contracts/store';
import {
  MASTER_CATEGORY_ORDER,
  MASTER_SUBCATEGORIES,
  type GlobalEntertainmentCategory,
} from './taxonomy';
import {
  settleSovereignRecord,
  type ClearinghouseStatus,
  type SovereignLedgerRecord,
} from './sovereignLedger';

/** Deterministic settlement instants — the demo view never moves. */
const SEED_SETTLED_AT = [
  '2026-01-15T12:00:00.000Z',
  '2026-02-14T12:00:00.000Z',
  '2026-03-18T12:00:00.000Z',
  '2026-04-21T12:00:00.000Z',
  '2026-05-19T12:00:00.000Z',
  '2026-06-23T12:00:00.000Z',
  '2026-07-21T12:00:00.000Z',
  '2026-08-18T12:00:00.000Z',
] as const;

/** Status rotation — deterministic mix across the clearinghouse domain. */
const SEED_STATUS_ROTATION: readonly ClearinghouseStatus[] = [
  'VERIFIED_IMMUTABLE',
  'ACTIVE_YIELD',
  'VERIFIED_IMMUTABLE',
  'PENDING_CLEARANCE',
  'ACTIVE_YIELD',
  'VERIFIED_IMMUTABLE',
  'ACTIVE_YIELD',
  'PENDING_CLEARANCE',
];

interface SeedEntry {
  readonly title: string;
  readonly subcategory: string;
  readonly grossCents: number;
  readonly holderKey: string;
}

/**
 * The seeded master library — 8 records per vertical, titles written per
 * subcategory so every row reads like the industry it represents. DEMO data:
 * rendered only behind the DEMO DATA disclosure (the founder's standing
 * honesty law — real sessions read real stores).
 */
const SEED_LIBRARY: Record<GlobalEntertainmentCategory, readonly SeedEntry[]> = {
  FILM_AND_TELEVISION: [
    { title: 'Meridian Line — Theatrical', subcategory: 'Theatrical', grossCents: 2_450_000_000, holderKey: 'holder-meridian-studios' },
    { title: 'Harbor Lights — Season 2', subcategory: 'SVOD / Streaming VOD', grossCents: 1_820_000_000, holderKey: 'holder-harbor-lights-llc' },
    { title: 'The Sixth Ward', subcategory: 'Broadcast TV', grossCents: 964_000_000, holderKey: 'holder-sixth-ward-productions' },
    { title: 'Night Orbit — Syndication Package', subcategory: 'Cable Syndication', grossCents: 612_400_000, holderKey: 'holder-night-orbit-media' },
    { title: 'Field Notes: High Desert', subcategory: 'Unscripted & Documentary', grossCents: 328_900_000, holderKey: 'holder-field-notes-collective' },
    { title: 'Crown City Premiere Run', subcategory: 'Theatrical', grossCents: 1_175_000_000, holderKey: 'holder-crown-city-films' },
    { title: 'Static — Limited Series', subcategory: 'SVOD / Streaming VOD', grossCents: 1_538_000_000, holderKey: 'holder-static-series-co' },
    { title: 'True North Docs — Collection', subcategory: 'Unscripted & Documentary', grossCents: 246_700_000, holderKey: 'holder-true-north-docs' },
  ],
  AUDIO_AND_RECORDED_SOUND: [
    { title: 'Midnight Clear — Deluxe Master', subcategory: 'Commercial Music Releases', grossCents: 842_000_000, holderKey: 'holder-midnight-clear-masters' },
    { title: 'The Quiet Machine — Audiobook', subcategory: 'Audiobooks', grossCents: 156_800_000, holderKey: 'holder-quiet-machine-audio' },
    { title: 'Sovereign Signal — Weekly Podcast', subcategory: 'Podcasts', grossCents: 94_200_000, holderKey: 'holder-sovereign-signal-network' },
    { title: 'Golden Hour Radio — Satellite Feed', subcategory: 'Radio & Satellite Streaming', grossCents: 61_500_000, holderKey: 'holder-golden-hour-radio' },
    { title: 'Vault Impacts Vol. 3', subcategory: 'Sound Effects & Sample Libraries', grossCents: 47_300_000, holderKey: 'holder-vault-impacts-library' },
    { title: 'Gold Hours — Remaster', subcategory: 'Commercial Music Releases', grossCents: 1_240_000_000, holderKey: 'holder-gold-hours-masters' },
    { title: 'Deep Field — Spoken Word Edition', subcategory: 'Audiobooks', grossCents: 88_600_000, holderKey: 'holder-deep-field-audio' },
    { title: 'Late Frequencies — Podcast Network', subcategory: 'Podcasts', grossCents: 132_400_000, holderKey: 'holder-late-frequencies-network' },
  ],
  PUBLISHING_AND_LITERARY: [
    { title: 'The Ownership Ledger — Hardcover', subcategory: 'Print Books', grossCents: 214_000_000, holderKey: 'holder-ownership-ledger-press' },
    { title: 'Splits & Style — eBook', subcategory: 'e-Books', grossCents: 67_900_000, holderKey: 'holder-splits-style-digital' },
    { title: 'Covnant Quarterly — Issues 1-8', subcategory: 'Periodicals', grossCents: 42_300_000, holderKey: 'holder-covnant-quarterly' },
    { title: 'Royalty Mathematics — Journal Rights', subcategory: 'Academic & Trade Journals', grossCents: 38_700_000, holderKey: 'holder-royalty-mathematics-journal' },
    { title: 'Gold Hours — Sheet Music & Scores', subcategory: 'Sheet Music & Scores', grossCents: 29_100_000, holderKey: 'holder-gold-hours-scores' },
    { title: 'The Sixth Ward — Novelization', subcategory: 'Print Books', grossCents: 158_500_000, holderKey: 'holder-sixth-ward-literary' },
    { title: 'Meridian Line — Screenplay Edition', subcategory: 'e-Books', grossCents: 54_200_000, holderKey: 'holder-meridian-literary' },
    { title: 'Stand & Deliver — Performance Essays', subcategory: 'Periodicals', grossCents: 31_800_000, holderKey: 'holder-stand-deliver-essays' },
  ],
  LIVE_PERFORMANCE_AND_COMEDY: [
    { title: 'Throne of Laughs — Special', subcategory: 'Stand-Up & Comedy Specials', grossCents: 486_000_000, holderKey: 'holder-throne-of-laughs' },
    { title: 'The Sovereign Stage — Season', subcategory: 'Live Theater & Broadway', grossCents: 1_690_000_000, holderKey: 'holder-sovereign-stage-company' },
    { title: 'Gold Coast Arena Tour', subcategory: 'Concerts & Festival Touring', grossCents: 2_180_000_000, holderKey: 'holder-gold-coast-touring' },
    { title: 'Crown Hall — Ticketing Ledger', subcategory: 'Venue Ticketing Ledgers', grossCents: 394_600_000, holderKey: 'holder-crown-hall-venues' },
    { title: 'Late Set — Comedy Residency', subcategory: 'Stand-Up & Comedy Specials', grossCents: 118_900_000, holderKey: 'holder-late-set-residency' },
    { title: 'District Players — Rep Season', subcategory: 'Live Theater & Broadway', grossCents: 272_300_000, holderKey: 'holder-district-players' },
    { title: 'Meridian Amphitheater Circuit', subcategory: 'Concerts & Festival Touring', grossCents: 921_700_000, holderKey: 'holder-meridian-circuit' },
    { title: 'Festival Grounds — Box Office Pool', subcategory: 'Venue Ticketing Ledgers', grossCents: 655_200_000, holderKey: 'holder-festival-grounds-pool' },
  ],
  INTERACTIVE_AND_DIGITAL_MEDIA: [
    { title: 'Vault Runners — Game of Record', subcategory: 'Video Games', grossCents: 3_120_000_000, holderKey: 'holder-vault-runners-studio' },
    { title: 'Echo Chamber XR', subcategory: 'Immersive & XR', grossCents: 289_500_000, holderKey: 'holder-echo-chamber-xr' },
    { title: 'Splitwright — Studio License', subcategory: 'Software Assets', grossCents: 173_600_000, holderKey: 'holder-splitwright-software' },
    { title: 'Gold Sigils — Collectible Series', subcategory: 'Digital Collectibles & Microtransactions', grossCents: 412_800_000, holderKey: 'holder-gold-sigils-series' },
    { title: 'Meridian Worlds — Expansion', subcategory: 'Video Games', grossCents: 1_470_000_000, holderKey: 'holder-meridian-worlds-studio' },
    { title: 'Bright Volume — VR Concert Hall', subcategory: 'Immersive & XR', grossCents: 96_400_000, holderKey: 'holder-bright-volume-vr' },
    { title: 'LedgerKit — Pro Tooling', subcategory: 'Software Assets', grossCents: 84_900_000, holderKey: 'holder-ledgerkit-tooling' },
    { title: 'Season Pass — Sovereign Skins', subcategory: 'Digital Collectibles & Microtransactions', grossCents: 238_100_000, holderKey: 'holder-sovereign-skins-pass' },
  ],
  COMMERCIAL_AND_BRAND_LICENSING: [
    { title: 'Aurum Motors — Score Placement', subcategory: 'Brand Partnerships', grossCents: 764_000_000, holderKey: 'holder-aurum-motors-brand' },
    { title: 'Crown Cola — Frame Feature', subcategory: 'Product Placement', grossCents: 348_200_000, holderKey: 'holder-crown-cola-placement' },
    { title: 'Sovereign Fit — Apparel Line', subcategory: 'Endorsements', grossCents: 527_400_000, holderKey: 'holder-sovereign-fit-endorsement' },
    { title: 'Gold Ribbon Merch — Drop 4', subcategory: 'Merchandising & Physical Goods', grossCents: 196_300_000, holderKey: 'holder-gold-ribbon-merch' },
    { title: 'Vault Reserve Spirits — Partnership', subcategory: 'Brand Partnerships', grossCents: 1_058_000_000, holderKey: 'holder-vault-reserve-spirits' },
    { title: 'Midnight Clear — Trailer Sync', subcategory: 'Product Placement', grossCents: 143_700_000, holderKey: 'holder-midnight-clear-sync' },
    { title: 'Throne Athletics — Campaign', subcategory: 'Endorsements', grossCents: 689_500_000, holderKey: 'holder-throne-athletics' },
    { title: 'Covnant Vinyl Pressing — Goods Run', subcategory: 'Merchandising & Physical Goods', grossCents: 112_600_000, holderKey: 'holder-covnant-vinyl-goods' },
  ],
};

declare global {
  var __covnantMasterLedger: SovereignLedgerRecord[] | undefined;
}

/** Build the seeded master library — every record through the real settle path. */
function buildSeedLibrary(): SovereignLedgerRecord[] {
  const records: SovereignLedgerRecord[] = [];
  for (const category of MASTER_CATEGORY_ORDER) {
    const entries = SEED_LIBRARY[category];
    if (entries.length !== 8) {
      throw new Error(`masterStore: ${category} must seed 8 records (the richness floor), got ${entries.length}`);
    }
    entries.forEach((entry, index) => {
      records.push(
        settleSovereignRecord({
          category,
          subcategory: entry.subcategory,
          assetTitle: entry.title,
          rightsHolderKey: entry.holderKey,
          grossVolumeCents: entry.grossCents,
          clearinghouseStatus: SEED_STATUS_ROTATION[index],
          settlementTimestamp: SEED_SETTLED_AT[index],
          sequence: index + 1,
        }),
      );
    });
  }
  return records;
}

/** The seeded master library, memoized per server process (deterministic). */
export function seededMasterLedger(): SovereignLedgerRecord[] {
  if (!globalThis.__covnantMasterLedger) {
    globalThis.__covnantMasterLedger = buildSeedLibrary();
  }
  return globalThis.__covnantMasterLedger;
}

/**
 * REAL mode — derive sovereign records from the live stores: every settled
 * royalty row becomes one audio-vertical record through the same allocation
 * path. No demo padding; a thin real ledger renders thin (honestly).
 */
async function deriveMasterLedgerFromRealStores(): Promise<SovereignLedgerRecord[]> {
  const [assets, ledgerRows] = await Promise.all([listAssets(), listLedger()]);
  const assetByCode = new Map(assets.map((asset) => [asset.cbtCode, asset]));
  const category: GlobalEntertainmentCategory = 'AUDIO_AND_RECORDED_SOUND';
  return ledgerRows.map((row, index) => {
    const asset = assetByCode.get(row.cbtCode);
    const holderKey = asset
      ? asset.rightsHolders.map((holder) => holder.id).join(',')
      : row.cbtCode;
    return settleSovereignRecord({
      category,
      subcategory: 'Commercial Music Releases',
      assetTitle: asset?.title ?? row.cbtCode,
      rightsHolderKey: holderKey,
      grossVolumeCents: row.grossSettled,
      clearinghouseStatus: 'VERIFIED_IMMUTABLE',
      settlementTimestamp: row.createdAt,
      sequence: index + 1,
    });
  });
}

/**
 * The master ledger for the current mode: the seeded library in demo/preview
 * (under the DEMO DATA disclosure), the derived real records otherwise.
 */
export async function resolveMasterLedger(): Promise<{
  readonly demo: boolean;
  readonly records: readonly SovereignLedgerRecord[];
}> {
  if (isDevSeedMode()) {
    return { demo: true, records: seededMasterLedger() };
  }
  return { demo: false, records: await deriveMasterLedgerFromRealStores() };
}

/** Filter to one vertical; null = all verticals. */
export function recordsForCategory(
  records: readonly SovereignLedgerRecord[],
  category: GlobalEntertainmentCategory | null,
): SovereignLedgerRecord[] {
  return category ? records.filter((record) => record.category === category) : [...records];
}

// ─────────────────────────────────────────────────────────────────────────────
// The Sovereign Contract Factory — master template library (founder canon,
// CovnantTemplatesSDK drop, 2026-09-20). One `ContractTemplateRecord` per
// factory template: the four founder-verbatim seeds plus a completed library
// so EVERY subcategory form of the master taxonomy carries at least one
// template — comedy, audiobooks, podcasts, games, XR, endorsements, merch,
// theater, festivals, journals, sheet music, all of it.
//
// Honesty law: these records live in the STORE (this file) — components never
// inline template literals. The compact founder `verticalCategory` codes map
// onto the master taxonomy keys; the 50/35/15 weights are compiler-enforced
// literals, so a record cannot exist off the canon structure.
// ─────────────────────────────────────────────────────────────────────────────

/** The founder's compact vertical codes (CovnantTemplatesSDK canon). */
export type TemplateVerticalCategory =
  | 'AUDIO_SOUND'
  | 'FILM_TV'
  | 'PUBLISHING'
  | 'LIVE_COMEDY'
  | 'INTERACTIVE'
  | 'BRAND_LICENSING';

/** The two canon execution states of the factory. */
export type TemplateExecutionStatus = 'PRODUCTION_READY' | 'LEGAL_VAULT_LOCKED';

/**
 * The factory's allocation structure — the 50/35/15 weights as literal
 * types: the compiler refuses any other structure, and the pills on
 * /templates render from these fields, never from a display constant.
 */
export interface TemplateSplitStructure {
  readonly ownershipReserve: 50;
  readonly creativePayout: 35;
  readonly operationsYield: 15;
}

/** One master template of the Sovereign Contract Factory (founder canon). */
export interface ContractTemplateRecord {
  /** Stable machine id, e.g. 'TPL-AUD-001' — the founder's ids are fixed. */
  readonly templateId: string;
  readonly templateName: string;
  /** Compact founder code — mapped onto the master taxonomy for the tabs. */
  readonly verticalCategory: TemplateVerticalCategory;
  /** Industry-facing subcategory label (seeds use founder-verbatim labels). */
  readonly subCategory: string;
  /** Jurisdiction of record, e.g. 'US-TX Sovereign Ledger Standard'. */
  readonly governingJurisdiction: string;
  readonly splitStructure: TemplateSplitStructure;
  /** The template's engineered key clauses, in document order. */
  readonly keyClauses: readonly string[];
  readonly executionStatus: TemplateExecutionStatus;
  readonly timesExecuted: number;
}

/** Compact founder codes → master taxonomy keys (the tab filter mapping). */
export const TEMPLATE_VERTICAL_TO_MASTER: Record<TemplateVerticalCategory, GlobalEntertainmentCategory> = {
  AUDIO_SOUND: 'AUDIO_AND_RECORDED_SOUND',
  FILM_TV: 'FILM_AND_TELEVISION',
  PUBLISHING: 'PUBLISHING_AND_LITERARY',
  LIVE_COMEDY: 'LIVE_PERFORMANCE_AND_COMEDY',
  INTERACTIVE: 'INTERACTIVE_AND_DIGITAL_MEDIA',
  BRAND_LICENSING: 'COMMERCIAL_AND_BRAND_LICENSING',
};

/** The canon split structure — one constant, so no record can drift. */
const CANON_SPLIT: TemplateSplitStructure = {
  ownershipReserve: 50,
  creativePayout: 35,
  operationsYield: 15,
};

/** Factory record constructor — fills the canon split structure. */
function factoryTemplate(
  templateId: string,
  templateName: string,
  verticalCategory: TemplateVerticalCategory,
  subCategory: string,
  governingJurisdiction: string,
  keyClauses: readonly string[],
  executionStatus: TemplateExecutionStatus,
  timesExecuted: number,
): ContractTemplateRecord {
  return {
    templateId,
    templateName,
    verticalCategory,
    subCategory,
    governingJurisdiction,
    splitStructure: CANON_SPLIT,
    keyClauses,
    executionStatus,
    timesExecuted,
  };
}

/**
 * The master template library — 31 factory records. The four founder-verbatim
 * seeds lead their verticals EXACTLY as dropped (ids, names, subcategories,
 * jurisdictions, clauses, counts); the remaining records complete the
 * founder's directive that every entertainment form is covered, written in
 * his voice (Sovereign Ledger Standard naming, engineered clause names).
 */
export const MASTER_TEMPLATE_LIBRARY: readonly ContractTemplateRecord[] = Object.freeze([
  // ── AUDIO_SOUND — Audio & Recorded Sound ────────────────────────────────
  factoryTemplate(
    'TPL-AUD-001',
    'Master Recording & Streaming Royalty Agreement',
    'AUDIO_SOUND',
    'Master Recording',
    'US-TX Sovereign Ledger Standard',
    ['Sub-Second Micro-Royalty Routing', 'Direct PRO/ISRC Telemetry Binding', 'Dispute Immunity Shield'],
    'PRODUCTION_READY',
    1420,
  ),
  factoryTemplate(
    'TPL-AUD-002',
    'Album Release & Master Royalty Distribution Agreement',
    'AUDIO_SOUND',
    'Commercial Music Releases',
    'US-TX Sovereign Ledger Standard',
    ['Master Ownership Ledger Entry', 'Per-Stream Royalty Auto-Split', 'Reversion & Term Audit Gate'],
    'PRODUCTION_READY',
    1104,
  ),
  factoryTemplate(
    'TPL-AUD-003',
    'Podcast Network & Episode Licensing',
    'AUDIO_SOUND',
    'Podcasts',
    'US-TX Sovereign Ledger Standard',
    ['Per-Episode Micro-Royalty Routing', 'Dynamic Ad-Insert Telemetry Binding', 'Network Recapture Shield'],
    'PRODUCTION_READY',
    947,
  ),
  factoryTemplate(
    'TPL-AUD-004',
    'Radio & Satellite Broadcast Sync License',
    'AUDIO_SOUND',
    'Radio & Satellite Streaming',
    'US-TX Sovereign Ledger Standard',
    ['Broadcast Airplay Telemetry Binding', 'Station Clearance Escrow', 'Performance Rights Auto-Routing'],
    'PRODUCTION_READY',
    726,
  ),
  factoryTemplate(
    'TPL-AUD-005',
    'Audiobook Production & Narration Rights Agreement',
    'AUDIO_SOUND',
    'Audiobooks',
    'US-TX Sovereign Ledger Standard',
    ['Narration Deliverable Escrow', 'Per-Hour Listen Royalty Split', 'ISBN/ASIN Unified Registry'],
    'PRODUCTION_READY',
    638,
  ),
  factoryTemplate(
    'TPL-AUD-006',
    'Sample Pack & Sound Effects Library License',
    'AUDIO_SOUND',
    'Sound Effects & Sample Libraries',
    'US-TX Sovereign Ledger Standard',
    ['Sample Clearance Vault', 'Per-Insert Micro-License Telemetry', 'Derivative Work Immunity Shield'],
    'LEGAL_VAULT_LOCKED',
    583,
  ),
  // ── FILM_TV — Film & Television ─────────────────────────────────────────
  factoryTemplate(
    'TPL-FLM-004',
    'Global SVOD & AVOD Distribution Option Contract',
    'FILM_TV',
    'Streaming Licensing',
    'US-DE Corporate Standard',
    ['Territory Escrow Clearance', 'ISAN/EIDR Automated Tracking', 'Net Residual Auto-Split'],
    'PRODUCTION_READY',
    890,
  ),
  factoryTemplate(
    'TPL-FLM-007',
    'Theatrical Distribution & Box Office Settlement',
    'FILM_TV',
    'Theatrical',
    'US-DE Corporate Standard',
    ['Box Office Gross Escrow', 'Per-Screen Settlement Telemetry', 'Studio Overlay Auto-Distribution'],
    'PRODUCTION_READY',
    812,
  ),
  factoryTemplate(
    'TPL-FLM-006',
    'Streaming Originals Licensing & Residual Settlement',
    'FILM_TV',
    'SVOD / Streaming VOD',
    'US-DE Corporate Standard',
    ['Originals Commission Escrow', 'Completion Telemetry Binding', 'Residual Pool Auto-Split'],
    'PRODUCTION_READY',
    779,
  ),
  factoryTemplate(
    'TPL-FLM-002',
    'Broadcast Network Programming License',
    'FILM_TV',
    'Broadcast TV',
    'US-DE Corporate Standard',
    ['Network License Term Gate', 'Ratings Telemetry Binding', 'Residual Pool Auto-Split'],
    'PRODUCTION_READY',
    764,
  ),
  factoryTemplate(
    'TPL-FLM-003',
    'Syndication Package Agreement',
    'FILM_TV',
    'Cable Syndication',
    'US-DE Corporate Standard',
    ['Syndication Clearances Escrow', 'Market-by-Market Telemetry', 'Barter Split Auto-Routing'],
    'PRODUCTION_READY',
    703,
  ),
  factoryTemplate(
    'TPL-FLM-005',
    'Unscripted & Documentary Production Agreement',
    'FILM_TV',
    'Unscripted & Documentary',
    'US-DE Corporate Standard',
    ['Footage & Archival Clearance Vault', 'Contingency Escrow Gate', 'Backend Definition Shield'],
    'PRODUCTION_READY',
    671,
  ),
  // ── PUBLISHING — Publishing & Literary ──────────────────────────────────
  factoryTemplate(
    'TPL-LIT-002',
    'Audiobook & Digital E-Book Rights Acquisition',
    'PUBLISHING',
    'Audiobook Publishing',
    'US-TX Sovereign Ledger Standard',
    ['Print-On-Demand Realtime Ledger', 'ISBN Unified Registry', 'Automated Author Drawdown'],
    'PRODUCTION_READY',
    512,
  ),
  factoryTemplate(
    'TPL-LIT-001',
    'Print Book Publishing Agreement',
    'PUBLISHING',
    'Print Books',
    'US-TX Sovereign Ledger Standard',
    ['Advance & Earn-Out Ledger', 'Print Run Royalty Telemetry', 'Subsidiary Rights Auto-Split'],
    'PRODUCTION_READY',
    486,
  ),
  factoryTemplate(
    'TPL-LIT-003',
    'Digital E-Book Distribution & Royalty Agreement',
    'PUBLISHING',
    'e-Books',
    'US-TX Sovereign Ledger Standard',
    ['Per-Copy Micro-Royalty Routing', 'Retail Channel Telemetry Binding', 'Reversion Audit Gate'],
    'PRODUCTION_READY',
    441,
  ),
  factoryTemplate(
    'TPL-LIT-004',
    'Periodical & Serial Rights License',
    'PUBLISHING',
    'Periodicals',
    'US-TX Sovereign Ledger Standard',
    ['Issue-by-Issue Settlement Gate', 'Serial Rights Telemetry Binding', 'Reprint Royalty Auto-Split'],
    'PRODUCTION_READY',
    397,
  ),
  factoryTemplate(
    'TPL-LIT-005',
    'Academic & Trade Journal Licensing',
    'PUBLISHING',
    'Academic & Trade Journals',
    'US-TX Sovereign Ledger Standard',
    ['Institutional Access Escrow', 'Citation Telemetry Binding', 'Author Royalty Auto-Routing'],
    'PRODUCTION_READY',
    318,
  ),
  factoryTemplate(
    'TPL-LIT-006',
    'Sheet Music & Score Print License',
    'PUBLISHING',
    'Sheet Music & Scores',
    'US-TX Sovereign Ledger Standard',
    ['Print Edition Royalty Split', 'Engraving Deliverable Escrow', 'Performance Right Registry'],
    'LEGAL_VAULT_LOCKED',
    218,
  ),
  // ── LIVE_COMEDY — Live Performance & Comedy ─────────────────────────────
  factoryTemplate(
    'TPL-LVE-009',
    'Live Stand-Up & Concert Touring Ticket Escrow',
    'LIVE_COMEDY',
    'Live Venue Performance',
    'US-TX Sovereign Ledger Standard',
    ['Live Venue Settlement Gate', 'Promoter/Artist Instant Allocation', 'Ticket Sales Escrow'],
    'PRODUCTION_READY',
    320,
  ),
  factoryTemplate(
    'TPL-LVE-001',
    'Stand-Up Special Production & Distribution Agreement',
    'LIVE_COMEDY',
    'Stand-Up & Comedy Specials',
    'US-TX Sovereign Ledger Standard',
    ['Special Premiere Escrow Gate', 'Audience Telemetry Binding', 'Touring Rights Auto-Routing'],
    'PRODUCTION_READY',
    296,
  ),
  factoryTemplate(
    'TPL-LVE-002',
    'Theater & Broadway Run License',
    'LIVE_COMEDY',
    'Live Theater & Broadway',
    'US-TX Sovereign Ledger Standard',
    ['Weekly Gross Settlement Gate', 'House Seat Escrow Clearance', 'Creative Team Auto-Split'],
    'PRODUCTION_READY',
    274,
  ),
  factoryTemplate(
    'TPL-LVE-003',
    'Festival & Touring Performance Agreement',
    'LIVE_COMEDY',
    'Concerts & Festival Touring',
    'US-TX Sovereign Ledger Standard',
    ['Guarantee & Overage Escrow', 'Per-Show Settlement Telemetry', 'Cancellation Immunity Shield'],
    'PRODUCTION_READY',
    251,
  ),
  factoryTemplate(
    'TPL-LVE-004',
    'Venue Ticketing & Box Office Settlement',
    'LIVE_COMEDY',
    'Venue Ticketing Ledgers',
    'US-TX Sovereign Ledger Standard',
    ['Ticket Sales Escrow', 'Per-Scan Settlement Telemetry', 'Facility Fee Auto-Split'],
    'PRODUCTION_READY',
    228,
  ),
  // ── INTERACTIVE — Interactive & Digital Media ───────────────────────────
  factoryTemplate(
    'TPL-INT-001',
    'Video Game Distribution & Microtransaction Royalty Agreement',
    'INTERACTIVE',
    'Video Games',
    'US-DE Corporate Standard',
    ['Platform Storefront Escrow', 'Per-Transaction Micro-Royalty Routing', 'Live-Ops Telemetry Binding'],
    'PRODUCTION_READY',
    1338,
  ),
  factoryTemplate(
    'TPL-INT-002',
    'Immersive & XR Experience License',
    'INTERACTIVE',
    'Immersive & XR',
    'UK-ENG Sovereign Ledger Standard',
    ['Venue-Free Distribution Escrow', 'Session Telemetry Binding', 'Hardware Recapture Shield'],
    'LEGAL_VAULT_LOCKED',
    407,
  ),
  factoryTemplate(
    'TPL-INT-003',
    'Software Asset & Tools License',
    'INTERACTIVE',
    'Software Assets',
    'US-DE Corporate Standard',
    ['Seat License Escrow Clearance', 'Usage Telemetry Binding', 'Update Channel Auto-Routing'],
    'PRODUCTION_READY',
    692,
  ),
  factoryTemplate(
    'TPL-INT-004',
    'Digital Collectibles & Microtransaction Agreement',
    'INTERACTIVE',
    'Digital Collectibles & Microtransactions',
    'US-DE Corporate Standard',
    ['Drop Window Escrow Gate', 'Secondary Market Royalty Split', 'Provenance Ledger Binding'],
    'PRODUCTION_READY',
    854,
  ),
  // ── BRAND_LICENSING — Commercial & Brand Licensing ──────────────────────
  factoryTemplate(
    'TPL-BRD-001',
    'Brand Partnership & Co-Marketing Agreement',
    'BRAND_LICENSING',
    'Brand Partnerships',
    'US-DE Corporate Standard',
    ['Campaign Deliverable Escrow', 'Impression Telemetry Binding', 'Co-op Spend Auto-Split'],
    'PRODUCTION_READY',
    1021,
  ),
  factoryTemplate(
    'TPL-BRD-002',
    'Product Placement Agreement',
    'BRAND_LICENSING',
    'Product Placement',
    'US-DE Corporate Standard',
    ['Frame Feature Escrow Clearance', 'Airtime Telemetry Binding', 'Season Renewal Auto-Routing'],
    'PRODUCTION_READY',
    768,
  ),
  factoryTemplate(
    'TPL-BRD-003',
    'Endorsement & Talent Agreement',
    'BRAND_LICENSING',
    'Endorsements',
    'US-DE Corporate Standard',
    ['Talent Compensation Escrow', 'Usage Window Telemetry Binding', 'Morals Clause Immunity Shield'],
    'PRODUCTION_READY',
    933,
  ),
  factoryTemplate(
    'TPL-BRD-004',
    'Merchandising & Physical Goods License',
    'BRAND_LICENSING',
    'Merchandising & Physical Goods',
    'US-DE Corporate Standard',
    ['Per-Unit Royalty Routing', 'Sell-Through Telemetry Binding', 'Inventory Liquidation Escrow'],
    'PRODUCTION_READY',
    615,
  ),
]);

/** The founder-verbatim seeds — the library is incomplete without all four. */
const FOUNDER_SEED_IDS: readonly string[] = [
  'TPL-AUD-001',
  'TPL-FLM-004',
  'TPL-LIT-002',
  'TPL-LVE-009',
];

/**
 * The library's integrity gate — runs once at module load and THROWS on any
 * violation, so a broken library can never render as a working page (the
 * devSeed law: never a half-seeded store). Fails on a missing founder seed,
 * a duplicate id, a count below zero, an empty clause list, or — the
 * founder's "don't leave any form out" directive — a master-taxonomy
 * subcategory with no template of its vertical.
 */
function assertLibraryIntegrity(): void {
  const byId = new Map<string, ContractTemplateRecord>();
  for (const record of MASTER_TEMPLATE_LIBRARY) {
    if (byId.has(record.templateId)) {
      throw new Error(`masterStore: duplicate template id ${record.templateId}`);
    }
    byId.set(record.templateId, record);
    if (record.timesExecuted < 0 || !Number.isInteger(record.timesExecuted)) {
      throw new Error(`masterStore: ${record.templateId} timesExecuted must be a non-negative integer`);
    }
    if (record.keyClauses.length === 0 || record.keyClauses.some((clause) => clause.trim() === '')) {
      throw new Error(`masterStore: ${record.templateId} must carry non-empty key clauses`);
    }
  }
  for (const seedId of FOUNDER_SEED_IDS) {
    if (!byId.has(seedId)) {
      throw new Error(`masterStore: founder seed ${seedId} is missing from the template library`);
    }
  }
  for (const [vertical, masterCategory] of Object.entries(TEMPLATE_VERTICAL_TO_MASTER) as Array<
    [TemplateVerticalCategory, GlobalEntertainmentCategory]
  >) {
    const covered = new Set(
      MASTER_TEMPLATE_LIBRARY
        .filter((record) => record.verticalCategory === vertical)
        .map((record) => record.subCategory),
    );
    for (const subcategory of MASTER_SUBCATEGORIES[masterCategory]) {
      if (!covered.has(subcategory)) {
        throw new Error(
          `masterStore: master taxonomy subcategory "${subcategory}" (${masterCategory}) has no template — every form of entertainment must be covered`,
        );
      }
    }
  }
}
assertLibraryIntegrity();

/** Filter the library to one master vertical; null = the whole library. */
export function masterTemplatesForCategory(
  records: readonly ContractTemplateRecord[],
  category: GlobalEntertainmentCategory | null,
): readonly ContractTemplateRecord[] {
  return category
    ? records.filter((record) => TEMPLATE_VERTICAL_TO_MASTER[record.verticalCategory] === category)
    : [...records];
}

/**
 * REAL mode — execution counts derive from the live contract store: a
 * template's timesExecuted is the number of stored contracts minted from
 * that template id. Thin where the real ledger is thin — never padded with
 * demo counts.
 */
/** Derive real-mode execution counts from the live contract store. */
function withRealExecutionCounts<T extends { readonly templateId: string; readonly timesExecuted: number }>(
  records: readonly T[],
  contracts: ReadonlyArray<{ templateId: string }>,
): T[] {
  const executions = new Map<string, number>();
  for (const contract of contracts) {
    executions.set(contract.templateId, (executions.get(contract.templateId) ?? 0) + 1);
  }
  return records.map((record) => ({
    ...record,
    timesExecuted: executions.get(record.templateId) ?? 0,
  }));
}

export function applyRealExecutionCounts(
  records: readonly ContractTemplateRecord[],
  contracts: ReadonlyArray<{ templateId: string }>,
): ContractTemplateRecord[] {
  return withRealExecutionCounts(records, contracts);
}

/**
 * The master templates for the current mode — the seeded factory library in
 * demo/preview (under the DEMO DATA disclosure), the same canon definitions
 * with live-store execution counts otherwise.
 */
export async function resolveMasterTemplates(): Promise<{
  readonly demo: boolean;
  readonly records: readonly ContractTemplateRecord[];
}> {
  if (isDevSeedMode()) {
    return { demo: true, records: MASTER_TEMPLATE_LIBRARY };
  }
  const contracts = await listContracts();
  return { demo: false, records: applyRealExecutionCounts(MASTER_TEMPLATE_LIBRARY, contracts) };
}

// ─────────────────────────────────────────────────────────────────────────────
// The Sovereign Clearing Framework — the ATOMIC REGISTRY (founder canon,
// CovnantAtomicDataSDK drop, 2026-09-20). The factory's granular ledger: 26
// ATOMIC SECTORS, every one carrying at least one clearing record — the seven
// founder-verbatim seeds EXACTLY as dropped, the remaining sectors written in
// the founder's voice (engineered escrow locks, settlement gates, micro
// routing, asset isolation). Zero Ampersands: the atomic registry's names and
// clauses read 'and', never '&'.
//
// Honesty law, unchanged: every record lives HERE in the master store —
// components never inline atomic literals. The sector→master-vertical mapping
// keeps the frozen six-tab filter authoritative: each vertical tab renders the
// atomic records of the sectors that map to it.
// ─────────────────────────────────────────────────────────────────────────────

/** The founder's 26 atomic sectors (CovnantAtomicDataSDK canon) — exact. */
export type AtomicSector =
  | 'MUSIC'
  | 'GAMING'
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
  | 'FASHION'
  | 'MODELING'
  | 'CAD'
  | 'VISUAL_ARTS'
  | 'DESIGN'
  | 'BOOKS'
  | 'LITERATURE'
  | 'DIGITAL_ASSETS'
  | 'SOFTWARE'
  | 'VTUBING'
  | 'VIRTUAL_AVATARS';

/** Canon display order of the 26 sectors — the registry manifest order. */
export const ATOMIC_SECTOR_ORDER: readonly AtomicSector[] = Object.freeze([
  'MUSIC',
  'GAMING',
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
  'FASHION',
  'MODELING',
  'CAD',
  'VISUAL_ARTS',
  'DESIGN',
  'BOOKS',
  'LITERATURE',
  'DIGITAL_ASSETS',
  'SOFTWARE',
  'VTUBING',
  'VIRTUAL_AVATARS',
] as const);

/**
 * One atomic clearing record of the Sovereign Clearing Framework (founder
 * canon): the granular sector record with its entityType, its telemetry
 * metric, and the same compiler-locked 50/35/15 structure as the factory.
 */
export interface AtomicContractRecord {
  readonly templateId: string;
  readonly templateName: string;
  readonly atomicSector: AtomicSector;
  /** The industry entity of record, e.g. 'Film Studio'. */
  readonly entityType: string;
  /** The telemetry stream the clearing settles on, e.g. 'Box Office Gross Receipts and ISAN Telemetry'. */
  readonly telemetryMetric: string;
  readonly splitStructure: TemplateSplitStructure;
  readonly keyClauses: readonly string[];
  readonly executionStatus: TemplateExecutionStatus;
  readonly timesExecuted: number;
}

/** Atomic sector → master vertical — the frozen six-tab filter mapping. */
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
  SPORTS: 'LIVE_PERFORMANCE_AND_COMEDY',
  MOTORSPORT: 'LIVE_PERFORMANCE_AND_COMEDY',
  ARENA: 'LIVE_PERFORMANCE_AND_COMEDY',
  ATHLETICS: 'LIVE_PERFORMANCE_AND_COMEDY',
  GAMING: 'INTERACTIVE_AND_DIGITAL_MEDIA',
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
};

/** Atomic record constructor — fills the canon split structure. */
function atomicTemplate(
  templateId: string,
  templateName: string,
  atomicSector: AtomicSector,
  entityType: string,
  telemetryMetric: string,
  keyClauses: readonly string[],
  executionStatus: TemplateExecutionStatus,
  timesExecuted: number,
): AtomicContractRecord {
  return {
    templateId,
    templateName,
    atomicSector,
    entityType,
    telemetryMetric,
    splitStructure: CANON_SPLIT,
    keyClauses,
    executionStatus,
    timesExecuted,
  };
}

/**
 * The atomic registry — 26 sector records. The seven founder-verbatim seeds
 * lead EXACTLY as dropped (ids, names, sectors, entity types, telemetry
 * metrics, clauses, counts); the remaining sectors complete the founder's
 * standing directive that no sector form is left out.
 */
export const ATOMIC_TEMPLATE_REGISTRY: readonly AtomicContractRecord[] = Object.freeze([
  // ── FILM_AND_TELEVISION ─────────────────────────────────────────────────
  atomicTemplate(
    'TPL-MOV-001',
    'Movie Studio Catalog Distribution Clearing',
    'MOVIES',
    'Movie Studio',
    'Catalog License Fees and Library Circulation Counts',
    ['Catalog Distribution Escrow', 'Library Yield Settlement Gate', 'Catalog Reversion Lock'],
    'LEGAL_VAULT_LOCKED',
    560,
  ),
  atomicTemplate(
    'TPL-FLM-001',
    'Feature Film Theatrical Distribution Master Agreement',
    'FILM',
    'Film Studio',
    'Box Office Gross Receipts and ISAN Telemetry',
    ['Box Office Gross Escrow Lock', 'Territorial Window Distribution Gate', 'ISAN Asset Tracking'],
    'PRODUCTION_READY',
    890,
  ),
  atomicTemplate(
    'TPL-TV-001',
    'Linear Television Broadcast Syndication Contract',
    'TV',
    'Broadcaster',
    'Nielsen Ratings and Linear Commercial Flight Minutes',
    ['Ad Insertion Micro Routing', 'Syndication Reversion Lock', 'Territory Airtime Escrow'],
    'PRODUCTION_READY',
    620,
  ),
  atomicTemplate(
    'TPL-VID-001',
    'Video Content Platform Distribution Clearing',
    'VIDEO',
    'Video Platform',
    'View Duration Minutes and Creator Fund Distributions',
    ['View Yield Escrow Lock', 'Distribution Settlement Gate', 'Creator Payout Micro Routing'],
    'PRODUCTION_READY',
    830,
  ),
  atomicTemplate(
    'TPL-STR-001',
    'Platform Subscription Content Yield Clearing',
    'STREAMING',
    'Streaming Platform',
    'Subscriber Watch Hours and Retention Telemetry',
    ['Subscription Pool Escrow Lock', 'Watch Hour Yield Gate', 'Catalog Reversion Settlement'],
    'PRODUCTION_READY',
    1040,
  ),
  // ── AUDIO_AND_RECORDED_SOUND ────────────────────────────────────────────
  atomicTemplate(
    'TPL-MUS-001',
    'Master Recording Rights and Royalty Clearing',
    'MUSIC',
    'Record Label',
    'Stream Counts and ISRC Royalty Receipts',
    ['Master Rights Escrow Lock', 'Per Stream Royalty Settlement Gate', 'ISRC Telemetry Routing'],
    'PRODUCTION_READY',
    1320,
  ),
  atomicTemplate(
    'TPL-PDC-001',
    'Podcast Network Advertising Yield Clearing',
    'PODCASTING',
    'Podcast Network',
    'Episode Downloads and Ad Insert Impressions',
    ['Ad Yield Escrow Lock', 'Download Settlement Gate', 'Network Feed Isolation Shield'],
    'PRODUCTION_READY',
    690,
  ),
  // ── PUBLISHING_AND_LITERARY ─────────────────────────────────────────────
  atomicTemplate(
    'TPL-PUB-001',
    'Publisher Catalog Rights Clearing',
    'PUBLISHING',
    'Publisher Catalog',
    'Rights Licensing Fees and Catalog Circulation',
    ['Catalog Rights Escrow Lock', 'Licensing Settlement Gate', 'Subsidiary Rights Isolation Shield'],
    'PRODUCTION_READY',
    590,
  ),
  atomicTemplate(
    'TPL-BOK-001',
    'Book Publishing and Advance Clearing',
    'BOOKS',
    'Trade Publisher',
    'Copy Sales and Advance Earnout Receipts',
    ['Advance Recoupment Escrow', 'Copy Sale Royalty Gate', 'Rights Reversion Lock'],
    'PRODUCTION_READY',
    610,
  ),
  atomicTemplate(
    'TPL-LTR-001',
    'Literary Work Serial Rights Clearing',
    'LITERATURE',
    'Serial Publication',
    'Serial Installment Reads and Syndication Placements',
    ['Serial Rights Escrow Lock', 'Installment Payout Gate', 'Syndication Reversion Settlement'],
    'PRODUCTION_READY',
    430,
  ),
  // ── LIVE_PERFORMANCE_AND_COMEDY ─────────────────────────────────────────
  atomicTemplate(
    'TPL-SPT-001',
    'League Broadcast Rights Clearing',
    'SPORTS',
    'League Office',
    'Broadcast Viewership and Gate Receipt Telemetry',
    ['Broadcast Rights Escrow Lock', 'League Revenue Settlement Gate', 'Franchise Split Routing'],
    'PRODUCTION_READY',
    880,
  ),
  atomicTemplate(
    'TPL-MTR-001',
    'Motorsport Circuit Trackage Media Rights Agreement',
    'MOTORSPORT',
    'Motorsport Circuit',
    'Telemetry Track Telematics and Pit Revenue',
    ['Lap Time Broadcast Micro Payouts', 'Circuit Pit Lane Asset Lock', 'Telemetry Escrow Gate'],
    'PRODUCTION_READY',
    210,
  ),
  atomicTemplate(
    'TPL-ARN-001',
    'Arena Venue Facility Access and Gate Yield Clearing',
    'ARENA',
    'Arena Operator',
    'Turnstile Gate Foot Traffic and Venue Concessions',
    ['Sub Second Turnstile Settlement', 'Facility Fee Floor Gate', 'In Venue Commercial Clearing'],
    'PRODUCTION_READY',
    430,
  ),
  atomicTemplate(
    'TPL-ATH-001',
    'Athlete Endorsement and NIL Clearing',
    'ATHLETICS',
    'NIL Athlete',
    'Endorsement Impressions and Confirmed Appearance Bookings',
    ['Endorsement Escrow Lock', 'Appearance Settlement Gate', 'NIL Rights Isolation Shield'],
    'PRODUCTION_READY',
    760,
  ),
  // ── INTERACTIVE_AND_DIGITAL_MEDIA ───────────────────────────────────────
  atomicTemplate(
    'TPL-GAM-001',
    'Game Studio Distribution and Microtransaction Clearing',
    'GAMING',
    'Game Studio',
    'Player Session Hours and In-Game Purchase Volume',
    ['Microtransaction Settlement Escrow', 'Studio Distribution Yield Gate', 'Save Asset Isolation Lock'],
    'PRODUCTION_READY',
    1180,
  ),
  atomicTemplate(
    'TPL-IXP-001',
    'Interactive Experience License Clearing',
    'INTERACTIVE',
    'Experience Producer',
    'Session Participation and Interactive Event Placements',
    ['Experience License Escrow', 'Session Yield Settlement Gate', 'Interactive Asset Isolation Lock'],
    'PRODUCTION_READY',
    470,
  ),
  atomicTemplate(
    'TPL-SFT-001',
    'Software License and Seat Yield Clearing',
    'SOFTWARE',
    'Software Vendor',
    'Active Seat Counts and License Key Activations',
    ['Seat Yield Escrow Lock', 'License Activation Settlement Gate', 'Source Code Isolation Shield'],
    'PRODUCTION_READY',
    720,
  ),
  atomicTemplate(
    'TPL-DGA-001',
    'Digital Asset Vault Custody Clearing',
    'DIGITAL_ASSETS',
    'Asset Custodian',
    'Vault Access Events and Asset Transfer Volume',
    ['Custody Vault Escrow Lock', 'Transfer Settlement Gate', 'Zero Knowledge Custody Shield'],
    'LEGAL_VAULT_LOCKED',
    380,
  ),
  atomicTemplate(
    'TPL-CAD-001',
    '3D CAD Mesh Spatial Asset Licensing Agreement',
    'CAD',
    'CAD Asset Store',
    'Direct Polygon Mesh Downloads and API Invocations',
    ['Spatial Polygon Licensing Lock', 'Automated Render Engine Yield', 'Zero Knowledge Asset Protection'],
    'PRODUCTION_READY',
    1150,
  ),
  atomicTemplate(
    'TPL-SOC-001',
    'Creator Channel Monetization Clearing',
    'SOCIAL_MEDIA',
    'Channel Creator',
    'Impression Counts and Creator Fund Distributions',
    ['Impression Micro Payout Routing', 'Brand Deal Escrow Gate', 'Channel Asset Isolation Lock'],
    'PRODUCTION_READY',
    960,
  ),
  atomicTemplate(
    'TPL-VTB-001',
    'Virtual Avatar Rigging and Model Ownership Contract',
    'VTUBING',
    'Virtual Avatar Creator',
    'Stream Frame Render Hours and Direct Fan Micro Tipping',
    ['Live Stream Micro Tipping Telemetry', 'Rigging Model IP Isolation', 'Syndicated Avatar Split'],
    'PRODUCTION_READY',
    980,
  ),
  atomicTemplate(
    'TPL-VAV-001',
    'Avatar Licensing and Appearance Clearing',
    'VIRTUAL_AVATARS',
    'Avatar Owner',
    'Avatar Appearance Sessions and Licensing Placements',
    ['Appearance Fee Escrow Lock', 'Licensing Yield Settlement Gate', 'Avatar Identity Isolation Shield'],
    'PRODUCTION_READY',
    340,
  ),
  // ── COMMERCIAL_AND_BRAND_LICENSING ──────────────────────────────────────
  atomicTemplate(
    'TPL-FSH-001',
    'Physical Garment High Volume Production Contract',
    'FASHION',
    'Fashion House',
    'Cut and Sew Unit Yield and Wholesale Inventory',
    ['Continuous Floor Manufacturing Escrow', 'Unit Run Payout Gate', 'DTC Order Settlement'],
    'PRODUCTION_READY',
    540,
  ),
  atomicTemplate(
    'TPL-MDL-001',
    'Runway and Campaign Booking Clearing',
    'MODELING',
    'Modeling Agency',
    'Runway Show Counts and Campaign Booking Yield',
    ['Booking Fee Escrow Lock', 'Campaign Settlement Gate', 'Image Rights Isolation Lock'],
    'PRODUCTION_READY',
    640,
  ),
  atomicTemplate(
    'TPL-VIS-001',
    'Fine Art Exhibition and Print Yield Clearing',
    'VISUAL_ARTS',
    'Visual Artist',
    'Exhibition Attendance and Print Edition Sales',
    ['Exhibition Proceeds Escrow', 'Edition Print Yield Gate', 'Provenance Ledger Lock'],
    'PRODUCTION_READY',
    520,
  ),
  atomicTemplate(
    'TPL-DES-001',
    'Design Portfolio Commercial License',
    'DESIGN',
    'Design Studio',
    'Licensed Portfolio Views and Derivative Deployments',
    ['License Term Escrow Lock', 'Derivative Use Settlement Gate', 'Portfolio Asset Isolation'],
    'PRODUCTION_READY',
    460,
  ),
]);

/** The founder-verbatim atomic seeds — the registry is incomplete without all seven. */
const ATOMIC_FOUNDER_SEED_IDS: readonly string[] = [
  'TPL-MTR-001',
  'TPL-ARN-001',
  'TPL-FLM-001',
  'TPL-TV-001',
  'TPL-CAD-001',
  'TPL-FSH-001',
  'TPL-VTB-001',
];

/**
 * The atomic registry's integrity gate — runs once at module load and THROWS
 * on any violation: a missing founder seed, a duplicate id, a collision with
 * the factory library, an empty entityType/telemetryMetric, anything off the
 * three-clause canon, an ampersand in a name or clause (Zero Ampersands), an
 * atomic sector left without a record, or a master vertical whose tab would
 * render no atomic records at all.
 */
function assertAtomicIntegrity(): void {
  const factoryIds = new Set(MASTER_TEMPLATE_LIBRARY.map((record) => record.templateId));
  const byId = new Set<string>();
  const sectorsCovered = new Set<AtomicSector>();
  for (const record of ATOMIC_TEMPLATE_REGISTRY) {
    if (byId.has(record.templateId)) {
      throw new Error(`masterStore: duplicate atomic template id ${record.templateId}`);
    }
    byId.add(record.templateId);
    if (factoryIds.has(record.templateId)) {
      throw new Error(`masterStore: atomic id ${record.templateId} collides with the factory library`);
    }
    if (record.entityType.trim() === '' || record.telemetryMetric.trim() === '') {
      throw new Error(`masterStore: ${record.templateId} must carry an entityType and a telemetryMetric`);
    }
    if (record.keyClauses.length !== 3 || record.keyClauses.some((clause) => clause.trim() === '')) {
      throw new Error(`masterStore: ${record.templateId} must carry exactly three non-empty key clauses`);
    }
    for (const text of [record.templateName, ...record.keyClauses]) {
      if (text.includes('&')) {
        throw new Error(
          `masterStore: ${record.templateId} carries an ampersand — the atomic registry is zero-ampersand ('and', never '&')`,
        );
      }
    }
    sectorsCovered.add(record.atomicSector);
  }
  for (const seedId of ATOMIC_FOUNDER_SEED_IDS) {
    if (!byId.has(seedId)) {
      throw new Error(`masterStore: founder atomic seed ${seedId} is missing from the registry`);
    }
  }
  for (const sector of ATOMIC_SECTOR_ORDER) {
    if (!sectorsCovered.has(sector)) {
      throw new Error(`masterStore: atomic sector ${sector} has no record — no sector form left out`);
    }
  }
  for (const vertical of MASTER_CATEGORY_ORDER) {
    const covered = ATOMIC_TEMPLATE_REGISTRY.some(
      (record) => ATOMIC_SECTOR_TO_VERTICAL[record.atomicSector] === vertical,
    );
    if (!covered) {
      throw new Error(`masterStore: master vertical ${vertical} renders no atomic records — no empty states`);
    }
  }
}
assertAtomicIntegrity();

/** Filter the atomic registry to one master vertical; null = the whole registry. */
export function atomicRecordsForCategory(
  records: readonly AtomicContractRecord[],
  category: GlobalEntertainmentCategory | null,
): readonly AtomicContractRecord[] {
  return category
    ? records.filter((record) => ATOMIC_SECTOR_TO_VERTICAL[record.atomicSector] === category)
    : [...records];
}

/** REAL mode for the atomic registry — counts derive from the live contract store. */
export function applyAtomicRealExecutionCounts(
  records: readonly AtomicContractRecord[],
  contracts: ReadonlyArray<{ templateId: string }>,
): AtomicContractRecord[] {
  return withRealExecutionCounts(records, contracts);
}

/**
 * The atomic registry for the current mode — the seeded registry in
 * demo/preview (under the DEMO DATA disclosure), the same canon definitions
 * with live-store execution counts otherwise.
 */
export async function resolveAtomicRegistry(): Promise<{
  readonly demo: boolean;
  readonly records: readonly AtomicContractRecord[];
}> {
  if (isDevSeedMode()) {
    return { demo: true, records: ATOMIC_TEMPLATE_REGISTRY };
  }
  const contracts = await listContracts();
  return { demo: false, records: applyAtomicRealExecutionCounts(ATOMIC_TEMPLATE_REGISTRY, contracts) };
}
