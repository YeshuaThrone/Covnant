/**
 * POST /api/sync-license/register contract tests (layout contract
 * art_9tCxOhGO backend sections). The session, store, and SDK engine are
 * mocked at the module seams; the request parsing, ownership check,
 * pre-clearance posture, and response contracts run FOR REAL. Pinned:
 *
 *  - fail-closed auth (no session → 401) and malformed bodies (400/422),
 *  - the SPLIT HARD-LOCK: a submission carrying split-shaped (or
 *    clearance-shaped) keys is rejected as an unknown key,
 *  - asset-sheet resolution through the engine (missing → 404, storage
 *    outage → 502, never misclassified),
 *  - ownership: only a rights holder on the sheet may submit (403),
 *  - the PENDING PRE-CLEARANCE state: is_pre_cleared is ALWAYS false in
 *    the submission — never client-controlled; a cleared asset is 409,
 *  - the locked 50/35/15 structure echoed in every 201 response.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { POST } from '../route';
import type { SyncCatalogItemRecord } from '@/modules/sdk/records';

const sessionMock = vi.hoisted(() => ({ resolveSessionCreator: vi.fn() }));
vi.mock('@/lib/server/sessionCreator', () => ({
  resolveSessionCreator: sessionMock.resolveSessionCreator,
}));

const storeMock = vi.hoisted(() => ({ getStore: vi.fn() }));
vi.mock('@/lib/server/store', () => ({ getStore: storeMock.getStore }));

const sdkMock = vi.hoisted(() => ({ getSdk: vi.fn() }));
vi.mock('@/lib/sdk', () => ({ getSdk: sdkMock.getSdk }));

const ASSET_TAG = 'CBT-REC-0123456789AB';

const REGISTERED_SESSION = {
  kind: 'registered',
  creator: {
    payee_id: 'holder_1',
    stage_name: 'Nova Reign',
    kyc_status: 'VERIFIED',
    bank_account_linked: true,
    provisioning_status: 'PROVISIONED',
  },
} as const;

/** A minimal three-pool sheet the route can resolve through the engine. */
const ASSET_SHEET = {
  cbtCode: ASSET_TAG,
  title: 'Midnight Frequency',
  medium: 'MUSIC_TRACK',
  mappedIdentifiers: { isrc: 'USUM71703862' },
  rightsHolders: [
    { id: 'holder_1', name: 'Nova Reign', role: 'COMPOSER' },
    { id: 'holder_2', name: 'Kit Salinger', role: 'PRODUCER' },
  ],
  createdTimestamp: 1758240000000,
};

const PENDING_ROW: SyncCatalogItemRecord = {
  cbt_code: ASSET_TAG,
  is_pre_cleared: false,
  sync_fee_cents: 25000,
  genre: 'Ambient',
  bpm: 92,
  updated_at: '2026-09-19T00:00:00.000Z',
};

function makeStore(overrides: { catalog?: SyncCatalogItemRecord } = {}) {
  const upsertSyncCatalogItem = vi.fn(async (row: SyncCatalogItemRecord) => ({
    ...row,
    updated_at: row.updated_at ?? '2026-09-19T00:00:00.000Z',
  }));
  return {
    upsertSyncCatalogItem,
    getSyncCatalogItem: vi.fn(async (code: string) =>
      overrides.catalog && overrides.catalog.cbt_code === code ? overrides.catalog : undefined,
    ),
  };
}

function post(body: unknown, identity = '10.0.0.1'): NextRequest {
  return new NextRequest('http://localhost/api/sync-license/register', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': identity },
  });
}

describe('POST /api/sync-license/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMock.resolveSessionCreator.mockResolvedValue(REGISTERED_SESSION);
    sdkMock.getSdk.mockReturnValue({
      getOrHydrateAsset: vi.fn(async (code: string) =>
        code === ASSET_TAG ? ASSET_SHEET : (() => { throw new Error(`Asset ${code} could not be resolved from DB or Memory.`); })(),
      ),
    });
    storeMock.getStore.mockReturnValue(makeStore());
  });

  it('requires a registered creator session — 401 with no session', async () => {
    sessionMock.resolveSessionCreator.mockResolvedValue({ kind: 'anonymous' });

    const response = await POST(post({ cvtAssetTag: ASSET_TAG, syncFeeCents: 25000 }));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'no_session' });
  });

  it('rejects a malformed body with 400', async () => {
    const response = await POST(post('not json at all'));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ reason: 'malformed_body' });
  });

  it('hard-locks splits: any split-shaped key is an unknown key', async () => {
    const response = await POST(
      post({ cvtAssetTag: ASSET_TAG, syncFeeCents: 25000, splits: [{ payee_id: 'holder_1', share_bps: 10000 }] }),
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ reason: 'unknown_key:splits' });
    expect(body.error).toMatch(/50\/35\/15/);
  });

  it('hard-locks clearance: a client cannot submit isPreCleared', async () => {
    const response = await POST(
      post({ cvtAssetTag: ASSET_TAG, syncFeeCents: 25000, isPreCleared: true }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ reason: 'unknown_key:isPreCleared' });
  });

  it('validates the required keys and fee with stable reasons', async () => {
    const missing = await POST(post({ cvtAssetTag: ASSET_TAG }));
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ reason: 'missing_key:syncFeeCents' });

    const invalidFee = await POST(post({ cvtAssetTag: ASSET_TAG, syncFeeCents: 12.5 }));
    expect(invalidFee.status).toBe(422);
    expect(await invalidFee.json()).toMatchObject({ reason: 'invalid_sync_fee_cents' });
  });

  it('returns 404 when the asset sheet does not exist', async () => {
    sdkMock.getSdk.mockReturnValue({
      getOrHydrateAsset: vi.fn(async (code: string) => {
        throw new Error(`Asset ${code} could not be resolved from DB or Memory.`);
      }),
    });

    const response = await POST(post({ cvtAssetTag: 'CBT-REC-MISSING0000', syncFeeCents: 25000 }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ reason: 'asset_not_found' });
  });

  it('never misclassifies a storage outage as a missing asset — 502', async () => {
    sdkMock.getSdk.mockReturnValue({
      getOrHydrateAsset: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    });

    const response = await POST(post({ cvtAssetTag: ASSET_TAG, syncFeeCents: 25000 }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ reason: 'asset_sheet_read_failed' });
  });

  it('returns 403 when the submitter is not a rights holder on the asset', async () => {
    sessionMock.resolveSessionCreator.mockResolvedValue({
      kind: 'registered',
      creator: { ...REGISTERED_SESSION.creator, payee_id: 'holder_outsider' },
    });

    const response = await POST(
      post({ cvtAssetTag: ASSET_TAG, syncFeeCents: 25000 }, '10.0.0.2'),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: 'not_asset_holder' });
  });

  it('returns 409 when the asset is already pre-cleared — admin owns cleared state', async () => {
    storeMock.getStore.mockReturnValue(
      makeStore({ catalog: { ...PENDING_ROW, is_pre_cleared: true } }),
    );

    const response = await POST(
      post({ cvtAssetTag: ASSET_TAG, syncFeeCents: 25000 }, '10.0.0.3'),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'already_pre_cleared' });
  });

  it('lands the submission PENDING PRE-CLEARANCE and echoes the locked 50/35/15', async () => {
    const store = makeStore();
    storeMock.getStore.mockReturnValue(store);

    const response = await POST(
      post({ cvtAssetTag: ASSET_TAG, syncFeeCents: 25000, genre: '  Ambient  ', bpm: 92 }, '10.0.0.4'),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.status).toBe('PENDING_PRE_CLEARANCE');
    expect(body.lockedSplits).toEqual({
      tier1OwnershipBps: 5000,
      tier2CreativeBps: 3500,
      tier3ProductionBps: 1500,
    });
    expect(body.submission).toEqual({ ...PENDING_ROW, genre: 'Ambient' });
    // The submission can NEVER clear itself — is_pre_cleared is hard-false.
    expect(store.upsertSyncCatalogItem).toHaveBeenCalledWith(
      expect.objectContaining({ is_pre_cleared: false, cbt_code: ASSET_TAG }),
    );
  });

  it('rate-limits the registration surface (429 past the shared budget)', async () => {
    let last: Response | undefined;
    for (let attempt = 0; attempt < 31; attempt += 1) {
      last = await POST(post({ cvtAssetTag: ASSET_TAG, syncFeeCents: 25000 }, '10.0.9.9'));
    }
    expect(last?.status).toBe(429);
    expect(await last!.json()).toMatchObject({ reason: 'rate_limited' });
  });
});
