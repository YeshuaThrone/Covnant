import { spawn } from 'node:child_process';
import net from 'node:net';
import { expect, test } from '@playwright/test';

/**
 * Admin console e2e — the gate, the six gated sections, and the two real
 * mutations (compliance edit, allowlist flip) flowing to the action log.
 *
 * The compliance-edit flow runs against an ISOLATED server on a private
 * port with SUPABASE_URL pointed at e2e/helpers/postgrest-stub.mjs: the
 * gate, routes, validation, and audit logic all run for real — only the
 * PostgREST boundary is stubbed (CI/sandbox has no database). The shared
 * webServer from playwright.config.ts keeps its env untouched so every
 * other spec's Supabase-less behavior is unchanged.
 */

const ADMIN_E2E_PASSWORD = process.env.ADMIN_DASHBOARD_PASSWORD ?? 'e2e-admin-test-password';

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
  stubPort: number;
  close: () => Promise<void>;
}

async function startIsolatedServer(): Promise<IsolatedServer> {
  const appPort = await freePort();
  const stubPort = await freePort();

  const stub = spawn('node', ['./e2e/helpers/postgrest-stub.mjs'], {
    env: { ...process.env, PORT: String(stubPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const app = spawn('npx', ['next', 'start', '-p', String(appPort)], {
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${stubPort}`,
      SUPABASE_SERVICE_ROLE_KEY: 'e2e-stub-service-role-key',
      ADMIN_DASHBOARD_PASSWORD: ADMIN_E2E_PASSWORD,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await expect
    .poll(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${appPort}/admin`);
        return response.status;
      } catch {
        return 0;
      }
    })
    .toBe(200);

  return {
    baseUrl: `http://127.0.0.1:${appPort}`,
    stubPort,
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

async function signIn(page: import('@playwright/test').Page, password: string): Promise<void> {
  await page.goto('/admin');
  await page.fill('#admin-password', password);
  await page.click('button[type="submit"]');
  await expect(page.locator('[data-admin="console"]')).toBeVisible();
}

test('an anonymous visitor gets the gate — wrong password states it plainly, no console leaks', async ({
  page,
}) => {
  await page.goto('/admin');

  const gate = page.locator('[data-admin="gate"]');
  await expect(gate).toBeVisible();
  await expect(page.locator('[data-admin="console"]')).toHaveCount(0);
  // No hints about what lies behind.
  const body = await page.textContent('body');
  expect(body).not.toContain('Creator profiles');
  expect(body).not.toContain('Platform allowlists');

  await page.fill('#admin-password', 'definitely-not-the-password');
  await page.click('button[type="submit"]');
  await expect(page.locator('[data-admin="gate"]').getByRole('alert')).toHaveText('Incorrect password.');
  await expect(page.locator('[data-admin="console"]')).toHaveCount(0);
});

test('a credentialed operator gets the console with all six sections', async ({ page }) => {
  await signIn(page, ADMIN_E2E_PASSWORD);

  for (const section of ['Overview', 'Creators', 'UCT Registry', 'Ledger', 'Contracts', 'Allowlists']) {
    await page.getByRole('button', { name: section, exact: true }).click();
    await expect(page.locator(`[aria-label="${section}"]`)).toBeVisible();
  }
});

test('a compliance edit POSTs and the action log shows the change; the allowlist flip likewise', async ({
  page,
}, testInfo) => {
  testInfo.setTimeout(90_000);
  const server = await startIsolatedServer();
  try {
    await page.goto(`${server.baseUrl}/admin`);
    await page.fill('#admin-password', ADMIN_E2E_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page.locator('[data-admin="console"]')).toBeVisible();

    // Creators: the seeded PENDING_INITIALIZATION row renders as its own state.
    await page.getByRole('button', { name: 'Creators', exact: true }).click();
    await expect(page.locator('[aria-label="Creators"]')).toBeVisible();
    await expect(page.getByText('PENDING_INITIALIZATION').first()).toBeVisible();

    // Open the row editor, change KYC through the bounded select.
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    const editor = page.locator('[aria-label^="Compliance editor"]');
    await expect(editor).toBeVisible();

    await page.selectOption(`select#kyc-status-creator_seeded_a`, 'VERIFIED');
    await expect(page.getByText('kyc_status: PENDING_INITIALIZATION → VERIFIED')).toBeVisible();

    // Confirm-before-write: exactly one confirm step, then the logged action.
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByRole('button', { name: 'Confirm write' }).click();

    const logged = page.locator('[aria-label="Logged action"]');
    await expect(logged).toContainText('Logged: creator.compliance.update');
    await expect(logged).toContainText('kyc_status: PENDING_INITIALIZATION → VERIFIED');

    // The stub captured the audit row — the change reached the action log.
    await expect
      .poll(async () => (await (await fetch(`http://127.0.0.1:${server.stubPort}/__captured`)).json()))
      .toMatchObject([
        {
          action: 'creator.compliance.update',
          target_table: 'creator_profiles',
          target_row_id: 'creator_seeded_a',
          changes: { kyc_status: { from: 'PENDING_INITIALIZATION', to: 'VERIFIED' } },
        },
      ]);

    // Allowlists: same discipline — confirm, flip, log.
    await page.getByRole('button', { name: 'Allowlists', exact: true }).click();
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm flip' }).click();

    const flipLogged = page.locator('[aria-label="Logged action"]');
    await expect(flipLogged).toContainText('Logged: allowlist.status_flip');
    await expect(flipLogged).toContainText('status: ACTIVE → REVOKED');
    await expect(page.getByText('REVOKED').first()).toBeVisible();
  } finally {
    await server.close();
  }
});
