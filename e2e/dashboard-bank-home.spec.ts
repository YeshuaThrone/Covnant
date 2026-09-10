import { spawn } from 'node:child_process';
import net from 'node:net';
import { expect, test } from '@playwright/test';

/**
 * Dashboard bank-home e2e — the money-first creator home end to end.
 *
 * Runs against an ISOLATED server on a private port with the Supabase
 * boundary pointed at e2e/helpers/postgrest-stub.mjs: the sign-in form,
 * the session adoption, the shared me resolver, the dashboard
 * composition, and the identity shell all run for real — only the
 * Supabase boundary is stubbed (CI/sandbox has no database).
 *
 * The stub's port is FIXED (E2E_STUB_PORT, default 4599) because the
 * browser client's Supabase URL is inlined into the client bundle at
 * BUILD time — the e2e build step (local and CI) bakes the same fixed
 * port. The file runs serially (playwright workers: 1) with one server
 * shared by all tests.
 *
 * Covers the spec's verification table: the signed-in dashboard shows the
 * greeting + identity chip, accounts, and transactions (stubbed me-response),
 * the visitor sees the honest unregistered state, and the mobile viewport
 * (~390px) is a first-class single column with the accounts carousel and
 * drawer nav.
 */

test.describe.configure({ mode: 'serial' });

const STUB_PORT = Number(process.env.E2E_STUB_PORT ?? 4599);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

interface IsolatedServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startIsolatedServer(): Promise<IsolatedServer> {
  const appPort = await freePort();

  const stub = spawn('node', ['./e2e/helpers/postgrest-stub.mjs'], {
    env: { ...process.env, PORT: String(STUB_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const app = spawn('npx', ['next', 'start', '-p', String(appPort)], {
    env: {
      ...process.env,
      // Server session reads env at RUNTIME (next start does not re-inject
      // build-time values), so the server client needs the same fixed stub
      // URL the build baked into the browser bundle.
      NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${STUB_PORT}`,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'e2e-stub-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'e2e-stub-service-role-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await expect
    .poll(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${appPort}/signin`);
        return response.status;
      } catch {
        return 0;
      }
    })
    .toBe(200);

  return {
    baseUrl: `http://127.0.0.1:${appPort}`,
    close: async () => {
      const stopped = new Promise<void>((resolve) => {
        app.once('exit', () => resolve());
        stub.once('exit', () => resolve());
      });
      app.kill('SIGTERM');
      stub.kill('SIGTERM');
      await stopped;
    },
  };
}

let server: IsolatedServer;
test.beforeAll(async () => {
  server = await startIsolatedServer();
});
test.afterAll(async () => {
  await server.close();
});

/** Sign in through the real /signin form — the browser client stores the session. */
async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${server.baseUrl}/signin`);
  await page.getByTestId('signin-email').fill('nova@example.com');
  await page.getByTestId('signin-password').fill('stub-password-1');
  await page.getByTestId('signin-submit').click();
  await page.waitForURL('**/dashboard');
  await expect(page.getByTestId('greeting')).toBeVisible();
}

test('signed-in dashboard shows the greeting row, identity chip, accounts, and transactions', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signIn(page);

  // Greeting row — the creator's stage name, from the aggregate.
  await expect(page.getByTestId('greeting')).toContainText('Nova Reed');

  // The SMALL identity chip — initials avatar + compact UCT reference.
  // The Creator ID card is out of the dashboard (user directive): it must
  // not exist anywhere on the page.
  const chip = page.getByTestId('identity-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('UCT-US-2026-9F3A7C21-56');
  await expect(page.getByTestId('creator-id-card')).toHaveCount(0);

  // Accounts row — the three calm account cards. The stub's virtual
  // account is PENDING: the card renders the honest status line, and NO
  // balance is fabricated (money renders only when provisioned).
  await expect(page.getByTestId('accounts-row')).toBeVisible();
  await expect(page.getByTestId('account-card-virtual')).toBeVisible();
  await expect(page.getByTestId('virtual-balance-pending')).toBeVisible();
  await expect(page.getByTestId('virtual-balance')).toHaveCount(0);
  // Primary currency (USD) renders as the large net figure — exact
  // minor-unit string from grossShare/netShare × 1e8 (1.4 USD).
  await expect(page.getByTestId('settlements-net-USD')).toHaveText(/1\.40000000 USD/);
  await expect(page.getByTestId('account-card-workspace')).toBeVisible();

  // Quick actions — wired destinations only.
  const actions = page.getByTestId('quick-actions').getByRole('link');
  await expect(actions.filter({ hasText: 'Register Asset' })).toHaveAttribute('href', '/assets');
  await expect(actions.filter({ hasText: 'New Contract' })).toHaveAttribute('href', '/contracts');
  await expect(actions.filter({ hasText: 'Browse Templates' })).toHaveAttribute('href', '/templates');

  // Transactions — creator-scoped royalty rows only: the payout debit and
  // the other holder's row never render.
  const rows = page.getByTestId('transactions-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Spotify' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Bandcamp' })).toHaveCount(1);
  // body, not main — the workspace shell nests a second main element.
  await expect(page.locator('body')).not.toContainText('e2e_payout');
  await expect(page.locator('body')).not.toContainText('rh_someone_else');

  // Readiness checklist — text-labeled states from the same aggregate.
  await expect(page.getByTestId('readiness-kyc')).toBeVisible();
  await expect(page.getByTestId('readiness-provisioning')).toBeVisible();

  // The account-number ban, on the live DOM.
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('accountNumber');
  expect(body).not.toContain('routingNumber');
  expect(body).not.toContain('987654321');
  expect(body).not.toContain('101050001');

  await context.close();
});

test('the visitor sees the honest unregistered state with a sign-in path', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/dashboard`);

  await expect(page.getByText('Your creator home')).toBeVisible();
  await expect(page.getByTestId('dashboard-signin-cta')).toHaveAttribute('href', '/signin');

  // No fabricated regions: no greeting, no accounts, no zeros pretending.
  await expect(page.getByTestId('greeting')).toHaveCount(0);
  await expect(page.getByTestId('accounts-row')).toHaveCount(0);

  await context.close();
});

test('the mobile viewport (~390px) is a first-class single column with carousel and drawer', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await signIn(page);

  // Single column: the accounts row is a swipeable one-card carousel —
  // dots visible, desktop 3-up grid NOT applied.
  await expect(page.getByTestId('accounts-row')).toBeVisible();
  await expect(page.getByTestId('carousel-dots')).toBeVisible();
  await expect(page.getByTestId('carousel-dots').getByRole('tab')).toHaveCount(3);
  const rowDisplay = await page.getByTestId('accounts-row').evaluate((el) => getComputedStyle(el).display);
  expect(rowDisplay).toBe('flex'); // md:grid only at ≥768px

  // The drawer nav — hamburger opens the full destination set with the
  // live identity context.
  await page.getByRole('button', { name: /open navigation/i }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  for (const label of ['Dashboard', 'Catalog', 'Contracts', 'Ownership Ledger']) {
    await expect(drawer.getByRole('link', { name: new RegExp(label, 'i') })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  await context.close();
});

test('the sign-in form speaks the honest invalid-entry line', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/signin`);

  await page.getByTestId('signin-email').fill('not-an-email');
  await page.getByTestId('signin-password').fill('whatever-1');
  await page.getByTestId('signin-submit').click();

  // The response line is the validator's specific, named message — more
  // actionable than a generic "invalid" line.
  await expect(page.getByText('email must be a valid email address.')).toBeVisible();
  await expect(page).not.toHaveURL(/dashboard/);

  await context.close();
});
