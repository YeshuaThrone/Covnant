import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_COOKIE_NAME, mintAdminSessionToken } from '@/lib/admin/gate';
import type { HolderDraft, PoolDraft } from '@/lib/splits/shared';
import { registerAssetAction, saveAssetSplitsAction } from '../actions';
import type { RegisterAssetPayload } from '../actions';

/**
 * Audit F1 (critical) regression battery — the operator gate on the asset
 * server actions.
 *
 * Before this fix registerAssetAction and saveAssetSplitsAction ran with NO
 * session check: an anonymous POST (curl with a forged Origin header defeats
 * Next's same-origin check) could rewrite rights_holders for any asset by
 * cbtCode — split percentages AND client-supplied payout routing — through
 * the service-role client, redirecting the next settlement or RTP
 * disbursement to attacker-chosen accounts.
 *
 * Pinned here, mirroring the authz route battery's posture (the REAL HMAC
 * gate against a REAL minted operator cookie; only the store seam is
 * mocked):
 *   - every refusal happens BEFORE any store access — asserted on the
 *     store-client spies (getSdk/listAssets/indexAsset) and the split-engine
 *     write spies, never just the response shape;
 *   - an unset operator secret fails closed (admin_not_configured);
 *   - an absent or forged admin cookie fails closed (admin_not_authenticated);
 *   - a legitimately minted operator session still reaches the write path
 *     with the payload intact.
 */

const PASSWORD = 'test-admin-password-1234';

const headerMock = vi.hoisted(() => ({
  get: vi.fn<(name: string) => string | null>(),
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => ({ get: headerMock.get })),
}));

const sdkMock = vi.hoisted(() => ({
  getSdk: vi.fn(),
  indexAsset: vi.fn(),
  listAssets: vi.fn(),
}));

vi.mock('@/lib/sdk', () => sdkMock);

const splitsMock = vi.hoisted(() => ({
  registerMultiPoolAsset: vi.fn(),
  saveAssetSplits: vi.fn(),
}));

// Only the write seams are replaced; holdersFromDrafts and the duplicate
// classification stay real so the actions' own payload mapping runs.
vi.mock('@/lib/splits/multi-pool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/splits/multi-pool')>()),
  ...splitsMock,
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

/** One pool's worth of holder draft — routing included, as the UI sends it. */
const DRAFT_HOLDER = {
  id: 'rh_nova',
  name: 'Nova Reign',
  role: 'COMPOSER',
  splitPercentage: 100,
  taxFormType: 'W9_US_PERSON',
  usTaxResident: true,
  isVerified: true,
  routing: {
    accountHolderName: 'Nova Reign',
    bankName: 'First Covenant Bank',
    accountNumberOrIBAN: '000123456',
    routingOrBIC: '021000021',
    currency: 'USD',
    countryCode: 'US',
    planetaryJurisdiction: 'EARTH',
    railType: 'ach',
  },
} satisfies HolderDraft;

function poolDrafts(): PoolDraft[] {
  return [
    { pool: 'MASTER_RECORDING', holders: [{ ...DRAFT_HOLDER, routing: { ...DRAFT_HOLDER.routing } }] },
  ];
}

function registerPayload(): RegisterAssetPayload {
  return {
    title: 'Night Signal',
    medium: 'MUSIC_TRACK',
    identifiers: {},
    pools: poolDrafts(),
  };
}

/** Anonymous caller: no cookie header at all. */
function anonymous(): void {
  headerMock.get.mockReturnValue(null);
}

/** Legit operator: a REAL minted admin session cookie in the header. */
function operator(): void {
  const token = mintAdminSessionToken();
  if (!token) throw new Error('operator token mint failed — ADMIN_DASHBOARD_PASSWORD unset?');
  headerMock.get.mockImplementation((name: string) =>
    name === 'cookie' ? `${ADMIN_COOKIE_NAME}=${token}` : null,
  );
}

/** Forged session: the right cookie name, an unverifiable token. */
function forgedOperator(): void {
  headerMock.get.mockImplementation((name: string) =>
    name === 'cookie' ? `${ADMIN_COOKIE_NAME}=9999999999999.deadbeef` : null,
  );
}

/** The attack-path assertion: not just the error — NOTHING was touched. */
function expectZeroStoreAccess(): void {
  expect(sdkMock.getSdk).not.toHaveBeenCalled();
  expect(sdkMock.listAssets).not.toHaveBeenCalled();
  expect(sdkMock.indexAsset).not.toHaveBeenCalled();
  expect(splitsMock.registerMultiPoolAsset).not.toHaveBeenCalled();
  expect(splitsMock.saveAssetSplits).not.toHaveBeenCalled();
}

beforeEach(() => {
  process.env.ADMIN_DASHBOARD_PASSWORD = PASSWORD;
  // The J1 preview carve-out (DON_DEV_SEED) opens the gate by design; it
  // must not leak into this battery's fail-closed verdicts.
  delete process.env.DON_DEV_SEED;
  anonymous();
  sdkMock.getSdk.mockReset();
  sdkMock.indexAsset.mockReset();
  sdkMock.listAssets.mockReset();
  splitsMock.registerMultiPoolAsset.mockReset();
  splitsMock.saveAssetSplits.mockReset();
});

afterEach(() => {
  delete process.env.ADMIN_DASHBOARD_PASSWORD;
  vi.clearAllMocks();
});

describe('registerAssetAction — operator gate (audit F1)', () => {
  it('refuses an anonymous caller before any store access', async () => {
    const result = await registerAssetAction(registerPayload());
    expect(result).toEqual({ ok: false, error: 'admin_not_authenticated' });
    expectZeroStoreAccess();
  });

  it('fails closed when the operator secret is unset — store never touched', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;
    const result = await registerAssetAction(registerPayload());
    expect(result).toEqual({ ok: false, error: 'admin_not_configured' });
    expectZeroStoreAccess();
  });

  it('refuses a forged admin cookie before any store access', async () => {
    forgedOperator();
    const result = await registerAssetAction(registerPayload());
    expect(result).toEqual({ ok: false, error: 'admin_not_authenticated' });
    expectZeroStoreAccess();
  });

  it('registers the asset for a legitimate operator session', async () => {
    operator();
    const fakeSdk = { getInMemoryAsset: vi.fn(() => null) };
    sdkMock.getSdk.mockReturnValue(fakeSdk);
    sdkMock.listAssets.mockResolvedValue([]);
    splitsMock.registerMultiPoolAsset.mockResolvedValue({ cbtCode: 'CBT_TEST_1' });

    const result = await registerAssetAction(registerPayload());

    expect(result).toEqual({ ok: true, cbtCode: 'CBT_TEST_1', cvtCode: null });
    expect(sdkMock.getSdk).toHaveBeenCalledTimes(1);
    const [sdkArg, draftArg] = splitsMock.registerMultiPoolAsset.mock.calls[0];
    expect(sdkArg).toBe(fakeSdk);
    expect(draftArg).toMatchObject({ title: 'Night Signal', medium: 'MUSIC_TRACK' });
    expect(draftArg.pools).toHaveLength(1);
    expect(draftArg.pools[0].pool).toBe('MASTER_RECORDING');
    // The operator's routing payload reaches the write layer intact —
    // exactly the data an anonymous caller used to be able to plant.
    expect(draftArg.pools[0].holders[0].payoutRouting).toEqual(DRAFT_HOLDER.routing);
  });
});

describe('saveAssetSplitsAction — operator gate (audit F1)', () => {
  it('refuses an anonymous caller before any store access', async () => {
    const result = await saveAssetSplitsAction('CBT_TEST_1', poolDrafts());
    expect(result).toEqual({ ok: false, error: 'admin_not_authenticated' });
    expectZeroStoreAccess();
  });

  it('fails closed when the operator secret is unset — store never touched', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;
    const result = await saveAssetSplitsAction('CBT_TEST_1', poolDrafts());
    expect(result).toEqual({ ok: false, error: 'admin_not_configured' });
    expectZeroStoreAccess();
  });

  it('saves splits for a legitimate operator session', async () => {
    operator();
    const fakeSdk = {};
    sdkMock.getSdk.mockReturnValue(fakeSdk);
    splitsMock.saveAssetSplits.mockResolvedValue([{ pool: 'MASTER_RECORDING', valid: true, sum: 100 }]);

    const result = await saveAssetSplitsAction('CBT_TEST_1', poolDrafts());

    expect(result).toEqual({ ok: true, cbtCode: 'CBT_TEST_1' });
    expect(sdkMock.getSdk).toHaveBeenCalledTimes(1);
    expect(splitsMock.saveAssetSplits).toHaveBeenCalledTimes(1);
    const [sdkArg, cbtArg, poolsArg] = splitsMock.saveAssetSplits.mock.calls[0];
    expect(sdkArg).toBe(fakeSdk);
    expect(cbtArg).toBe('CBT_TEST_1');
    expect(poolsArg).toHaveLength(1);
    expect(poolsArg[0].holders[0].payoutRouting).toEqual(DRAFT_HOLDER.routing);
  });
});
