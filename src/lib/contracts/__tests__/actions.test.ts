import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markContractFinalAction,
  runVaultAuditAction,
  saveContractAction,
  type SaveContractInput,
} from '../actions';
import { ADMIN_COOKIE_NAME, mintAdminSessionToken } from '@/lib/admin/gate';

/**
 * Gate tests for the contract vault server actions.
 *
 * runVaultAuditAction — the action that ran unauthenticated until the admin
 * console PR. Pins the refusal: unset secret → admin_not_configured (fail
 * closed), absent/forged cookie → admin_not_authenticated — and in every
 * refusal case the auditor NEVER runs (the failure rides the action's own
 * failure shape, nothing thrown past the boundary).
 *
 * saveContractAction / markContractFinalAction — gated by audit F2: both ran
 * unauthenticated until now. The tests replay the exact attack path
 * (gateless invocation) and pin the refusal BEFORE ANY STORE ACCESS (spy on
 * the store, not just the status), plus the legit operator path succeeding.
 */

const PASSWORD = 'test-admin-password-1234';

const cookiesMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

const headersMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: cookiesMock.get })),
  headers: vi.fn(async () => ({ get: headersMock.get })),
}));

// The store is the sink the gate must protect — mocked whole so a refusal
// assertion can prove the write never happens.
const storeMock = vi.hoisted(() => ({
  saveContract: vi.fn(),
  markContractFinal: vi.fn(),
}));

vi.mock('@/lib/contracts/store', () => ({
  saveContract: storeMock.saveContract,
  markContractFinal: storeMock.markContractFinal,
}));

// The ownership stamp's seam (spec D7) — mocked per test like the export
// route's battery mocks it; the real module shape is preserved.
vi.mock('@/lib/server/sessionCreator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/sessionCreator')>();
  return {
    ...actual,
    resolveSessionCreator: vi.fn(),
  };
});

import { resolveSessionCreator } from '@/lib/server/sessionCreator';

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
  headersMock.get.mockReturnValue(undefined);
  storeMock.saveContract.mockReset();
  storeMock.markContractFinal.mockReset();
  // The default save posture: no creator session bound (a pure operator
  // save) — the ownership stamp stays NULL.
  vi.mocked(resolveSessionCreator).mockResolvedValue({ kind: 'anonymous' });
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

describe('saveContractAction / markContractFinalAction — gated (audit F2)', () => {
  const INPUT: SaveContractInput = {
    cbtCode: 'CBT-TEST-0001',
    templateId: 'music-master-license',
    industry: 'MUSIC',
    context: {
      asset: {
        title: 'Test Asset',
        mediumLabel: 'Music',
        cbtCode: 'CBT-TEST-0001',
        displayCode: 'CBT-TEST-0001',
        identifiers: [],
      },
      pools: [],
      parties: [],
      fields: {
        effectiveDate: 'January 1, 2026',
        territory: 'Worldwide',
        term: 'Twelve (12) months from the Effective Date',
        fee: 'As separately agreed in writing',
        governingLaw: 'the State of Delaware, United States',
      },
    },
  };

  /** A valid signed operator cookie header, minted the way the console logs in. */
  const operatorCookieHeader = (): string =>
    `${ADMIN_COOKIE_NAME}=${mintAdminSessionToken()!}`;

  const forgedCookieHeader = (): string => `${ADMIN_COOKIE_NAME}=9999999999999.deadbeef`;

  it('save: refuses admin_not_configured when the secret is unset — store never touched', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;
    const result = await saveContractAction(INPUT);
    expect(result).toEqual({ success: false, error: 'admin_not_configured' });
    expect(storeMock.saveContract).not.toHaveBeenCalled();
  });

  it('save: refuses admin_not_authenticated with no operator cookie — store never touched', async () => {
    const result = await saveContractAction(INPUT);
    expect(result).toEqual({ success: false, error: 'admin_not_authenticated' });
    expect(storeMock.saveContract).not.toHaveBeenCalled();
  });

  it('save: refuses admin_not_authenticated for a forged cookie — store never touched', async () => {
    headersMock.get.mockImplementation((name: string) =>
      name === 'cookie' ? forgedCookieHeader() : null,
    );
    const result = await saveContractAction(INPUT);
    expect(result).toEqual({ success: false, error: 'admin_not_authenticated' });
    expect(storeMock.saveContract).not.toHaveBeenCalled();
  });

  it('save: stores the contract for a valid operator session — input passed through untouched', async () => {
    headersMock.get.mockImplementation((name: string) =>
      name === 'cookie' ? operatorCookieHeader() : null,
    );
    storeMock.saveContract.mockResolvedValue({ id: 'CTR-TEST0001', status: 'DRAFT' });

    const result = await saveContractAction(INPUT);

    expect(result).toEqual({ success: true, id: 'CTR-TEST0001', status: 'DRAFT' });
    expect(storeMock.saveContract).toHaveBeenCalledTimes(1);
    // No creator session bound → the ownership stamp stays NULL (spec D7).
    expect(storeMock.saveContract).toHaveBeenCalledWith(INPUT, null);
  });

  it('save: stamps the registered creator identity of the verified session (spec D7)', async () => {
    headersMock.get.mockImplementation((name: string) =>
      name === 'cookie' ? operatorCookieHeader() : null,
    );
    vi.mocked(resolveSessionCreator).mockResolvedValue({
      kind: 'registered',
      creator: {
        payee_id: 'rh_A',
        stage_name: 'Creator A',
        kyc_status: 'APPROVED',
        bank_account_linked: true,
        provisioning_status: 'PROVISIONED',
      },
    });
    storeMock.saveContract.mockResolvedValue({ id: 'CTR-TEST0001', status: 'DRAFT' });

    await saveContractAction(INPUT);

    expect(storeMock.saveContract).toHaveBeenCalledWith(INPUT, 'rh_A');
  });

  it('save: fails closed on a session-resolver read failure — store never touched', async () => {
    headersMock.get.mockImplementation((name: string) =>
      name === 'cookie' ? operatorCookieHeader() : null,
    );
    const { SessionCreatorReadError } = await import('@/lib/server/sessionCreator');
    vi.mocked(resolveSessionCreator).mockRejectedValue(
      new SessionCreatorReadError('registry_read_failed', 'Failed to load the creator registry.'),
    );

    const result = await saveContractAction(INPUT);

    // A read failure never saves silently unattributed — the save is
    // refused with the resolver's named code.
    expect(result).toEqual({ success: false, error: 'registry_read_failed' });
    expect(storeMock.saveContract).not.toHaveBeenCalled();
  });

  it('finalize: refuses admin_not_configured when the secret is unset — store never touched', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;
    const result = await markContractFinalAction('CTR-TEST0001');
    expect(result).toEqual({ success: false, error: 'admin_not_configured' });
    expect(storeMock.markContractFinal).not.toHaveBeenCalled();
  });

  it('finalize: refuses admin_not_authenticated with no operator cookie — store never touched', async () => {
    const result = await markContractFinalAction('CTR-TEST0001');
    expect(result).toEqual({ success: false, error: 'admin_not_authenticated' });
    expect(storeMock.markContractFinal).not.toHaveBeenCalled();
  });

  it('finalize: refuses admin_not_authenticated for a forged cookie — store never touched', async () => {
    headersMock.get.mockImplementation((name: string) =>
      name === 'cookie' ? forgedCookieHeader() : null,
    );
    const result = await markContractFinalAction('CTR-TEST0001');
    expect(result).toEqual({ success: false, error: 'admin_not_authenticated' });
    expect(storeMock.markContractFinal).not.toHaveBeenCalled();
  });

  it('finalize: marks the contract final for a valid operator session', async () => {
    headersMock.get.mockImplementation((name: string) =>
      name === 'cookie' ? operatorCookieHeader() : null,
    );
    storeMock.markContractFinal.mockResolvedValue({ id: 'CTR-TEST0001', status: 'FINAL' });

    const result = await markContractFinalAction('CTR-TEST0001');

    expect(result).toEqual({ success: true, status: 'FINAL' });
    expect(storeMock.markContractFinal).toHaveBeenCalledTimes(1);
    // The finalize runs under the operator viewer the gate just proved
    // (spec D7) — every row visible, so unknown AND foreign ids collapse
    // into the same not-found shape below.
    expect(storeMock.markContractFinal).toHaveBeenCalledWith('CTR-TEST0001', { role: 'operator' });
  });

  it('finalize: unknown id answers the not-found shape (foreign ids resolve to the same miss in the store, spec D7)', async () => {
    headersMock.get.mockImplementation((name: string) =>
      name === 'cookie' ? operatorCookieHeader() : null,
    );
    storeMock.markContractFinal.mockResolvedValue(undefined);

    const result = await markContractFinalAction('CTR-DOESNOTEXIST');

    expect(result).toEqual({ success: false, error: 'Contract not found.' });
  });
});
