import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runVaultAuditAction,
  saveContractAction,
  markContractFinalAction,
  type SaveContractInput,
} from '../actions';
import { mintAdminSessionToken } from '@/lib/admin/gate';

/**
 * runVaultAuditAction gate tests — the action that ran unauthenticated until
 * the admin console PR. Pins the refusal: unset secret → admin_not_configured
 * (fail closed), absent/forged cookie → admin_not_authenticated — and in
 * every refusal case the auditor NEVER runs (the failure rides the action's
 * own failure shape, nothing thrown past the boundary).
 *
 * C1 regression (saveContractAction / markContractFinalAction) — the two
 * store-writing contract actions ran unauthenticated the same way: any
 * visitor invoking the server action wrote rows through the service-role
 * client. Their gate composes the same two identity helpers apiAccess
 * composes for routes (signed operator cookie OR registered creator
 * session) and refuses BEFORE any store write. The store seam is mocked so
 * the refusal tests pin the write is never reached (the bite — pre-fix the
 * mock IS called) and the legitimate tests pin gated creators and
 * operators still save and finalize.
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

const storeMock = vi.hoisted(() => ({
  saveContract: vi.fn(),
  markContractFinal: vi.fn(),
}));

vi.mock('@/lib/contracts/store', () => ({
  saveContract: storeMock.saveContract,
  markContractFinal: storeMock.markContractFinal,
}));

const sessionMock = vi.hoisted(() => ({
  resolve: vi.fn(),
}));

vi.mock('@/lib/server/sessionCreator', () => ({
  resolveSessionCreator: sessionMock.resolve,
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

const REGISTERED_CREATOR = {
  kind: 'registered',
  creator: {
    payee_id: 'HOLDER-1',
    stage_name: 'Test Creator',
    kyc_status: 'approved',
    bank_account_linked: true,
    provisioning_status: 'PROVISIONED',
  },
} as const;

const SAVE_INPUT: SaveContractInput = {
  cbtCode: 'CBT-TRK-4A3F2879BD05',
  templateId: 'mutual-master-license',
  industry: 'MUSIC',
  context: {
    asset: {
      title: 'E2E Pool Gate Song',
      mediumLabel: 'Music Track',
      cbtCode: 'CBT-TRK-4A3F2879BD05',
      displayCode: 'CVT-3F2A9C-2026',
      identifiers: [],
    },
    pools: [],
    parties: [],
    fields: {
      effectiveDate: '',
      territory: 'Worldwide',
      term: 'Twelve (12) months from the Effective Date',
      fee: 'As separately agreed in writing between the Parties',
      governingLaw: 'the State of Delaware, United States',
    },
  },
};

function denyCounts(): { constructorCalls: number; auditCalls: number } {
  return {
    constructorCalls: engineMock.Constructor.mock.calls.length,
    auditCalls: engineMock.auditor.RunFullSystemAudit.mock.calls.length,
  };
}

beforeEach(() => {
  process.env.ADMIN_DASHBOARD_PASSWORD = PASSWORD;
  cookiesMock.get.mockReturnValue(undefined);
  sessionMock.resolve.mockResolvedValue({ kind: 'anonymous' });
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

describe('saveContractAction — gated before any write', () => {
  it('refuses an anonymous caller before the store write runs', async () => {
    const result = await saveContractAction({ ...SAVE_INPUT });

    expect(result).toEqual({ success: false, error: 'Sign in to make this change.' });
    expect(storeMock.saveContract).not.toHaveBeenCalled();
  });

  it('refuses a signed-in but unenrolled session before the store write runs', async () => {
    sessionMock.resolve.mockResolvedValue({ kind: 'unregistered', reason: 'holder_not_found' });

    const result = await saveContractAction({ ...SAVE_INPUT });

    expect(result).toEqual({
      success: false,
      error: 'This session is not enrolled as a rights holder.',
    });
    expect(storeMock.saveContract).not.toHaveBeenCalled();
  });

  it('saves the contract for a registered creator session', async () => {
    sessionMock.resolve.mockResolvedValue(REGISTERED_CREATOR);
    storeMock.saveContract.mockResolvedValue({ id: 'contract-1', status: 'DRAFT' });

    const result = await saveContractAction({ ...SAVE_INPUT });

    expect(result).toEqual({ success: true, id: 'contract-1', status: 'DRAFT' });
    expect(storeMock.saveContract).toHaveBeenCalledTimes(1);
  });

  it('saves the contract for a valid operator cookie', async () => {
    cookiesMock.get.mockReturnValue({ value: mintAdminSessionToken()! });
    storeMock.saveContract.mockResolvedValue({ id: 'contract-1', status: 'DRAFT' });

    const result = await saveContractAction({ ...SAVE_INPUT });

    expect(result).toEqual({ success: true, id: 'contract-1', status: 'DRAFT' });
    expect(storeMock.saveContract).toHaveBeenCalledTimes(1);
  });
});

describe('markContractFinalAction — gated before any write', () => {
  it('refuses an anonymous caller before the store write runs', async () => {
    const result = await markContractFinalAction('contract-1');

    expect(result).toEqual({ success: false, error: 'Sign in to make this change.' });
    expect(storeMock.markContractFinal).not.toHaveBeenCalled();
  });

  it('finalizes the contract for a registered creator session', async () => {
    sessionMock.resolve.mockResolvedValue(REGISTERED_CREATOR);
    storeMock.markContractFinal.mockResolvedValue({ id: 'contract-1', status: 'FINAL' });

    const result = await markContractFinalAction('contract-1');

    expect(result).toEqual({ success: true, status: 'FINAL' });
    expect(storeMock.markContractFinal).toHaveBeenCalledTimes(1);
  });

  it('finalizes the contract for a valid operator cookie', async () => {
    cookiesMock.get.mockReturnValue({ value: mintAdminSessionToken()! });
    storeMock.markContractFinal.mockResolvedValue({ id: 'contract-1', status: 'FINAL' });

    const result = await markContractFinalAction('contract-1');

    expect(result).toEqual({ success: true, status: 'FINAL' });
    expect(storeMock.markContractFinal).toHaveBeenCalledTimes(1);
  });
});
