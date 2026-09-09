/**
 * /admin page render test — the three honest views, chosen server-side:
 * unset secret → unavailable notice, anonymous → the login gate, signed
 * session → the console. The components render for real (renderToStaticMarkup)
 * with the gate lib running its actual token math — only the data stores
 * and the framework seams (cookies, router) are mocked.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@/lib/sdk', () => ({
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

async function renderAdminPage(): Promise<string> {
  const AdminPage = (await import('../page')).default;
  return renderToStaticMarkup(await AdminPage());
}

beforeEach(() => {
  cookieValue = undefined;
  process.env.ADMIN_DASHBOARD_PASSWORD = 'test-admin-password';
});

describe('the /admin page', () => {
  it('renders the honest not-configured notice when the secret is unset', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;

    const html = await renderAdminPage();

    expect(html).toContain('data-admin="gate"');
    expect(html).toContain('The admin console is not configured.');
    // No password form — no password can succeed against an unset secret.
    expect(html).not.toContain('type="password"');
  });

  it('renders the login gate for an anonymous visitor — never the console', async () => {
    const html = await renderAdminPage();

    expect(html).toContain('data-admin="gate"');
    expect(html).toContain('type="password"');
    expect(html).not.toContain('data-admin="console"');
  });

  it('renders the console for a valid signed session cookie', async () => {
    const token = mintAdminSessionToken(new Date(), process.env);
    expect(token).not.toBeNull();
    cookieValue = token ?? undefined;

    const html = await renderAdminPage();

    expect(html).toContain('data-admin="console"');
    expect(html).toContain('Covenant operations');
    expect(html).not.toContain('data-admin="gate"');
  });

  it('renders the login gate for an invalid session cookie — fail closed', async () => {
    cookieValue = '1717000000000.not-a-real-signature';

    const html = await renderAdminPage();

    expect(html).toContain('data-admin="gate"');
    expect(html).not.toContain('data-admin="console"');
  });
});
