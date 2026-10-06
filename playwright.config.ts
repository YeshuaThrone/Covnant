import { defineConfig } from '@playwright/test';

/**
 * E2E suite — runs the production build (`next build && next start`) and
 * exercises the spec §07 acceptance gates against the running app.
 *
 * Three projects share the single seeded server:
 *   desktop-chrome         the 1280x720 default viewport — the whole suite.
 *   mobile-chrome          390x844 phone — the money path (landing signup)
 *                          plus the mobile shell smoke in e2e/mobile/.
 *   mobile-chrome-compact  375x720 compact phone — the same mobile-scoped
 *                          specs at the shortest height worth covering.
 *
 * The phones state the emulation explicitly (viewport, iPhone Safari UA,
 * touch, isMobile) on the Chromium engine CI already installs — every iOS
 * browser reports a Safari UA, so the string is the real-world one. The
 * desktop project keeps running every spec it always ran (only e2e/mobile/
 * is ignored — that smoke asserts the sub-`lg` drawer swap, meaningless at
 * 1280px); the phone projects run only landing-signup.spec.ts (the money
 * path — its flows are stubbed and viewport-independent) and e2e/mobile/,
 * so desktop-sized assumptions in the rest of the suite never inflate the
 * CI runtime budget.
 */

// The mobile UA both phone projects present — iPhone Safari, exactly what
// real iOS browsing reports (every iOS browser is WebKit).
const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Specs the phone projects run: the money path + the e2e/mobile smoke. */
const PHONE_SCOPED = /landing-signup\.spec\.ts$|[\\/]mobile[\\/]/;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3100',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: { browserName: 'chromium' },
      // The mobile smoke lives below `lg` by definition — it asserts the
      // drawer replaces the sidebar, which a 1280px run would contradict.
      testIgnore: /[\\/]mobile[\\/]/,
    },
    {
      name: 'mobile-chrome',
      testMatch: PHONE_SCOPED,
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        userAgent: IPHONE_SAFARI_UA,
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'mobile-chrome-compact',
      testMatch: PHONE_SCOPED,
      use: {
        browserName: 'chromium',
        viewport: { width: 375, height: 720 },
        userAgent: IPHONE_SAFARI_UA,
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: 'npx next start -p 3100',
    port: 3100,
    reuseExistingServer: true,
    timeout: 120_000,
    // The dashboard e2e runs against the deterministic dev-seed store —
    // an explicit opt-in flag, never the default data path.
    //
    // The seeded preview is also PASSWORDLESS by contract (gate.ts's J1
    // carve-out: `!password && DON_DEV_SEED === '1'`), so strip
    // ADMIN_DASHBOARD_PASSWORD from the inherited env. CI exports it at the
    // job level for the isolated-server admin tests (e2e/admin.spec.ts spins
    // up its own passworded server); letting it leak into this shared server
    // configured a secret here, closed the carve-out, and failed the
    // seeded-console specs (admin.spec.ts:140/:149) on every CI run.
    env: { ...process.env, DON_DEV_SEED: '1', ADMIN_DASHBOARD_PASSWORD: '' },
  },
});
