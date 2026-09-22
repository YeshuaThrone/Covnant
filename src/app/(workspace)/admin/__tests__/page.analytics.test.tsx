/**
 * /admin analytics payload wiring (generation-4 spec, 2026-09-22): the
 * page payload carries the analytics field, read through the same Don
 * store door as the Revenue Streams read, and fails safe to the honest
 * unavailable state when the analytics store read throws — the console
 * itself must never go down because one derivation failed. The
 * AdminConsole component is replaced with a capture shim so the exact
 * server-built payload object is asserted (the section render states are
 * pinned in AnalyticsSection.test.tsx).
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

vi.mock('@/lib/admin/analyticsFlows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/analyticsFlows')>();
  return {
    ...actual,
    // Flipped per-test: by default the REAL derivation runs against the store.
    platformAnalyticsFlows: vi.fn(actual.platformAnalyticsFlows),
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
import { platformAnalyticsFlows } from '@/lib/admin/analyticsFlows';

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
  vi.mocked(platformAnalyticsFlows).mockClear();
});

describe('the /admin analytics payload', () => {
  it('carries the analytics field derived store-read from the seeded ledger', async () => {
    const token = mintAdminSessionToken(new Date(), process.env);
    expect(token).not.toBeNull();
    cookieValue = token ?? undefined;

    await renderAdminPageWithSession();

    expect(capturedData).toBeDefined();
    const analytics = capturedData?.analytics as
      | { kind: string; value?: { byIndustry: { state: string; rows: { label: string }[] } } }
      | undefined;
    expect(analytics?.kind).toBe('ready');
    // The multi-industry clearing demo — MUSIC plus the four new classes.
    const labels = analytics?.value?.byIndustry.rows.map((row) => row.label);
    expect(labels).toEqual(expect.arrayContaining(['MUSIC', 'SPORTS', 'ESPORTS', 'SOCIAL', 'SPONSORSHIP']));
    // Demo data always disclosed.
    expect(capturedData?.analyticsDemo).toBe(true);
  });

  it('fails safe to the honest unavailable state when the analytics read throws', async () => {
    vi.mocked(platformAnalyticsFlows).mockImplementationOnce(async () => {
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
});
