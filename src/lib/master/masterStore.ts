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
import {
  MASTER_CATEGORY_ORDER,
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
