import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleDirectAction } from '../actions';
import { mintAdminSessionToken } from '@/lib/admin/gate';

/**
 * settleDirectAction gate tests — the settlement action ran unauthenticated
 * until now (UI audit finding at 556924e). Pins the refusal: unset secret →
 * admin_not_configured (fail closed), absent/forged cookie →
 * admin_not_authenticated — and in every refusal case the settlement NEVER
 * runs (no SDK touch, nothing recorded; the failure rides the action's own
 * failure shape, nothing thrown past the boundary).
 */

const PASSWORD = 'test-admin-password-1234';

const cookiesMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: cookiesMock.get })),
}));

const engineMock = vi.hoisted(() => ({
  settle: vi.fn(),
}));

vi.mock('@/lib/sdk', () => ({
  getSdk: vi.fn(() => ({
    processRoyaltySettlement: engineMock.settle,
  })),
}));

vi.mock('@/lib/ledger/store', () => ({
  rememberSettlement: vi.fn(),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

import { rememberSettlement } from '@/lib/ledger/store';
import { getSdk } from '@/lib/sdk';

const VALID_INPUT = {
  cbtCode: 'CBT-MUSIC-TEST-0001',
  grossAmount: 1234.56,
  currency: 'USD',
  territoryCountryCode: 'US',
};

beforeEach(() => {
  process.env.ADMIN_DASHBOARD_PASSWORD = PASSWORD;
  cookiesMock.get.mockReturnValue(undefined);
  engineMock.settle.mockReset();
});

afterEach(() => {
  delete process.env.ADMIN_DASHBOARD_PASSWORD;
  vi.clearAllMocks();
});

describe('settleDirectAction — gated like runVaultAuditAction', () => {
  it('refuses with admin_not_configured when the secret is unset — SDK never touched', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;
    const result = await settleDirectAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'admin_not_configured' });
    expect(getSdk).not.toHaveBeenCalled();
    expect(engineMock.settle).not.toHaveBeenCalled();
    expect(rememberSettlement).not.toHaveBeenCalled();
  });

  it('refuses with admin_not_authenticated when no cookie is present', async () => {
    const result = await settleDirectAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'admin_not_authenticated' });
    expect(getSdk).not.toHaveBeenCalled();
    expect(engineMock.settle).not.toHaveBeenCalled();
    expect(rememberSettlement).not.toHaveBeenCalled();
  });

  it('refuses with admin_not_authenticated for a forged cookie value', async () => {
    cookiesMock.get.mockReturnValue({ value: '9999999999999.deadbeef' });
    const result = await settleDirectAction(VALID_INPUT);
    expect(result).toEqual({ success: false, error: 'admin_not_authenticated' });
    expect(getSdk).not.toHaveBeenCalled();
    expect(engineMock.settle).not.toHaveBeenCalled();
    expect(rememberSettlement).not.toHaveBeenCalled();
  });

  it('settles and records for a valid admin session cookie', async () => {
    const token = mintAdminSessionToken()!;
    cookiesMock.get.mockReturnValue({ value: token });
    const settlement = { reconciliationStatus: 'PASS' };
    engineMock.settle.mockResolvedValue(settlement);

    const result = await settleDirectAction(VALID_INPUT);

    expect(result.success).toBe(true);
    expect(engineMock.settle).toHaveBeenCalledTimes(1);
    expect(rememberSettlement).toHaveBeenCalledTimes(1);
  });
});
