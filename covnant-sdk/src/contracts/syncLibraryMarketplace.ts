/**
 * COVNANT IN-APP SYNC LIBRARY MARKETPLACE SPEC (SyncMarketplaceRegistry
 * amendment, 2026-09-16 — spec art_ZIdWlYUX).
 *
 * Phase 1 Execution:
 * - Exposes an internal catalog view of all pre-cleared assets.
 * - Evaluates assets using the Universal 50/35/15 Gross Allocation Architecture
 *   (Tier 1: 5,000 BPS, Tier 2: 3,500 BPS, Tier 3: 1,500 BPS).
 *
 * The directive's TypeScript below is adopted verbatim. The runtime
 * validators beside it are net-new (parse, don't cast): the literal types
 * constrain construction but not JSON, so every payload crossing the type
 * boundary is re-verified — exact key sets, stable machine reasons, and the
 * tier-structure check (5,000 + 3,500 + 1,500 = 10,000, no tolerance).
 *
 * Vocabulary lock: `licenseType` is a licensing-rights union, distinct from
 * ContractCategory (src/lib/contracts/templates.ts) and MediaMedium
 * (src/engine/covenant-master-sdk.ts). Cross-wiring the namespaces is
 * forbidden.
 */

export interface SyncCatalogItem {
  cvtAssetTag: string;          // Vault Tag (CVT)
  assetTitle: string;
  primaryCreatorUct: string;    // Root UCT Tag
  genre: string;
  bpm?: number;
  isPreCleared: boolean;        // Must be true to render in catalog
  syncFeeCents: number;         // Instant licensing cost in cents
  grossBpsValidation: {
    tier1OwnershipBps: 5000;    // 50.00%
    tier2CreativeBps: 3500;     // 35.00%
    tier3ProductionBps: 1500;   // 15.00%
  };
}

export interface SyncLicensePurchasePayload {
  cvtAssetTag: string;
  buyerUct: string;
  licenseType: 'COMMERCIAL_SYNC' | 'FILM_TV' | 'GAMING' | 'PODCAST';
  feePaidCents: number;
  cbtSettlementStamp: string;   // Clearing ledger stamp for payout execution
}

export class SyncMarketplaceRegistry {
  public static filterPreClearedAssets(assets: SyncCatalogItem[]): SyncCatalogItem[] {
    return assets.filter(asset => asset.isPreCleared === true);
  }
}

// ---------------------------------------------------------------------------
// Runtime validators — parse, don't cast (the parseCanonicalRoyaltyEvent
// pattern: unknown → { ok: true, value } | { ok: false, reason }, exact key
// sets, stable machine reasons).
// ---------------------------------------------------------------------------

/** The licensing-rights vocabulary (distinct from ContractCategory / MediaMedium). */
export const SYNC_LICENSE_TYPES = [
  'COMMERCIAL_SYNC',
  'FILM_TV',
  'GAMING',
  'PODCAST',
] as const;

export type SyncLicenseType = (typeof SYNC_LICENSE_TYPES)[number];

/**
 * The purchase payload at the CLIENT boundary: the four client-owned keys,
 * exactly. `cbtSettlementStamp` is authored by the settlement wire only — a
 * payload carrying one is rejected here (fail-closed), and the licensing
 * lane mints its own server-side.
 */
export type SyncLicensePurchaseRequest = Omit<SyncLicensePurchasePayload, 'cbtSettlementStamp'>;

export type ParsedSyncCatalogItem =
  | { ok: true; value: SyncCatalogItem }
  | { ok: false; reason: string };

export type ParsedSyncLicensePurchaseRequest =
  | { ok: true; value: SyncLicensePurchaseRequest }
  | { ok: false; reason: string };

/** SyncCatalogItem's exact top-level key set — bpm is the one optional key. */
const CATALOG_KEYS: readonly string[] = [
  'cvtAssetTag',
  'assetTitle',
  'primaryCreatorUct',
  'genre',
  'bpm',
  'isPreCleared',
  'syncFeeCents',
  'grossBpsValidation',
];

const CATALOG_REQUIRED_KEYS: readonly string[] = CATALOG_KEYS.filter((key) => key !== 'bpm');

/** The client purchase request's exact key set — no stamp key is ever valid. */
const PURCHASE_KEYS: readonly string[] = ['cvtAssetTag', 'buyerUct', 'licenseType', 'feePaidCents'];

const TIER_KEYS = ['tier1OwnershipBps', 'tier2CreativeBps', 'tier3ProductionBps'] as const;

/** The Universal 50/35/15 Gross Allocation Architecture, as exact literals. */
const TIER_LITERALS: Record<(typeof TIER_KEYS)[number], number> = {
  tier1OwnershipBps: 5000,
  tier2CreativeBps: 3500,
  tier3ProductionBps: 1500,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim()
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Validates the grossBpsValidation block: exact key set and every tier at
 * its exact literal — the 50/35/15 structure, no tolerance. A block that
 * sums to 10,000 any other way (e.g. 4999/3501/1500) fails closed.
 */
function validateGrossBps(
  value: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: 'invalid_gross_bps_validation' };
  for (const key of Object.keys(value)) {
    if (!TIER_KEYS.includes(key as (typeof TIER_KEYS)[number])) {
      return { ok: false, reason: `unknown_key:${key}` };
    }
  }
  for (const tier of TIER_KEYS) {
    if (!(tier in value)) return { ok: false, reason: `missing_key:${tier}` };
    if (value[tier] !== TIER_LITERALS[tier]) {
      return { ok: false, reason: `invalid_tier_bps:${tier}` };
    }
  }
  return { ok: true };
}

/** The type boundary for catalog items. Unknown keys are rejected. */
export function parseSyncCatalogItem(value: unknown): ParsedSyncCatalogItem {
  if (!isPlainObject(value)) return { ok: false, reason: 'not_an_object' };

  for (const key of Object.keys(value)) {
    if (!CATALOG_KEYS.includes(key)) return { ok: false, reason: `unknown_key:${key}` };
  }
  for (const key of CATALOG_REQUIRED_KEYS) {
    // Explicit `undefined` counts as absent (JSON bodies cannot carry it; JS
    // callers passing undefined-shaped keys get the same stable reason).
    if (value[key] === undefined) return { ok: false, reason: `missing_key:${key}` };
  }

  if (!isNonEmptyString(value.cvtAssetTag, 128)) return { ok: false, reason: 'invalid_cvt_asset_tag' };
  if (!isNonEmptyString(value.assetTitle, 512)) return { ok: false, reason: 'invalid_asset_title' };
  if (!isNonEmptyString(value.primaryCreatorUct, 128)) {
    return { ok: false, reason: 'invalid_primary_creator_uct' };
  }
  // genre is a free label the catalog displays — string, length-bounded;
  // an empty genre is a valid pending-registration state.
  if (typeof value.genre !== 'string' || value.genre.length > 128) {
    return { ok: false, reason: 'invalid_genre' };
  }
  if (typeof value.isPreCleared !== 'boolean') {
    return { ok: false, reason: 'invalid_is_pre_cleared' };
  }
  if (!isPositiveInteger(value.syncFeeCents)) {
    return { ok: false, reason: 'invalid_sync_fee_cents' };
  }

  if ('bpm' in value && value.bpm !== undefined) {
    if (
      typeof value.bpm !== 'number' ||
      !Number.isInteger(value.bpm) ||
      value.bpm <= 0
    ) {
      return { ok: false, reason: 'invalid_bpm' };
    }
  }

  const tiers = validateGrossBps(value.grossBpsValidation);
  if (!tiers.ok) return { ok: false, reason: tiers.reason };

  const item: SyncCatalogItem = {
    cvtAssetTag: value.cvtAssetTag,
    assetTitle: value.assetTitle,
    primaryCreatorUct: value.primaryCreatorUct,
    genre: value.genre,
    isPreCleared: value.isPreCleared,
    syncFeeCents: value.syncFeeCents,
    grossBpsValidation: {
      tier1OwnershipBps: 5000,
      tier2CreativeBps: 3500,
      tier3ProductionBps: 1500,
    },
  };
  // bpm stays absent unless a valid integer was supplied — never null.
  if (typeof value.bpm === 'number') item.bpm = value.bpm;

  return { ok: true, value: item };
}

/**
 * The type boundary for purchase payloads at the client boundary. A payload
 * carrying a client-authored cbtSettlementStamp is rejected — the licensing
 * lane mints its own stamp server-side through the authorized helper.
 */
export function parseSyncLicensePurchasePayload(value: unknown): ParsedSyncLicensePurchaseRequest {
  if (!isPlainObject(value)) return { ok: false, reason: 'not_an_object' };

  for (const key of Object.keys(value)) {
    if (key === 'cbtSettlementStamp') return { ok: false, reason: 'client_supplied_stamp' };
    if (!PURCHASE_KEYS.includes(key)) return { ok: false, reason: `unknown_key:${key}` };
  }
  for (const key of PURCHASE_KEYS) {
    if (value[key] === undefined) return { ok: false, reason: `missing_key:${key}` };
  }

  if (!isNonEmptyString(value.cvtAssetTag, 128)) return { ok: false, reason: 'invalid_cvt_asset_tag' };
  if (!isNonEmptyString(value.buyerUct, 128)) return { ok: false, reason: 'invalid_buyer_uct' };
  if (
    typeof value.licenseType !== 'string' ||
    !SYNC_LICENSE_TYPES.includes(value.licenseType as SyncLicenseType)
  ) {
    return { ok: false, reason: `invalid_license_type:${String(value.licenseType)}` };
  }
  if (!isPositiveInteger(value.feePaidCents)) {
    return { ok: false, reason: 'invalid_fee_paid_cents' };
  }

  return {
    ok: true,
    value: {
      cvtAssetTag: value.cvtAssetTag,
      buyerUct: value.buyerUct,
      licenseType: value.licenseType as SyncLicenseType,
      feePaidCents: value.feePaidCents,
    },
  };
}
