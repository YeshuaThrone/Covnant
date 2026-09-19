/**
 * devSeed — the DON_DEV_SEED demo door (SESSIONLESS visitor, production
 * included): a seeded InMemoryStore whose financial state is produced
 * EXCLUSIVELY through the real settlement engine — every rendered dollar
 * comes from a store read; nothing here is a display string.
 *
 * IDENTITY: the persona is Yeshua Throne (the founder), payee
 * `rh_yeshua_throne_don`, KYC-approved, bank-linked, PROVISIONED on the
 * sandbox rail.
 *
 * PORTFOLIO (founder-locked targets, integer cents):
 *   available   330,000,000           ($3,300,000.00)
 *   pending      65,000,000           ($650,000.00)
 *   reserve   100,000,000,000       ($1,000,000,000.00)
 *
 * HOW each amount is produced (the founder's integrity test — all real
 * paths, asserted at seed time):
 *   RESERVE — five `calculateUdrSplits` runs (settle: false) whose creator
 *   allocation is backup-withheld at 24% because the seeded tax profile has
 *   no verified TIN/W-9 (locked semantic #4); calculateUdrSplits credits
 *   each withheld amount to the creator's reserve vault bucket.
 *   PENDING — the same runs credit the creator's post-withholding net to
 *   the pending bucket (non-settle credits land in pending); the pending
 *   bucket is then moved to available by ONE `releaseVaultPending`, and
 *   finally `payoutFromVault` drains available into pending for two
 *   IN-FLIGHT payouts (two historical payouts are settled through
 *   `settleVaultPayout`, clearing their pending).
 *   AVAILABLE — the residual: released net minus all four payout holds.
 *
 *   sum(creator_allocations) + company_dust === gross holds per run by
 *   construction (the engine's zero-balance invariant; the 50/50 creator/
 *   label splits are exact, so company dust is 0 on every run).
 *
 * Every date is fixed — the demo view is deterministic. The final store
 * state is ASSERTED against the targets; any engine drift fails the boot
 * loudly instead of rendering wrong numbers.
 */

import { getSdk } from '@/lib/sdk';
import { calculateUdrSplits } from '@/lib/server/udrSplits';
import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { setStore } from '@/lib/server/store';
import type { SessionCreator } from '@/lib/server/sessionCreator';
import { payoutFromVault, releaseVaultPending, settleVaultPayout } from '@/modules/vaults/engine';

/** The demo persona — the seeded creator rendered by every demo surface. */
export const DEV_SEED_CREATOR: SessionCreator = {
  payee_id: 'rh_yeshua_throne_don',
  stage_name: 'Yeshua Throne',
  kyc_status: 'APPROVED',
  bank_account_linked: true,
  provisioning_status: 'PROVISIONED',
};

/** The persona's seeded identity tag (rendered on demo identity surfaces only). */
export const DEV_SEED_UCT = 'UCT-US-2026-8C4F1E7A-A9';

/** The founder-locked portfolio targets the seed must land on, exactly. */
export const DEV_SEED_TARGETS = {
  available_cents: 330_000_000,
  pending_cents: 65_000_000,
  reserve_cents: 100_000_000_000,
} as const;

/**
 * The env flag — explicit, off by default, documented in .env.example. On
 * for DON_DEV_SEED=1 (local dev/e2e) and for Vercel preview deployments.
 */
export function isDevSeedMode(): boolean {
  // The preview door: Vercel preview deployments must render the populated
  // seeded dashboard with zero user actions (standing directive), and the
  // preview deployment has no Supabase credentials — the seeded in-memory
  // persona is the only honest preview experience. VERCEL_ENV is
  // 'production' on prod, so the gate there stays fail-closed.
  return process.env.DON_DEV_SEED === '1' || process.env.VERCEL_ENV === 'preview';
}

/** Deterministic seed clock — every record lands on one of these instants. */
const SEED_INSTANTS = {
  spotify_aug: '2026-08-20T12:00:00.000Z',
  youtube_aug: '2026-08-29T12:00:00.000Z',
  amazon_aug: '2026-08-30T12:00:00.000Z',
  spotify_sep: '2026-09-06T14:00:00.000Z',
  bandcamp: '2026-09-07T16:30:00.000Z',
  release: '2026-09-08T09:00:00.000Z',
  payout_rtp: '2026-09-08T14:00:00.000Z',
  payout_ach: '2026-09-08T14:05:00.000Z',
  settle_rtp: '2026-09-09T10:00:00.000Z',
  settle_ach: '2026-09-09T10:05:00.000Z',
  payout_rtp_2: '2026-09-10T14:00:00.000Z',
  payout_ach_2: '2026-09-10T14:05:00.000Z',
} as const;

/** Creator 50% — label 50%: exact splits, zero dust on every run. */
const CREATOR_BPS = 5_000;
const LABEL_BPS = 5_000;

/** The settled pending bucket released to available (Σ post-withholding nets). */
const RELEASED_NET_CENTS = 316_666_666_668;

/**
 * The five seeded royalty runs. Sources are the distribution platforms;
 * each gross is an even number of cents so the 50% creator allocation is
 * exact. The two totals that matter:
 *   Σ creator allocations = 416,666,666,668
 *   Σ withheld (24% of each allocation, no verified TIN) = 100,000,000,000
 */
const SEED_RUNS: ReadonlyArray<{
  source: string;
  period: string;
  at: string;
  workTitle: string;
  gross: number;
}> = [
  { source: 'Spotify', period: '2026-08', at: SEED_INSTANTS.spotify_aug, workTitle: 'Midnight Clear', gross: 200_000_000_000 },
  { source: 'YouTube Music', period: '2026-08', at: SEED_INSTANTS.youtube_aug, workTitle: 'Gold Hours', gross: 200_000_000_000 },
  { source: 'Amazon Music', period: '2026-08', at: SEED_INSTANTS.amazon_aug, workTitle: 'Sovereign Season', gross: 200_000_000_000 },
  { source: 'Spotify', period: '2026-09', at: SEED_INSTANTS.spotify_sep, workTitle: 'Midnight Clear', gross: 200_000_000_000 },
  { source: 'Bandcamp', period: '2026-09', at: SEED_INSTANTS.bandcamp, workTitle: 'Gold Hours', gross: 33_333_333_336 },
];

/** Expected per-run creator allocation (gross × 5,000 BPS — all exact). */
function expectedAllocation(gross: number): bigint {
  return BigInt(gross) * BigInt(CREATOR_BPS) / 10_000n;
}

/** Expected per-run backup withholding (allocation × 2,400 BPS, floored). */
function expectedWithheld(allocation: bigint): bigint {
  return allocation * 2_400n / 10_000n;
}

/**
 * Seed the two pre-cleared Sync Library demo works. The asset SHEETS are
 * registered through the engine's real mint path (`registerCBTAsset` — the
 * same server path the studio asset form uses, so titles hydrate through
 * getOrHydrateAsset); the catalog rows are then pre-cleared via the store
 * seam, representing the gated administrator's pre-clearance decision.
 */
async function seedSyncLibrary(store: InMemoryStore): Promise<void> {
  const sdk = getSdk();
  const creatorHolder = {
    id: DEV_SEED_CREATOR.payee_id,
    name: DEV_SEED_CREATOR.stage_name,
    role: 'COMPOSER' as const,
    splitPercentage: 50,
    taxProfile: {
      taxFormType: 'W9' as const,
      taxIdentifierEncrypted: 'seed-creator-tin',
      usTaxResident: true,
      isBackupWithholdingRequired: false,
      isVerified: true,
    },
    payoutRouting: {
      accountHolderName: DEV_SEED_CREATOR.stage_name,
      bankName: 'Sandbox Bank',
      accountNumberOrIBAN: '0001234567',
      routingOrBIC: '000000000',
      currency: 'USD',
      countryCode: 'US',
      planetaryJurisdiction: 'EARTH' as const,
      railType: 'ach',
    },
    confirmedByArtist: true,
  };
  const labelHolder = {
    id: 'rh_thrones_label_don',
    name: 'Thrones Rights Group',
    role: 'PUBLISHER' as const,
    splitPercentage: 50,
    taxProfile: {
      taxFormType: 'W9' as const,
      taxIdentifierEncrypted: 'seed-label-ein',
      usTaxResident: true,
      isBackupWithholdingRequired: false,
      isVerified: true,
    },
    payoutRouting: {
      accountHolderName: 'Thrones Rights Group',
      bankName: 'Sandbox Bank',
      accountNumberOrIBAN: '0001234567',
      routingOrBIC: '000000000',
      currency: 'USD',
      countryCode: 'US',
      planetaryJurisdiction: 'EARTH' as const,
      railType: 'ach',
    },
    confirmedByArtist: true,
  };

  for (const sheet of [
    { title: 'Midnight Clear', genre: 'Cinematic R&B', bpm: 92, fee: 495_000, identifiers: { isrc: 'US-CVN-26-00001' } },
    { title: 'Gold Hours', genre: 'Alt Soul', bpm: 78, fee: 320_000, identifiers: { isrc: 'US-CVN-26-00002' } },
  ]) {
    const { cbtCode } = await sdk.registerCBTAsset(sheet.title, 'MUSIC_TRACK', sheet.identifiers, [
      creatorHolder,
      labelHolder,
    ]);
    await store.upsertSyncCatalogItem({
      cbt_code: cbtCode,
      is_pre_cleared: true,
      sync_fee_cents: sheet.fee,
      genre: sheet.genre,
      bpm: sheet.bpm,
      updated_at: SEED_INSTANTS.bandcamp,
    });
  }
}

/**
 * Run one seeded royalty through the REAL settlement orchestrator and
 * assert its withholding against the expected math before accepting it.
 */
async function seedRoyaltyRun(
  store: InMemoryStore,
  run: (typeof SEED_RUNS)[number],
): Promise<void> {
  const result = await calculateUdrSplits(
    store,
    {
      source: run.source,
      period: run.period,
      currency: 'USD',
      settle: false,
      rail: 'ach',
      line_items: [
        {
          work_id: `seed-work-${run.workTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          work_title: run.workTitle,
          amount_cents: run.gross,
          splits: [
            { payee_id: DEV_SEED_CREATOR.payee_id, payee_name: DEV_SEED_CREATOR.stage_name, role: 'creator', share_bps: CREATOR_BPS },
            { payee_id: 'rh_thrones_label_don', payee_name: 'Thrones Rights Group', role: 'label', share_bps: LABEL_BPS },
          ],
        },
      ],
    },
    new Date(run.at),
  );
  if (!result.ok) {
    throw new Error(`dev seed royalty run ${run.source} ${run.period} failed: ${result.reason}`);
  }
  const expected = expectedWithheld(expectedAllocation(BigInt(run.gross)));
  const actual = BigInt(result.value.withholding[0]?.withheld_cents ?? 0);
  if (actual !== expected) {
    throw new Error(
      `dev seed withholding drift on ${run.source} ${run.period}: expected ${expected}, got ${actual}`,
    );
  }
}

/**
 * One freshly seeded in-memory store — the REAL engine paths
 * (calculateUdrSplits for the settlement chain, releaseVaultPending for the
 * release, payoutFromVault/settleVaultPayout for the payouts). The shared
 * half of both doors (the dev-seed boot and the demo door); a failed seed
 * throws — never a half-seeded store.
 */
export async function createSeededStore(): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  try {
    await seedStore(store);
  } catch (error) {
    // A failed seed must never look like a working dashboard — fail loud.
    console.error('dev-seed: seeding failed:', error);
    throw error;
  }
  return store;
}

/**
 * Boots the seeded in-memory store. Idempotent per server boot: a fresh
 * InMemoryStore is seeded through the real engine paths every time. AWAITS
 * the full seed — instrumentation's register() awaits this, so no request
 * can observe a half-seeded store.
 */
let devSeedStore: InMemoryStore | null = null;

export async function bootDevSeedStore(): Promise<InMemoryStore> {
  const store = await createSeededStore();
  // Publish ONLY after the seed completes: an eager publish would hand a
  // concurrent first reader (page + layout render in parallel) an empty
  // vault — the $0.00 boot race the e2e caught on this branch.
  setStore(store);
  devSeedStore = store;
  console.error('dev-seed: The Don dashboard store seeded (DON_DEV_SEED=1).');
  return store;
}

/**
 * The dev-seed store for READ paths. Kept in THIS module rather than the
 * store.ts singleton because the instrumentation bundle and the SSR bundle
 * each compile their own copy of the store module — a store injected into
 * the singleton at boot never crosses that bundle boundary. Concurrent
 * first readers share ONE in-flight boot, and a failed boot is forgotten
 * so later reads retry instead of caching the rejection.
 */
let devSeedBoot: Promise<InMemoryStore> | null = null;

export function getSeededStore(): Promise<InMemoryStore> {
  if (devSeedStore !== null) {
    return Promise.resolve(devSeedStore);
  }
  if (devSeedBoot === null) {
    devSeedBoot = bootDevSeedStore().then((store) => store, (error) => {
      devSeedBoot = null;
      throw error;
    });
  }
  return devSeedBoot;
}

/**
 * The DEMO DOOR's store — the production face of the seeded door. The same
 * deterministic seed, booted into a DEDICATED instance that never touches
 * the setStore() singleton: a sessionless visitor must be able to open the
 * demo without swapping the persistence seam out from under real sessions —
 * after this boots, a signed-in creator's getStore() still reads Supabase
 * (or whatever was injected), never the demo data. The demo view is
 * read-only, so one shared instance per process is safe and keeps the
 * render deterministic.
 */
let demoDoorStore: InMemoryStore | null = null;
let demoDoorBoot: Promise<InMemoryStore> | null = null;

export function getDemoDoorStore(): Promise<InMemoryStore> {
  if (demoDoorStore !== null) {
    return Promise.resolve(demoDoorStore);
  }
  if (demoDoorBoot === null) {
    demoDoorBoot = createSeededStore().then((store) => {
      demoDoorStore = store;
      return store;
    }, (error) => {
      demoDoorBoot = null; // a failed boot is forgotten — later reads retry
      throw error;
    });
  }
  return demoDoorBoot;
}

async function seedStore(store: InMemoryStore): Promise<void> {
  const payee = DEV_SEED_CREATOR;

  // The reserve bucket starts at zero; settlement withholding builds it,
  // the release moves settled pending to available, payouts drain it.
  await store.upsertVault({
    payee_id: payee.payee_id,
    payee_name: payee.stage_name,
    available_balance: 0,
    pending_balance: 0,
    reserve_balance: 0,
    updated_at: SEED_INSTANTS.spotify_aug,
  });

  // The tax profile that DRIVES the reserve: no verified TIN, no W-9 on
  // file — backup withholding (24%) applies to every seeded allocation and
  // flows to the creator reserve (locked semantic #4).
  await store.upsertCreatorTaxProfile({
    creator_id: payee.payee_id,
    tin_verified: 0,
    w9_on_file: 0,
    updated_at: SEED_INSTANTS.spotify_aug,
  });

  // The persona's identity tag (rendered on demo identity surfaces only).
  await store.upsertCreatorUct({
    creatorId: payee.payee_id,
    uctNumber: DEV_SEED_UCT,
    isni: null,
  });

  // Sync Library demo works — real asset sheets + pre-cleared catalog rows.
  await seedSyncLibrary(store);

  // 1) RESERVE + PENDING: five real settlement runs (withheld → reserve,
  //    net → pending).
  for (const run of SEED_RUNS) {
    await seedRoyaltyRun(store, run);
  }

  // 2) AVAILABLE: the creator releases the settled pending bucket.
  const released = await releaseVaultPending(
    store,
    payee.payee_id,
    RELEASED_NET_CENTS,
    new Date(SEED_INSTANTS.release),
  );
  if (!released.ok) {
    throw new Error(`dev seed: pending release failed: ${released.code} ${released.message}`);
  }

  // 3) The two HISTORICAL payouts — held, then settled (pending cleared).
  const rtpResult = await payoutFromVault(
    store,
    { payee_id: payee.payee_id, amount_cents: 200_000_000_000, rail: 'rtp' },
    new Date(SEED_INSTANTS.payout_rtp),
  );
  if (!rtpResult.ok) throw new Error(`dev seed: rtp payout failed: ${rtpResult.code}`);
  const achResult = await payoutFromVault(
    store,
    { payee_id: payee.payee_id, amount_cents: 116_271_666_668, rail: 'ach' },
    new Date(SEED_INSTANTS.payout_ach),
  );
  if (!achResult.ok) throw new Error(`dev seed: ach payout failed: ${achResult.code}`);
  const settleRtp = await settleVaultPayout(store, rtpResult.transfer.id, new Date(SEED_INSTANTS.settle_rtp));
  if (!settleRtp.ok) throw new Error(`dev seed: rtp settle failed: ${settleRtp.code}`);
  const settleAch = await settleVaultPayout(store, achResult.transfer.id, new Date(SEED_INSTANTS.settle_ach));
  if (!settleAch.ok) throw new Error(`dev seed: ach settle failed: ${settleAch.code}`);

  // 4) The two IN-FLIGHT payouts — held, never settled: they ARE the
  //    pending bucket on the dashboard.
  const inflightRtp = await payoutFromVault(
    store,
    { payee_id: payee.payee_id, amount_cents: 25_000_000, rail: 'rtp' },
    new Date(SEED_INSTANTS.payout_rtp_2),
  );
  if (!inflightRtp.ok) throw new Error(`dev seed: in-flight rtp failed: ${inflightRtp.code}`);
  const inflightAch = await payoutFromVault(
    store,
    { payee_id: payee.payee_id, amount_cents: 40_000_000, rail: 'ach' },
    new Date(SEED_INSTANTS.payout_ach_2),
  );
  if (!inflightAch.ok) throw new Error(`dev seed: in-flight ach failed: ${inflightAch.code}`);

  // 5) THE INTEGRITY GATE — the store must land exactly on the founder's
  //    targets; any drift fails the boot loudly.
  const vault = await store.getVault(payee.payee_id);
  if (!vault) throw new Error('dev seed: creator vault missing after seeding');
  const actual = {
    available: BigInt(vault.available_balance),
    pending: BigInt(vault.pending_balance),
    reserve: BigInt(vault.reserve_balance),
  };
  const target = {
    available: BigInt(DEV_SEED_TARGETS.available_cents),
    pending: BigInt(DEV_SEED_TARGETS.pending_cents),
    reserve: BigInt(DEV_SEED_TARGETS.reserve_cents),
  };
  for (const bucket of ['available', 'pending', 'reserve'] as const) {
    if (actual[bucket] !== target[bucket]) {
      throw new Error(
        `dev seed ${bucket} drift: expected ${target[bucket]}, got ${actual[bucket]}`,
      );
    }
  }
}
