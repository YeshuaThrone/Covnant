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
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx next start -p 3100',
    port: 3100,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
