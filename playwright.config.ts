import { defineConfig } from '@playwright/test';

/**
 * E2E suite — runs the production build (`next build && next start`) and
 * exercises the spec §07 acceptance gates against the running app.
 */
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
