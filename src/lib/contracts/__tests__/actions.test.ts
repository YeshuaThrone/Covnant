import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runVaultAuditAction } from '../actions';
import { mintAdminSessionToken } from '@/lib/admin/gate';

/**
 * runVaultAuditAction gate tests — the action that ran unauthenticated until
 * the admin console PR. Pins the refusal: unset secret → admin_not_configured
 * (fail closed), absent/forged cookie → admin_not_authenticated — and in
 * every refusal case the auditor NEVER runs (the failure rides the action's
 * own failure shape, nothing thrown past the boundary).
 */

const PASSWORD = 'test-admin-password-1234';

const cookiesMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: cookiesMock.get })),
}));

const engineMock = vi.hoisted(() => ({
  auditor: { RunFullSystemAudit: vi.fn() },
  Constructor: vi.fn(),
}));

vi.mock('@/engine/covenant-master-sdk', () => ({
  // The constructor captures CovenantAuditorAgent instantiations so tests can
  // assert the auditor never runs on a refusal.
  CovenantAuditorAgent: class {
    constructor() {
      // Record the instantiation so tests can assert the auditor is never
      // even CONSTRUCTED on a refusal.
      engineMock.Constructor();
    }
    RunFullSystemAudit(): unknown {
      return engineMock.auditor.RunFullSystemAudit();
    }
  },
  SystemAuditReport: {},
}));

vi.mock('@/lib/sdk', () => ({
  getSdk: vi.fn(() => ({ __mock: true })),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

function denyCounts(): { constructorCalls: number; auditCalls: number } {
  return {
    constructorCalls: engineMock.Constructor.mock.calls.length,
    auditCalls: engineMock.auditor.RunFullSystemAudit.mock.calls.length,
  };
}

beforeEach(() => {
  process.env.ADMIN_DASHBOARD_PASSWORD = PASSWORD;
  cookiesMock.get.mockReturnValue(undefined);
  engineMock.Constructor.mockClear();
  engineMock.auditor.RunFullSystemAudit.mockReset();
});

afterEach(() => {
  delete process.env.ADMIN_DASHBOARD_PASSWORD;
  vi.clearAllMocks();
});

describe('runVaultAuditAction — gated from day one', () => {
  it('refuses with admin_not_configured when the secret is unset — auditor never constructed', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;
    const result = await runVaultAuditAction();
    expect(result).toEqual({ success: false, error: 'admin_not_configured' });
    expect(denyCounts()).toEqual({ constructorCalls: 0, auditCalls: 0 });
  });

  it('refuses with admin_not_authenticated when no cookie is present', async () => {
    const result = await runVaultAuditAction();
    expect(result).toEqual({ success: false, error: 'admin_not_authenticated' });
    expect(denyCounts()).toEqual({ constructorCalls: 0, auditCalls: 0 });
  });

  it('refuses with admin_not_authenticated for a forged cookie value', async () => {
    cookiesMock.get.mockReturnValue({ value: '9999999999999.deadbeef' });
    const result = await runVaultAuditAction();
    expect(result).toEqual({ success: false, error: 'admin_not_authenticated' });
    expect(denyCounts()).toEqual({ constructorCalls: 0, auditCalls: 0 });
  });

  it('runs the audit for a valid admin session cookie', async () => {
    const token = mintAdminSessionToken()!;
    cookiesMock.get.mockReturnValue({ value: token });
    engineMock.auditor.RunFullSystemAudit.mockResolvedValue({ findings: [] });

    const result = await runVaultAuditAction();

    expect(result.success).toBe(true);
    expect(engineMock.auditor.RunFullSystemAudit).toHaveBeenCalledTimes(1);
  });
});
