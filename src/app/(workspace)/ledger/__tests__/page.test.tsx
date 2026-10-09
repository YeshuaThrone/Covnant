/**
 * /ledger session-gate test (audit F3, spec D6).
 *
 * The page is the administrator's full royalty-ledger audit view, so it is
 * fail-closed: an anonymous session is redirected on the vault page's
 * pattern (redirect('/contracts')) BEFORE any ledger data is resolved — no
 * store read, no demo seed, no render — and a verified session renders the
 * page unchanged (the gate is a session gate, not an enrollment check).
 *
 * The component renders for real (renderToStaticMarkup); the session seam
 * (resolveSessionCreator), the navigation seam (next/navigation's redirect)
 * and the data stores are mocked. The redirect mock THROWS, mirroring
 * next/navigation's real control flow — a redirect stops the render.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let sessionKind: 'anonymous' | 'unregistered' | 'registered' = 'anonymous';

const redirectSpy = vi.fn((target: string): never => {
  // next/navigation's redirect() throws a special control-flow error —
  // mirror that so the render actually stops, like production.
  throw new Error(`REDIRECT:${target}`);
});

const resolveMasterLedgerSpy = vi.fn(async () => ({
  demo: false,
  records: [] as const,
}));
const listLedgerSpy = vi.fn(async () => []);
const listAssetsSpy = vi.fn(async () => []);
const seedDemoSettlementsIfEmptySpy = vi.fn(async () => undefined);

vi.mock('next/navigation', () => ({
  redirect: (target: string): never => redirectSpy(target),
}));

vi.mock('@/lib/server/sessionCreator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/sessionCreator')>()),
  resolveSessionCreator: async (): Promise<
    | { kind: 'anonymous' }
    | { kind: 'unregistered'; reason: 'profile_not_found' | 'holder_not_found' }
    | { kind: 'registered'; creator: unknown }
  > => {
    if (sessionKind === 'anonymous') return { kind: 'anonymous' };
    if (sessionKind === 'unregistered') return { kind: 'unregistered', reason: 'profile_not_found' };
    return {
      kind: 'registered',
      creator: {
        payee_id: 'RH-TEST-HOLDER',
        stage_name: 'Test Holder',
        kyc_status: 'COMPLETE',
        bank_account_linked: true,
        provisioning_status: 'PROVISIONED',
      },
    };
  },
}));

vi.mock('@/lib/master/masterStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/master/masterStore')>()),
  resolveMasterLedger: (...args: unknown[]) => resolveMasterLedgerSpy(...(args as [])),
}));

vi.mock('@/lib/ledger/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ledger/store')>()),
  listLedger: (...args: unknown[]) => listLedgerSpy(...(args as [])),
}));

vi.mock('@/lib/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sdk')>()),
  listAssets: (...args: unknown[]) => listAssetsSpy(...(args as [])),
}));

vi.mock('@/lib/admin/demoSeeds', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/demoSeeds')>()),
  seedDemoSettlementsIfEmpty: (...args: unknown[]) =>
    seedDemoSettlementsIfEmptySpy(...(args as [])),
}));

const LedgerPage = (await import('../page')).default;

beforeEach(() => {
  sessionKind = 'anonymous';
  vi.clearAllMocks();
});

describe('/ledger — the F3 session gate', () => {
  it('redirects an anonymous visitor to /contracts before any ledger data is resolved', async () => {
    await expect(LedgerPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'REDIRECT:/contracts',
    );

    expect(redirectSpy).toHaveBeenCalledTimes(1);
    expect(redirectSpy).toHaveBeenCalledWith('/contracts');

    // Fail-closed BEFORE any data resolution — the leak was the data, not
    // the markup: no master-ledger read, no store read, no asset read, and
    // no demo-seed side effect ever runs for an anonymous session.
    expect(resolveMasterLedgerSpy).not.toHaveBeenCalled();
    expect(listLedgerSpy).not.toHaveBeenCalled();
    expect(listAssetsSpy).not.toHaveBeenCalled();
    expect(seedDemoSettlementsIfEmptySpy).not.toHaveBeenCalled();
  });

  it('renders the full audit view unchanged for a registered session', async () => {
    sessionKind = 'registered';

    const html = renderToStaticMarkup(await LedgerPage({ searchParams: Promise.resolve({}) }));

    expect(redirectSpy).not.toHaveBeenCalled();
    // The operator-grade data path is unchanged: the same reads run.
    expect(resolveMasterLedgerSpy).toHaveBeenCalledTimes(1);
    expect(listLedgerSpy).toHaveBeenCalledTimes(1);
    expect(listAssetsSpy).toHaveBeenCalledTimes(1);
    expect(seedDemoSettlementsIfEmptySpy).toHaveBeenCalledTimes(1);
    expect(html).toContain('Master Ledger &amp; Settlement History');
  });

  it('admits a signed-in-but-unenrolled session — the gate is a session gate (D6), not an enrollment check', async () => {
    sessionKind = 'unregistered';

    const html = renderToStaticMarkup(await LedgerPage({ searchParams: Promise.resolve({}) }));

    expect(redirectSpy).not.toHaveBeenCalled();
    expect(listLedgerSpy).toHaveBeenCalledTimes(1);
    expect(html).toContain('Master Ledger &amp; Settlement History');
  });
});
