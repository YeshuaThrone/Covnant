import { describe, expect, it } from 'vitest';

import {
  SyncMarketplaceRegistry,
  parseSyncCatalogItem,
  parseSyncLicensePurchasePayload,
} from './syncLibraryMarketplace';

function catalogItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cvtAssetTag: 'CVT-TEST-0001',
    assetTitle: 'Midnight Signal',
    primaryCreatorUct: 'UCT-US-2026-AB12CD34-EF',
    genre: 'Ambient Pop',
    bpm: 96,
    isPreCleared: true,
    syncFeeCents: 4999,
    grossBpsValidation: { tier1OwnershipBps: 5000, tier2CreativeBps: 3500, tier3ProductionBps: 1500 },
    ...overrides,
  };
}

function purchase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cvtAssetTag: 'CVT-TEST-0001',
    buyerUct: 'UCT-GB-2026-99ZZYYXX-01',
    licenseType: 'COMMERCIAL_SYNC',
    feePaidCents: 4999,
    ...overrides,
  };
}

describe('parseSyncCatalogItem', () => {
  it('parses a valid catalog item without bpm', () => {
    const parsed = parseSyncCatalogItem(catalogItem({ bpm: undefined }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.cvtAssetTag).toBe('CVT-TEST-0001');
  });

  it('round-trips every field of a valid item', () => {
    const parsed = parseSyncCatalogItem(catalogItem());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(catalogItem());
    }
  });

  it('rejects unknown and missing keys with stable reasons', () => {
    expect(parseSyncCatalogItem(catalogItem({ splits: '50/35/15' })))
      .toEqual({ ok: false, reason: 'unknown_key:splits' });
    expect(parseSyncCatalogItem({ ...catalogItem(), bpm: undefined, assetTitle: undefined }))
      .toEqual({ ok: false, reason: 'missing_key:assetTitle' });
    expect(parseSyncCatalogItem('nope')).toEqual({ ok: false, reason: 'not_an_object' });
  });

  it('enforces the exact 50/35/15 tier structure — no tolerance', () => {
    expect(parseSyncCatalogItem(catalogItem({
      grossBpsValidation: { tier1OwnershipBps: 4999, tier2CreativeBps: 3500, tier3ProductionBps: 1500 },
    }))).toEqual({ ok: false, reason: 'invalid_tier_bps:tier1OwnershipBps' });
    expect(parseSyncCatalogItem(catalogItem({
      grossBpsValidation: { tier1OwnershipBps: 5000, tier2CreativeBps: 3501, tier3ProductionBps: 1499 },
    }))).toEqual({ ok: false, reason: 'invalid_tier_bps:tier2CreativeBps' });
    expect(parseSyncCatalogItem(catalogItem({
      grossBpsValidation: { tier1OwnershipBps: 5000, tier2CreativeBps: 3500, tier3ProductionBps: 1500, extra: 1 },
    }))).toEqual({ ok: false, reason: 'unknown_key:extra' });
  });

  it('rejects bad scalar fields with stable reasons', () => {
    expect(parseSyncCatalogItem(catalogItem({ isPreCleared: 'true' })))
      .toEqual({ ok: false, reason: 'invalid_is_pre_cleared' });
    expect(parseSyncCatalogItem(catalogItem({ syncFeeCents: 0 })))
      .toEqual({ ok: false, reason: 'invalid_sync_fee_cents' });
    expect(parseSyncCatalogItem(catalogItem({ syncFeeCents: 99.5 })))
      .toEqual({ ok: false, reason: 'invalid_sync_fee_cents' });
    expect(parseSyncCatalogItem(catalogItem({ bpm: 96.5 })))
      .toEqual({ ok: false, reason: 'invalid_bpm' });
    expect(parseSyncCatalogItem(catalogItem({ assetTitle: '  ' })))
      .toEqual({ ok: false, reason: 'invalid_asset_title' });
  });
});

describe('parseSyncLicensePurchasePayload', () => {
  it('parses a valid client purchase request', () => {
    const parsed = parseSyncLicensePurchasePayload(purchase());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(purchase());
      expect('cbtSettlementStamp' in parsed.value).toBe(false);
    }
  });

  it('rejects a client-supplied cbtSettlementStamp — the lane mints its own', () => {
    expect(parseSyncLicensePurchasePayload(purchase({ cbtSettlementStamp: 'CBT-SETTLE-AAAAAAAAAAAA' })))
      .toEqual({ ok: false, reason: 'client_supplied_stamp' });
  });

  it('rejects unknown and missing keys with stable reasons', () => {
    expect(parseSyncLicensePurchasePayload(purchase({ platformCapture: 1 })))
      .toEqual({ ok: false, reason: 'unknown_key:platformCapture' });
    expect(parseSyncLicensePurchasePayload({ ...purchase(), feePaidCents: undefined }))
      .toEqual({ ok: false, reason: 'missing_key:feePaidCents' });
    expect(parseSyncLicensePurchasePayload(null)).toEqual({ ok: false, reason: 'not_an_object' });
  });

  it('rejects license types outside the licensing-rights union', () => {
    // Cross-namespace vocabularies (ContractCategory / MediaMedium) must fail closed.
    expect(parseSyncLicensePurchasePayload(purchase({ licenseType: 'MASTER_USE_AGREEMENT' })))
      .toEqual({ ok: false, reason: 'invalid_license_type:MASTER_USE_AGREEMENT' });
    expect(parseSyncLicensePurchasePayload(purchase({ licenseType: 'MUSIC_TRACK' })))
      .toEqual({ ok: false, reason: 'invalid_license_type:MUSIC_TRACK' });
  });

  it('rejects bad scalar fields with stable reasons', () => {
    expect(parseSyncLicensePurchasePayload(purchase({ feePaidCents: 0 })))
      .toEqual({ ok: false, reason: 'invalid_fee_paid_cents' });
    expect(parseSyncLicensePurchasePayload(purchase({ buyerUct: '' })))
      .toEqual({ ok: false, reason: 'invalid_buyer_uct' });
    expect(parseSyncLicensePurchasePayload(purchase({ cvtAssetTag: ' CVT-TEST-0001' })))
      .toEqual({ ok: false, reason: 'invalid_cvt_asset_tag' });
  });
});

describe('SyncMarketplaceRegistry.filterPreClearedAssets', () => {
  it('renders only assets where isPreCleared === true', () => {
    const cleared = catalogItem();
    const pending = catalogItem({ cvtAssetTag: 'CVT-PENDING-1', isPreCleared: false });
    const catalog = [cleared, pending].map((item) => parseSyncCatalogItem(item)).filter(
      (parsed): parsed is { ok: true; value: import('./syncLibraryMarketplace').SyncCatalogItem } => parsed.ok,
    ).map((parsed) => parsed.value);
    const visible = SyncMarketplaceRegistry.filterPreClearedAssets(catalog);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.cvtAssetTag).toBe('CVT-TEST-0001');
  });
});
