/**
 * /mul page render test — the same three honest views as /admin/registry,
 * chosen server-side: unset secret → unavailable notice, anonymous → the
 * login gate, signed session → the registry reading the Store seam. The
 * component renders for real (renderToStaticMarkup) with the gate lib
 * running its actual token math — only the data stores and the framework
 * seams (cookies, router) are mocked.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mintAdminSessionToken } from '@/lib/admin/gate';
import type { MulClearanceRecord } from '@/modules/sdk/records';

let cookieValue: string | undefined;
let seededMode = false;
let stubStore: { listClearances: () => Promise<unknown> } | null = null;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieValue ? { name, value: cookieValue } : undefined),
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

vi.mock('@/lib/server/store', () => ({
  getStore: () => {
    if (stubStore === null) throw new Error('The registry store is unavailable.');
    return stubStore;
  },
}));

vi.mock('@/lib/server/devSeed', () => ({
  isDevSeedMode: () => seededMode,
  getSeededStore: async () => {
    if (stubStore === null) throw new Error('The registry store is unavailable.');
    return stubStore;
  },
}));

const MulPage = (await import('../page')).default;

function clearance(overrides: Partial<MulClearanceRecord> = {}): MulClearanceRecord {
  return {
    asset_cbt_code: 'CBT-TEST-0001',
    state: 'draft',
    licensee: null,
    territory: null,
    term_start: null,
    term_end: null,
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  cookieValue = undefined;
  seededMode = false;
  stubStore = null;
  process.env.ADMIN_DASHBOARD_PASSWORD = 'test-admin-password';
});

describe('the /mul page', () => {
  it('renders the honest not-configured notice when the secret is unset', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;

    const html = renderToStaticMarkup(await MulPage());

    expect(html).toContain('data-admin="gate"');
    expect(html).toContain('The admin console is not configured.');
    expect(html).not.toContain('type="password"');
  });

  it('renders the login gate for an anonymous visitor — never the registry', async () => {
    const html = renderToStaticMarkup(await MulPage());

    expect(html).toContain('data-admin="gate"');
    expect(html).toContain('type="password"');
    expect(html).not.toContain('data-testid="mul-registry"');
  });

  it('renders the login gate for an invalid session cookie — fail closed', async () => {
    cookieValue = '1717000000000.not-a-real-signature';

    const html = renderToStaticMarkup(await MulPage());

    expect(html).toContain('data-admin="gate"');
    expect(html).not.toContain('data-testid="mul-registry"');
  });

  it('renders the registry from the production store behind a signed session', async () => {
    const token = mintAdminSessionToken(new Date(), process.env);
    expect(token).not.toBeNull();
    cookieValue = token ?? undefined;
    stubStore = {
      listClearances: async () => ({
        clearances: [
          clearance(),
          clearance({
            asset_cbt_code: 'CBT-TEST-0002',
            state: 'cleared',
            term_end: '2026-01-01T00:00:00.000Z',
          }),
        ],
        total: 2,
      }),
    };

    const html = renderToStaticMarkup(await MulPage());

    expect(html).toContain('MUL Registry');
    expect(html).toContain('data-testid="mul-registry"');
    expect(html).toContain('CBT-TEST-0001');
    expect(html).toContain('href="/assets/CBT-TEST-0002"');
    // The expired term renders the machine's own indicator: expired ≠ cleared.
    expect(html).toContain('data-mul="expired"');
    expect(html).not.toContain('data-admin="gate"');
  });

  it('reads the seeded store in seeded preview mode', async () => {
    const token = mintAdminSessionToken(new Date(), process.env);
    cookieValue = token ?? undefined;
    seededMode = true;
    let storeCalls = 0;
    stubStore = {
      listClearances: async () => {
        storeCalls += 1;
        return { clearances: [], total: 0 };
      },
    };

    const html = renderToStaticMarkup(await MulPage());

    expect(storeCalls).toBe(1);
    expect(html).toContain('data-testid="mul-registry"');
    expect(html).toContain('data-testid="mul-table-empty"');
  });

  it('renders the honest notice when the registry read fails', async () => {
    const token = mintAdminSessionToken(new Date(), process.env);
    cookieValue = token ?? undefined;
    stubStore = null; // getStore throws — the honest path.

    const html = renderToStaticMarkup(await MulPage());

    expect(html).toContain('data-testid="mul-unavailable"');
    expect(html).toContain('The registry store is unavailable.');
  });
});
