/**
 * /admin analytics payload wiring (spec art_rRYEJBpS): the page payload
 * carries the analytics field — `companyAnalytics` for EVERY registered
 * window (7d / 30d / 90d / all), read through the same Don store door as
 * the Revenue Streams read — and fails safe to the honest unavailable
 * state when the store read throws or the derivation returns its
 * fail-closed null. The console itself must never go down because one
 * derivation failed. The AdminConsole component is replaced with a
 * capture shim so the exact server-built payload object is asserted (the
 * section render states are pinned in AnalyticsSection.test.tsx).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let capturedData: import('@/components/admin/types').AdminConsoleData | undefined;

vi.mock('@/components/admin/AdminConsole', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The page consumes the NAMED export — capture the payload it is handed.
  AdminConsole: (props: { data: import('@/components/admin/types').AdminConsoleData }) => {
    capturedData = props.data;
    return null;
  },
}));

vi.mock('@/lib/admin/companyAnalytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/companyAnalytics')>();
  return {
    ...actual,
    // Flipped per-test: by default the REAL derivation runs against the store.
    companyAnalytics: vi.fn(actual.companyAnalytics),
  };
});

let cookieValue: string | undefined;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieValue ? { name, value: cookieValue } : undefined),
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseFromEnv: () => undefined,
}));

vi.mock('@/lib/sdk', async (importOriginal) => ({
  // Real module (the dev-seed boot needs getSdk) with the asset list mocked
  // for determinism — the same seam the page test mocks.
  ...(await importOriginal<typeof import('@/lib/sdk')>()),
  listAssets: async () => [],
}));

vi.mock('@/lib/ledger/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ledger/store')>()),
  listLedger: async () => [],
}));

vi.mock('@/lib/contracts/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/contracts/store')>()),
  listContracts: async () => [],
}));

vi.mock('@/lib/admin/creators', () => ({
  listCreators: async () => ({
    ok: false as const,
    status: 503,
    code: 'supabase_not_configured',
    message: 'Supabase credentials are not configured.',
  }),
}));

vi.mock('@/lib/admin/allowlists', () => ({
  listAllowlists: async () => ({
    ok: false as const,
    status: 503,
    code: 'supabase_not_configured',
    message: 'Supabase credentials are not configured.',
  }),
}));

import { mintAdminSessionToken } from '@/lib/admin/gate';
import { companyAnalytics } from '@/lib/admin/companyAnalytics';

async function renderAdminPageWithSession(): Promise<void> {
  const AdminPage = (await import('../page')).default;
  renderToStaticMarkup(await AdminPage());
}

beforeEach(() => {
  cookieValue = undefined;
  process.env.ADMIN_DASHBOARD_PASSWORD = 'test-admin-password';
  // The dev-seed store door — the analytics read resolves against the
  // seeded in-memory store, exactly like the dashboard page tests. The
  // mocked derivation delegates to the real one unless a test overrides it.
  process.env.DON_DEV_SEED = '1';
  vi.mocked(companyAnalytics).mockClear();
});

describe('the /admin analytics payload', () => {
  it('carries every registered window derived store-read from the seeded ledger', async () => {
    const token = mintAdminSessionToken(new Date(), process.env);
    expect(token).not.toBeNull();
    cookieValue = token ?? undefined;

    await renderAdminPageWithSession();

    expect(capturedData).toBeDefined();
    const analytics = capturedData?.analytics as
      | { kind: string; value?: Record<string, { window: string; kpis: { runCount: number; totalClearedCents: bigint } }> }
      | undefined;
    expect(analytics?.kind).toBe('ready');
    // Every registered window the section's filter can pick — derived before first paint.
    const windows = analytics?.value ?? {};
    for (const window of ['7d', '30d', '90d', 'all']) {
      expect(windows[window]?.window).toBe(window);
      expect(windows[window]?.kpis.runCount).toBeGreaterThan(0);
    }
    // The widened demo ledger — 119 royalty runs settle the whole roster.
    expect(windows.all?.kpis.runCount).toBe(119);
    expect(windows['7d']?.kpis.runCount).toBe(47);
    // Demo data always disclosed.
    expect(capturedData?.analyticsDemo).toBe(true);
  });

  it('fails safe to the honest unavailable state when the analytics read throws', async () => {
    vi.mocked(companyAnalytics).mockImplementationOnce(async () => {
      throw new Error('analytics derivation exploded');
    });
    const token = mintAdminSessionToken(new Date(), process.env);
    cookieValue = token ?? undefined;

    await renderAdminPageWithSession();

    // The console still renders — one failing read never takes it down.
    expect(capturedData).toBeDefined();
    expect(capturedData?.analytics).toEqual({
      kind: 'unavailable',
      code: 'analytics_store_failed',
      message: 'Analytics store read failed.',
    });
  });

  it('fails safe when the derivation returns its fail-closed null', async () => {
    vi.mocked(companyAnalytics).mockImplementationOnce(async () => null);
    const token = mintAdminSessionToken(new Date(), process.env);
    cookieValue = token ?? undefined;

    await renderAdminPageWithSession();

    expect(capturedData?.analytics).toEqual({
      kind: 'unavailable',
      code: 'analytics_store_failed',
      message: 'Analytics store read failed.',
    });
  });
});
