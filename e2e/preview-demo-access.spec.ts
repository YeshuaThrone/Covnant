import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import net from 'node:net';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Preview demo-access e2e — the zero-step "paste link → dashboard" path.
 *
 * Runs against an ISOLATED server started with VERCEL_ENV=preview and the
 * Supabase boundary pointed at the PostgREST stub (same baked fixed port
 * the browser bundle uses): the demo-login route, the cookie session write,
 * the me resolver, and the full dashboard composition run for real — only
 * Supabase is stubbed.
 *
 * Pins:
 *  - zero-step access: a brand-new unauthenticated context that pastes the
 *    /dashboard URL lands on the signed-in bank dashboard with NO clicks,
 *    NO typing, and no /signin anywhere in the path (desktop AND ~390px).
 *  - the demo-login route directly: GET → redirect → signed-in dashboard.
 *  - the real /signin form still works end-to-end on a preview-mode server
 *    (the orchestrator's scripted sign-in failure diagnosis evidence).
 *  - production invariance: with VERCEL_ENV=production the door 404s and
 *    /dashboard renders the honest visitor state — no demo session.
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

/** Wait for a port to be free (the sibling spec's stub teardown may lag). */
function waitForPortFree(port: number, tries = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (left: number) => {
      const probe = net.createServer();
      probe.once('error', () => {
        if (left <= 0) reject(new Error(`port ${port} still bound`));
        else setTimeout(() => attempt(left - 1), 200);
      });
      probe.listen(port, '127.0.0.1', () => {
        probe.close(() => resolve());
      });
    };
    attempt(tries);
  });
}

interface AppServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/** One SHARED stub — both app servers point at the same baked fixed port. */
async function startApp(vercelEnv: 'preview' | 'production'): Promise<AppServer> {
  const appPort = await freePort();

  const app = spawn('npx', ['next', 'start', '-p', String(appPort)], {
    env: {
      ...process.env,
      VERCEL_ENV: vercelEnv,
      NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${STUB_PORT}`,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'e2e-stub-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'e2e-stub-service-role-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stderr?.on('data', (chunk: Buffer) => process.stdout.write(`[app:${vercelEnv}] ${chunk}`));

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
      });
      app.kill('SIGTERM');
      await stopped;
    },
  };
}

let stub: ChildProcess;
let previewServer: AppServer;
let prodServer: AppServer;

test.beforeAll(async () => {
  await waitForPortFree(STUB_PORT);
  stub = spawn('node', ['./e2e/helpers/postgrest-stub.mjs'], {
    env: { ...process.env, PORT: String(STUB_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  previewServer = await startApp('preview');
  prodServer = await startApp('production');
});

test.afterAll(async () => {
  await Promise.all([previewServer.close(), prodServer.close()]);
  const stopped = new Promise<void>((resolve) => {
    stub.once('exit', () => resolve());
  });
  stub.kill('SIGTERM');
  await stopped;
});

/** The signed-in surface, asserted with zero prior interaction. */
async function expectZeroStepDashboard(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/dashboard`);

  // The signed-in bank dashboard, not the visitor shell, not the sign-in page.
  await expect(page.getByTestId('greeting')).toBeVisible();
  await expect(page.getByTestId('greeting')).toContainText('Nova Reed');
  await expect(page.getByTestId('accounts-row')).toBeVisible();
  await expect(page.getByTestId('transactions-panel')).toBeVisible();
  expect(page.url()).not.toContain('/signin');

  // The account-number ban holds on the auto-session surface too.
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('987654321');
  expect(body).not.toContain('101050001');
}

test('zero-step: pasting /dashboard lands signed-in — desktop', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await expectZeroStepDashboard(page, previewServer.baseUrl);
  await context.close();
});

test('zero-step: pasting /dashboard lands signed-in — mobile ~390px', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await expectZeroStepDashboard(page, previewServer.baseUrl);
  // The mobile single column: carousel + dots are the accounts surface.
  await expect(page.getByTestId('carousel-dots')).toBeVisible();
  await context.close();
});

test('zero-step flow records as video: paste → dashboard, nothing else', async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: 'e2e-artifacts/preview-zero-step' },
  });
  const page = await context.newPage();
  await page.goto(`${previewServer.baseUrl}/dashboard`);
  await expect(page.getByTestId('greeting')).toBeVisible();
  await expect(page.getByTestId('accounts-row')).toBeVisible();

  const video = page.video();
  await context.close();
  // Portable CI-safe artifact location (test-results/, gitignored).
  if (video) {
    await video.saveAs(testInfo.outputPath('preview-zero-step.webm'));
  }
});

test('the demo-login route directly redirects into the signed-in dashboard', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${previewServer.baseUrl}/api/preview/demo-login`);
  await expect(page.getByTestId('greeting')).toBeVisible();
  expect(page.url()).not.toContain('/signin');
  await context.close();
});

test('the real /signin form still works end-to-end on a preview-mode server', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${previewServer.baseUrl}/signin`);
  await page.getByTestId('signin-email').fill('nova@example.com');
  await page.getByTestId('signin-password').fill('stub-password-1');
  await page.getByTestId('signin-submit').click();
  await page.waitForURL('**/dashboard');
  await expect(page.getByTestId('greeting')).toBeVisible();
  await context.close();
});

test('production invariance: the door 404s and /dashboard keeps the visitor state', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const route = await page.request.get(`${prodServer.baseUrl}/api/preview/demo-login`, {
    maxRedirects: 0,
  });
  expect(route.status()).toBe(404);

  await page.goto(`${prodServer.baseUrl}/dashboard`);
  await expect(page.getByText('Your creator home')).toBeVisible();
  await expect(page.getByTestId('dashboard-signin-cta')).toHaveAttribute('href', '/signin');
  expect(page.url()).not.toContain('demo-login');
  await context.close();
});
