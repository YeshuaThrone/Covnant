/**
 * The Sync License settlement lane (spec art_ZIdWlYUX — SyncMarketplaceRegistry
 * amendment). The suite runs the REAL calculateUdrSplits against a real
 * InMemoryStore — the money math is the production math. Pinned here:
 *
 *  - the exact 50/35/15 partition (Tier 1 Ownership 5,000 · Tier 2 Creative
 *    3,500 · Tier 3 Production 1,500 BPS) with exact integer-cent
 *    recombination (no dust, no loss),
 *  - per-tier splits recombining to EXACTLY 10,000 BPS (largest-remainder
 *    residual on indivisible pool shares),
 *  - every fail-closed gate (unregistered, pending pre-clearance, missing
 *    sheet, corrupt pool, empty pool),
 *  - stamp-keyed replay idempotency: a duplicate purchase returns the
 *    existing record and settles nothing new (one split run, one FBO debit),
 *  - the server-minted CBT stamp: deterministic, pattern-locked, and
 *    fee-sensitive (a different fee is a different purchase, never a replay).
 */
import { describe, expect, it, vi } from 'vitest';

import type { CovenantBlockAsset, SelfServeRightsHolder } from '@/engine/covenant-master-sdk';
import { CBT_SETTLEMENT_CODE_PATTERN, withCbtSettlementCode, type CbtSettlementTag } from '@/lib/ledger/cbt-settlement';
import { InMemoryStore } from '@/lib/server/inMemoryStore';
import {
  settleSyncLicensePurchase,
  syncLicensePurchaseReference,
} from '@/lib/server/syncLicenseSettlement';
import type { SyncLicensePurchaseRequest } from '../../../../covnant-sdk/src/contracts/syncLibraryMarketplace';
import type { PoolName } from '@/lib/splits/shared';

const ASSET_TAG = 'CBT-REC-0123456789AB';

type HolderRole = SelfServeRightsHolder['role'];

function poolHolder(
  id: string,
  name: string,
  role: HolderRole,
  pool: PoolName,
  poolSplitPercentage: number,
): SelfServeRightsHolder & { pool: PoolName; poolSplitPercentage: number } {
  return {
    id,
    name,
    role,
    // The stored sheet field mirrors the true per-pool share (studio save gate).
    splitPercentage: poolSplitPercentage,
    pool,
    poolSplitPercentage,
    taxProfile: {
      taxFormType: 'W9_US_PERSON',
      taxIdentifierEncrypted: 'test-encrypted-tin',
      usTaxResident: true,
      isBackupWithholdingRequired: false,
      isVerified: true,
    },
    payoutRouting: {
      accountHolderName: name,
      bankName: 'Test Bank',
      accountNumberOrIBAN: '000123456',
      routingOrBIC: '026009593',
      currency: 'USD',
      countryCode: 'US',
      planetaryJurisdiction: 'EARTH',
      railType: 'ACH',
    },
    confirmedByArtist: true,
  };
}

/** Pool shares as [id, name, role, percent] tuples. */
type PoolSpec = { pool: PoolName; shares: Array<[string, string, HolderRole, number]> };

function assetWithPools(pools: PoolSpec[]): CovenantBlockAsset {
  const holders = pools.flatMap(({ pool, shares }) =>
    shares.map(([id, name, role, percent]) => poolHolder(id, name, role, pool, percent)),
  );
  return {
    cbtCode: ASSET_TAG,
    title: 'Midnight Frequency',
    medium: 'MUSIC_TRACK',
    mappedIdentifiers: { isrc: 'USUM71703862' },
    rightsHolders: holders,
    createdTimestamp: 1758240000000,
  };
}

/** The standard three-pool sheet: every pool totals exactly 100.0000%. */
const STANDARD_POOLS: PoolSpec[] = [
  {
    pool: 'MASTER_RECORDING',
    shares: [
      ['holder_1', 'Nova Reign', 'COMPOSER', 60],
      ['holder_2', 'Kit Salinger', 'PRODUCER', 40],
    ],
  },
  {
    pool: 'WRITER_COMPOSITION',
    shares: [
      ['holder_1', 'Nova Reign', 'COMPOSER', 50],
      ['holder_3', 'Wren Okafor', 'LYRICIST', 50],
    ],
  },
  { pool: 'PUBLISHER_ADMIN', shares: [['holder_3', 'Wren Okafor', 'PUBLISHER', 100]] },
];

function purchaseRequest(feePaidCents = 1000): SyncLicensePurchaseRequest {
  return {
    cvtAssetTag: ASSET_TAG,
    buyerUct: 'UCT-US-2026-DEADBEEF',
    licenseType: 'COMMERCIAL_SYNC',
    feePaidCents,
  };
}

async function seededLane(options: { asset?: CovenantBlockAsset; preCleared?: boolean; seedCatalog?: boolean } = {}) {
  const {
    asset = assetWithPools(STANDARD_POOLS),
    preCleared = true,
    seedCatalog = true,
  } = options;
  const store = new InMemoryStore();
  if (seedCatalog) {
    await store.upsertSyncCatalogItem({
      cbt_code: ASSET_TAG,
      is_pre_cleared: preCleared,
      sync_fee_cents: 1000,
      genre: 'Ambient',
      bpm: 92,
    });
  }
  const assetSheet = async (code: string) => (code === asset.cbtCode ? asset : null);
  return { store, request: purchaseRequest(), assetSheet };
}

/** Per-tier line-item amounts, in lane tier order (1 Ownership, 2 Creative, 3 Production). */
function tierAmounts(settlement: { line_items: Array<{ amount_cents: number }> }): number[] {
  return settlement.line_items.map((item) => item.amount_cents);
}

describe('Sync License settlement lane', () => {
  it('partitions the fee exactly 50/35/15 and balances every tier', async () => {
    const { store, request, assetSheet } = await seededLane();

    const result = await settleSyncLicensePurchase(store, assetSheet, request);
    if (!result.ok || result.replay) throw new Error(`expected fresh settlement: ${JSON.stringify(result)}`);

    expect(tierAmounts(result.settlement)).toEqual([500, 350, 150]);
    for (const item of result.settlement.line_items) {
      const total = item.splits.reduce((acc, party) => acc + party.share_bps, 0);
      expect(total).toBe(10000);
      // zeroBalanceHolds inside calculateUdrSplits: credits + dust === amount.
      const credited = item.splits.reduce((acc, party) => acc + party.amount_cents, 0);
      expect(credited + item.company_dust_cents).toBe(item.amount_cents);
    }
    expect(result.settlement.zero_balance).toBe(true);

    // The write-back record: server-minted stamp + lineage metadata.
    expect(result.purchase.cbt_settlement_stamp).toMatch(CBT_SETTLEMENT_CODE_PATTERN);
    expect(result.purchase.split_run_id).toBe(result.settlement.split_run.id);
    expect(result.purchase.metadata).toEqual({
      cbt: { settlementCode: result.purchase.cbt_settlement_stamp, derivedFrom: 'reference_id' },
    });
  });

  it('recombines indivisible cents exactly (999 = 499 + 350 + 150)', async () => {
    const { store, assetSheet } = await seededLane();

    const result = await settleSyncLicensePurchase(store, assetSheet, purchaseRequest(999));
    if (!result.ok || result.replay) throw new Error(`expected fresh settlement: ${JSON.stringify(result)}`);

    const amounts = tierAmounts(result.settlement);
    expect(amounts.reduce((acc, value) => acc + value, 0)).toBe(999);
    expect(amounts).toEqual([499, 350, 150]);
  });

  it('balances an awkward pool to exactly 10,000 BPS via largest remainder', async () => {
    const awkward: PoolSpec[] = [
      {
        pool: 'MASTER_RECORDING',
        shares: [
          ['a1', 'A One', 'COMPOSER', 33.3333],
          ['a2', 'A Two', 'LYRICIST', 33.3333],
          ['a3', 'A Three', 'PRODUCER', 33.3334],
        ],
      },
      {
        pool: 'WRITER_COMPOSITION',
        shares: [
          ['b1', 'B One', 'COMPOSER', 33.3333],
          ['b2', 'B Two', 'LYRICIST', 33.3333],
          ['b3', 'B Three', 'PRODUCER', 33.3334],
        ],
      },
      {
        pool: 'PUBLISHER_ADMIN',
        shares: [
          ['c1', 'C One', 'PUBLISHER', 33.3333],
          ['c2', 'C Two', 'STUDIO', 33.3333],
          ['c3', 'C Three', 'DIRECTOR', 33.3334],
        ],
      },
    ];
    const { store, request, assetSheet } = await seededLane({ asset: assetWithPools(awkward) });

    const result = await settleSyncLicensePurchase(store, assetSheet, request);
    if (!result.ok || result.replay) throw new Error(`expected fresh settlement: ${JSON.stringify(result)}`);

    for (const item of result.settlement.line_items) {
      const total = item.splits.reduce((acc, party) => acc + party.share_bps, 0);
      expect(total).toBe(10000);
      // The largest holder (33.3334) absorbs the residual basis point.
      expect(Math.max(...item.splits.map((party) => party.share_bps))).toBe(3334);
    }
  });

  it('fails closed on an unregistered asset', async () => {
    const { store, request, assetSheet } = await seededLane({ seedCatalog: false });

    const result = await settleSyncLicensePurchase(store, assetSheet, request);
    expect(result).toMatchObject({ ok: false, status: 404, code: 'asset_not_registered' });
  });

  it('refuses an asset pending pre-clearance', async () => {
    const { store, request, assetSheet } = await seededLane({ preCleared: false });

    const result = await settleSyncLicensePurchase(store, assetSheet, request);
    expect(result).toMatchObject({ ok: false, status: 403, code: 'not_pre_cleared' });
  });

  it('fails closed when the asset sheet is missing', async () => {
    const { store, request } = await seededLane();

    const result = await settleSyncLicensePurchase(store, async () => null, request);
    expect(result).toMatchObject({ ok: false, status: 404, code: 'asset_sheet_not_found' });
  });

  it('fails closed on a pool that no longer totals exactly 100.0000%', async () => {
    const corrupt: PoolSpec[] = [
      {
        pool: 'MASTER_RECORDING',
        shares: [
          ['holder_1', 'Nova Reign', 'COMPOSER', 60],
          ['holder_2', 'Kit Salinger', 'PRODUCER', 39],
        ],
      },
      STANDARD_POOLS[1],
      STANDARD_POOLS[2],
    ];
    const { store, request, assetSheet } = await seededLane({ asset: assetWithPools(corrupt) });

    const result = await settleSyncLicensePurchase(store, assetSheet, request);
    expect(result).toMatchObject({ ok: false, status: 422, code: 'pool_not_exact:MASTER_RECORDING' });
  });

  it('fails closed on an empty pool', async () => {
    const { store, request, assetSheet } = await seededLane({
      asset: assetWithPools([STANDARD_POOLS[0], STANDARD_POOLS[1]]),
    });

    const result = await settleSyncLicensePurchase(store, assetSheet, request);
    expect(result).toMatchObject({ ok: false, status: 422, code: 'empty_pool:PUBLISHER_ADMIN' });
  });

  it('replays: a duplicate purchase returns the existing record and settles nothing new', async () => {
    const { store, request, assetSheet } = await seededLane();

    const first = await settleSyncLicensePurchase(store, assetSheet, request);
    if (!first.ok || first.replay) throw new Error('first settle must be fresh');

    const insertSplitRun = vi.spyOn(store, 'insertSplitRun');
    const second = await settleSyncLicensePurchase(store, assetSheet, request);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.replay).toBe(true);
    expect(second.settlement).toBeNull();
    expect(second.purchase).toEqual(first.purchase);
    // No second split run — one FBO debit per purchase, ever.
    expect(insertSplitRun).not.toHaveBeenCalled();
  });

  it('concurrent duplicate purchases converge on exactly one record', async () => {
    const { store, request, assetSheet } = await seededLane();

    const [a, b] = await Promise.all([
      settleSyncLicensePurchase(store, assetSheet, request),
      settleSyncLicensePurchase(store, assetSheet, request),
    ]);

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('unreachable');
    // Both sides land on the idempotent existing row, whichever inserted it.
    expect(a.purchase.cbt_settlement_stamp).toBe(b.purchase.cbt_settlement_stamp);
    expect(a.purchase.id).toBe(b.purchase.id);
    expect(await store.getSyncLicensePurchaseByStamp(a.purchase.cbt_settlement_stamp)).toEqual(
      a.purchase,
    );
  });

  it('mints a deterministic, pattern-locked, fee-sensitive stamp', () => {
    const reference = syncLicensePurchaseReference(purchaseRequest(1000));
    const otherFee = syncLicensePurchaseReference(purchaseRequest(1001));

    const stamp = (withCbtSettlementCode({}, reference).cbt as CbtSettlementTag).settlementCode;
    expect(stamp).toMatch(CBT_SETTLEMENT_CODE_PATTERN);
    // Deterministic: the same reference mints the identical stamp.
    expect((withCbtSettlementCode({}, reference).cbt as CbtSettlementTag).settlementCode).toBe(stamp);
    // A different fee is a different purchase — never a replay.
    expect(otherFee).not.toBe(reference);
  });
});
