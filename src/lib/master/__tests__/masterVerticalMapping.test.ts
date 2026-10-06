/**
 * Master vertical mapping — the real-mode derivation regression (data audit
 * P1 #1, masterStore deriveMasterLedgerFromRealStores). Pinned here:
 *
 * 1. The medium placement table — every MediaMedium resolves to a canon
 *    (vertical, subcategory) pair (taxonomy.ts), exhaustively pinned; the
 *    founder-call sectors (MOTORSPORT/ARENA/ATHLETICS under
 *    LIVE_PERFORMANCE_AND_COMEDY) stay exactly where the taxonomy put them.
 * 2. The engine-mint cross-check — a CBT code minted by the REAL engine
 *    (registerCBTAsset, in-memory) places through masterPlacementForCbt
 *    exactly where its registered medium places through
 *    masterPlacementForMedium: the prefix fallback can never drift from
 *    the engine's mint vocabulary.
 * 3. The in-memory REAL-mode derivation — resolveMasterLedger with the
 *    demo door closed and no Supabase credentials reads the live indexes
 *    and places every settled row by its asset's medium of record; the
 *    AUDIO tab no longer swallows the ledger (the audited all-AUDIO bug),
 *    and gross is conserved across the vertical tabs.
 * 4. The fail-loud gate — a settled row whose CBT type segment is
 *    off-canon rejects the derivation (never a silent mislabel or a
 *    silent drop).
 * 5. Seed ISRC canonicalization — the music seeds canonicalize through
 *    the vault canonicalizer (the same shape the registration path
 *    writes), and a non-canonicalizable seed literal fails at load.
 *
 * Store coverage note: the resolver's data seam (listAssets/listLedger)
 * exposes TWO real store paths — the Supabase PostgREST read and this
 * in-memory index. The Supabase-parity leg lives in
 * masterVerticalMapping.supabase.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type {
  BankRoutingInstruction,
  MediaMedium,
  SelfServeRightsHolder,
  TaxProfile,
} from '@/engine/covenant-master-sdk';
import { getSdk } from '@/lib/sdk';
import type { LedgerRow } from '@/lib/ledger/store';
import {
  entityRecordForWorkRef,
  resolveMasterLedger,
} from '@/lib/master/masterStore';
import {
  MASTER_CATEGORY_ORDER,
  MASTER_SUBCATEGORIES,
  masterPlacementForCbt,
  masterPlacementForMedium,
  masterPlacementMediums,
} from '@/lib/master/taxonomy';
import { canonicalSeedIdentifier } from '@/lib/covnant/vault';

// The saved env — restored after the file so a shared vitest worker keeps
// whatever ambient state the surrounding suites expect.
const SAVED_ENV: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ['DON_DEV_SEED', 'VERCEL_ENV', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    SAVED_ENV[key] = process.env[key];
    delete process.env[key];
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete globalThis.__covnantAssetIndex;
  delete globalThis.__covnantLedgerIndex;
  delete globalThis.__covnantSdk;
});

// ---------------------------------------------------------------------------
// 1 · The medium placement table — exhaustive, canon-labeled.
// ---------------------------------------------------------------------------

describe('the medium placement table', () => {
  it('resolves every registered medium to a canon (vertical, subcategory) pair', () => {
    const expected: Record<MediaMedium, [string, string]> = {
      MUSIC_TRACK: ['AUDIO_AND_RECORDED_SOUND', 'Commercial Music Releases'],
      MUSIC_ALBUM: ['AUDIO_AND_RECORDED_SOUND', 'Commercial Music Releases'],
      PODCAST_EPISODE: ['AUDIO_AND_RECORDED_SOUND', 'Podcasts'],
      AUDIOBOOK: ['AUDIO_AND_RECORDED_SOUND', 'Audiobooks'],
      FEATURE_FILM: ['FILM_AND_TELEVISION', 'Theatrical'],
      TV_SHOW: ['FILM_AND_TELEVISION', 'Broadcast TV'],
      TV_SEASON: ['FILM_AND_TELEVISION', 'Broadcast TV'],
      TV_EPISODE: ['FILM_AND_TELEVISION', 'Broadcast TV'],
      LIVE_STREAM: ['FILM_AND_TELEVISION', 'SVOD / Streaming VOD'],
      MARS_ORBITAL_BROADCAST: ['FILM_AND_TELEVISION', 'Broadcast TV'],
      SHEET_MUSIC: ['PUBLISHING_AND_LITERARY', 'Sheet Music & Scores'],
      PRINT_BOOK: ['PUBLISHING_AND_LITERARY', 'Print Books'],
      EBOOK: ['PUBLISHING_AND_LITERARY', 'e-Books'],
      MAGAZINE_SERIAL: ['PUBLISHING_AND_LITERARY', 'Periodicals'],
      VIDEO_GAME: ['INTERACTIVE_AND_DIGITAL_MEDIA', 'Video Games'],
      LIVE_EVENT: ['LIVE_PERFORMANCE_AND_COMEDY', 'Venue Ticketing Ledgers'],
      GARMENT_LINE: ['COMMERCIAL_AND_BRAND_LICENSING', 'Merchandising & Physical Goods'],
    };
    for (const medium of masterPlacementMediums()) {
      const placement = masterPlacementForMedium(medium);
      expect(placement).toEqual({ category: expected[medium][0], subcategory: expected[medium][1] });
    }
  });

  it('labels every placement with a canon subcategory of its own vertical', () => {
    for (const medium of masterPlacementMediums()) {
      const { category, subcategory } = masterPlacementForMedium(medium);
      expect(MASTER_CATEGORY_ORDER).toContain(category);
      expect(MASTER_SUBCATEGORIES[category]).toContain(subcategory);
    }
  });

  it('places the CBT-prefix fallback where the same medium places — no drift from the engine mint', () => {
    // The engine mints CBT-<TYPE>-<HASH> codes; the fallback derives the
    // placement from the same type segment. Every armed medium's own
    // medium-derived placement must agree with its prefix-derived one —
    // a row whose asset record is gone lands on the SAME tab. (The probe
    // codes here are the mint vocabulary as pinned; the engine-mint
    // cross-check below proves the REAL mint agrees.)
    for (const medium of masterPlacementMediums()) {
      expect(masterPlacementForCbt(cbtCodeForProbe(medium))).toEqual(masterPlacementForMedium(medium));
    }
  });

  it('returns null for an off-canon type segment — the caller fails loud, never guesses', () => {
    expect(masterPlacementForCbt('CBT-ZZZ-DEADBEEF')).toBeNull();
    expect(masterPlacementForCbt('not-a-cbt-code')).toBeNull();
  });
});

// The probe medium → type-segment mapping is pinned end-to-end by the
// engine-mint cross-check below; this helper keeps the pure-table test
// readable.
function cbtCodeForProbe(medium: MediaMedium): string {
  const SEGMENTS: Record<MediaMedium, string> = {
    MUSIC_TRACK: 'TRK',
    MUSIC_ALBUM: 'ALB',
    SHEET_MUSIC: 'SHT',
    FEATURE_FILM: 'FLM',
    TV_SHOW: 'TVS',
    TV_SEASON: 'SSN',
    TV_EPISODE: 'TVE',
    PODCAST_EPISODE: 'POD',
    AUDIOBOOK: 'ABK',
    PRINT_BOOK: 'PBK',
    EBOOK: 'EBK',
    MAGAZINE_SERIAL: 'MAG',
    VIDEO_GAME: 'GME',
    LIVE_STREAM: 'STR',
    MARS_ORBITAL_BROADCAST: 'MOB',
    LIVE_EVENT: 'LVE',
    GARMENT_LINE: 'FSH',
  };
  return `CBT-${SEGMENTS[medium]}-000000000001`;
}

// ---------------------------------------------------------------------------
// 2 · The engine-mint cross-check — real registration, in-memory.
// ---------------------------------------------------------------------------

const DRIFT_HOLDER: SelfServeRightsHolder = {
  id: 'holder-drift-probe',
  name: 'Drift Probe Holder',
  role: 'PRODUCER',
  splitPercentage: 100,
  taxProfile: {
    taxFormType: 'W9_US_PERSON',
    taxIdentifierEncrypted: 'TEST-TAX-REF',
    usTaxResident: true,
    isBackupWithholdingRequired: false,
    isVerified: true,
  } satisfies TaxProfile,
  payoutRouting: {
    accountHolderName: 'Drift Probe Holder',
    bankName: 'Probe Bank',
    accountNumberOrIBAN: '000000000',
    routingOrBIC: 'PROBE0000',
    currency: 'USD',
    countryCode: 'US',
    planetaryJurisdiction: 'EARTH',
    railType: 'ACH',
  } satisfies BankRoutingInstruction,
  confirmedByArtist: true,
};

describe('the engine-mint cross-check', () => {
  afterEach(() => {
    delete globalThis.__covnantAssetIndex;
  });

  it('places every engine-minted CBT code where its registered medium places', async () => {
    const sdk = getSdk(); // no env → the in-memory store path
    for (const medium of masterPlacementMediums()) {
      const { cbtCode } = await sdk.registerCBTAsset(`Drift Probe ${medium}`, medium, {}, [DRIFT_HOLDER]);
      expect(masterPlacementForCbt(cbtCode), `${medium} mints ${cbtCode}`).toEqual(
        masterPlacementForMedium(medium),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3 · The in-memory REAL-mode derivation — the audited all-AUDIO bug.
// ---------------------------------------------------------------------------

/** The scenario: one settled row per placement family + one orphan row. */
const SCENARIO: readonly { asset: { cbtCode: string; title: string; medium: MediaMedium }; gross: number }[] = [
  { asset: { cbtCode: 'CBT-TRK-000000000001', title: 'Midnight Clear', medium: 'MUSIC_TRACK' }, gross: 1_000_000 },
  { asset: { cbtCode: 'CBT-POD-000000000002', title: 'Corner Office', medium: 'PODCAST_EPISODE' }, gross: 250_000 },
  { asset: { cbtCode: 'CBT-FLM-000000000003', title: 'Meridian Line', medium: 'FEATURE_FILM' }, gross: 4_500_000 },
  { asset: { cbtCode: 'CBT-TVE-000000000004', title: 'Season Archive', medium: 'TV_EPISODE' }, gross: 750_000 },
  { asset: { cbtCode: 'CBT-PBK-000000000005', title: 'The Quiet Machine', medium: 'PRINT_BOOK' }, gross: 120_000 },
  { asset: { cbtCode: 'CBT-GME-000000000006', title: 'Neon Circuit', medium: 'VIDEO_GAME' }, gross: 320_000 },
  { asset: { cbtCode: 'CBT-LVE-000000000007', title: 'Founders Gala', medium: 'LIVE_EVENT' }, gross: 2_000_000 },
  { asset: { cbtCode: 'CBT-FSH-000000000008', title: 'Gold Crest Merch', medium: 'GARMENT_LINE' }, gross: 90_000 },
];

/** The orphan row — its asset record is gone; the CBT type segment must place it. */
const ORPHAN: LedgerRow = {
  transactionId: 'tx-orphan-1',
  cbtCode: 'CBT-EBK-000000000009',
  platform: 'Store',
  grossSettled: 45_000,
  covenantFee: 0,
  cornerDustCollected: 0,
  currency: 'USD',
  disbursements: [],
  createdAt: '2026-10-06T00:00:00.000Z',
};

const EXPECTED_PLACEMENTS: readonly (readonly [string, string, string])[] = [
  // [title, vertical, subcategory]
  ['Midnight Clear', 'AUDIO_AND_RECORDED_SOUND', 'Commercial Music Releases'],
  ['Corner Office', 'AUDIO_AND_RECORDED_SOUND', 'Podcasts'],
  ['Meridian Line', 'FILM_AND_TELEVISION', 'Theatrical'],
  ['Season Archive', 'FILM_AND_TELEVISION', 'Broadcast TV'],
  ['The Quiet Machine', 'PUBLISHING_AND_LITERARY', 'Print Books'],
  ['Neon Circuit', 'INTERACTIVE_AND_DIGITAL_MEDIA', 'Video Games'],
  ['Founders Gala', 'LIVE_PERFORMANCE_AND_COMEDY', 'Venue Ticketing Ledgers'],
  ['Gold Crest Merch', 'COMMERCIAL_AND_BRAND_LICENSING', 'Merchandising & Physical Goods'],
  ['CBT-EBK-000000000009', 'PUBLISHING_AND_LITERARY', 'e-Books'],
];

function seedRealIndexes(assetCbtCodes: readonly string[]): void {
  globalThis.__covnantAssetIndex = SCENARIO.map(
    ({ asset }) => ({
      cbtCode: asset.cbtCode,
      title: asset.title,
      medium: asset.medium,
      mappedIdentifiers: {},
      rightsHolders: [DRIFT_HOLDER],
      createdTimestamp: 1_760_000_000_000,
    }),
  );
  globalThis.__covnantLedgerIndex = [
    ...SCENARIO.filter(({ asset }) => assetCbtCodes.includes(asset.cbtCode)).map(
      ({ asset, gross }, index): LedgerRow => ({
        transactionId: `tx-${index}`,
        cbtCode: asset.cbtCode,
        platform: 'Probe',
        grossSettled: gross,
        covenantFee: 0,
        cornerDustCollected: 0,
        currency: 'USD',
        disbursements: [],
        createdAt: '2026-10-06T00:00:00.000Z',
      }),
    ),
    ORPHAN,
  ];
}

describe('resolveMasterLedger — the in-memory REAL-mode derivation', () => {
  beforeAll(() => {
    seedRealIndexes(SCENARIO.map(({ asset }) => asset.cbtCode));
  });

  afterEach(() => {
    seedRealIndexes(SCENARIO.map(({ asset }) => asset.cbtCode));
  });

  it('derives real records (never the demo library) with every row placed by its medium of record', async () => {
    const { demo, records } = await resolveMasterLedger();
    expect(demo).toBe(false);
    expect(records).toHaveLength(SCENARIO.length + 1); // + the orphan row
    for (const [title, category, subcategory] of EXPECTED_PLACEMENTS) {
      const record = records.find((candidate) => candidate.assetTitle === title);
      expect(record, `a record for ${title}`).toBeDefined();
      expect(record?.category).toBe(category);
      expect(record?.subcategory).toBe(subcategory);
    }
  });

  it('keeps the AUDIO tab to the audio rows — the ledger is never swallowed into one vertical', async () => {
    const { records } = await resolveMasterLedger();
    const audio = records.filter((record) => record.category === 'AUDIO_AND_RECORDED_SOUND');
    expect(audio.map((record) => record.assetTitle).sort()).toEqual(['Corner Office', 'Midnight Clear']);
  });

  it('labels every derived record with a canon subcategory of its vertical', async () => {
    const { records } = await resolveMasterLedger();
    for (const record of records) {
      expect(MASTER_CATEGORY_ORDER).toContain(record.category);
      expect(MASTER_SUBCATEGORIES[record.category]).toContain(record.subcategory);
    }
  });

  it('conserves gross across the vertical tabs — no row lost, none duplicated', async () => {
    const { records } = await resolveMasterLedger();
    const derivedTotal = records.reduce((sum, record) => sum + record.grossVolumeCents, 0);
    const rowTotal =
      SCENARIO.reduce((sum, { gross }) => sum + gross, 0) + ORPHAN.grossSettled;
    expect(derivedTotal).toBe(rowTotal);
  });
});

// ---------------------------------------------------------------------------
// 4 · The fail-loud gate.
// ---------------------------------------------------------------------------

describe('resolveMasterLedger — the fail-loud placement gate', () => {
  afterEach(() => {
    delete globalThis.__covnantAssetIndex;
    delete globalThis.__covnantLedgerIndex;
  });

  it('rejects the derivation when a settled row carries an off-canon CBT type segment', async () => {
    globalThis.__covnantAssetIndex = [];
    globalThis.__covnantLedgerIndex = [
      { ...ORPHAN, cbtCode: 'CBT-ZZZ-DEADBEEF' },
    ];
    await expect(resolveMasterLedger()).rejects.toThrow(/no master placement/);
  });
});

// ---------------------------------------------------------------------------
// 5 · Seed ISRC canonicalization — the vault canonicalizer at load.
// ---------------------------------------------------------------------------

describe('seed ISRC canonicalization', () => {
  it('canonicalizes the music seed ISRCs through the vault canonicalizer', () => {
    expect(canonicalSeedIdentifier('ISRC', 'US-S1Z-26-00001')).toBe('USS1Z2600001');
    expect(canonicalSeedIdentifier('ISRC', 'US-S1Z-26-42791')).toBe('USS1Z2642791');
    expect(canonicalSeedIdentifier('ISRC', 'US-CVN-26-00001')).toBe('USCVN2600001');
  });

  it('binds the music entity seed to the canonical ISRC shape', () => {
    const music = entityRecordForWorkRef('TPL-MUS-001');
    expect(music?.entityType).toBe('MASTER_RECORDING');
    if (music?.entityType !== 'MASTER_RECORDING') throw new Error('unexpected entity shape');
    expect(music.isrcCode).toBe('USS1Z2600001');
  });

  it('fails loud on a non-canonicalizable seed literal', () => {
    expect(() => canonicalSeedIdentifier('ISRC', 'not-an-isrc')).toThrow(/canonicalizable/);
  });
});
