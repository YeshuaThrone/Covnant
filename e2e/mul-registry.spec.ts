/**
 * MUL Registry e2e — /mul, the admin page where the MULs live.
 *
 * Layered like admin.spec.ts:
 *   - the SEEDED PREVIEW (shared webServer, DON_DEV_SEED=1, password
 *     stripped) serves /mul passwordless through the J1 carve-out and the
 *     honest empty registry — the dev seed creates no clearances;
 *   - the gate, the registry render, the audited action round-trip, and
 *     the illegal-edge refusal run on an ISOLATED passworded server with
 *     the PostgREST boundary stubbed (e2e/helpers/isolated-server.mjs):
 *     the machine, the route, and the audit logic run for real — only the
 *     database is a stub seeded with one clearance in each of the five
 *     machine states.
 */

import { expect, test } from '@playwright/test';
import { ADMIN_E2E_PASSWORD, startIsolatedServer } from './helpers/isolated-server.mjs';

interface IsolatedServerLike {
  baseUrl: string;
  stubPort: number;
  close: () => Promise<void>;
}

let server: IsolatedServerLike;

test.beforeAll(async () => {
  server = (await startIsolatedServer()) as IsolatedServerLike;
});

test.afterAll(async () => {
  await server.close();
});

/** Log in on the isolated server's gate and land back on /mul. */
async function loginToRegistry(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`${server.baseUrl}/mul`);
  await page.fill('#admin-password', ADMIN_E2E_PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page.locator('[data-testid="mul-registry"]')).toBeVisible();
}

test('the seeded preview serves /mul passwordless with the honest empty registry', async ({
  page,
}) => {
  await page.goto('/mul');

  // The J1 carve-out: the seeded preview opens the console without a form.
  await expect(page.locator('[data-testid="mul-registry"]')).toBeVisible();
  await expect(page.locator('[data-admin="gate"]')).toHaveCount(0);
  // Honesty law: no clearances exist in the dev seed — the page says so.
  await expect(page.locator('[data-testid="mul-table-empty"]')).toContainText(
    'The registry is empty',
  );
});

test('the gate holds on /mul: an anonymous visitor gets the form, never the registry', async ({
  page,
}) => {
  await page.goto(`${server.baseUrl}/mul`);

  await expect(page.locator('[data-admin="gate"]')).toBeVisible();
  await expect(page.locator('[data-testid="mul-registry"]')).toHaveCount(0);
  const body = await page.textContent('body');
  expect(body).not.toContain('CBT-TRK-000000000001');
});

test('the registry renders from store data: summary, badges, expired indicator, links, filter', async ({
  page,
}) => {
  await loginToRegistry(page);

  // One clearance in each of the machine's five states.
  await expect(page.locator('[data-testid="mul-count-draft"]')).toHaveText('1');
  await expect(page.locator('[data-testid="mul-count-requested"]')).toHaveText('1');
  await expect(page.locator('[data-testid="mul-count-cleared"]')).toHaveText('1');
  await expect(page.locator('[data-testid="mul-count-disputed"]')).toHaveText('1');
  await expect(page.locator('[data-testid="mul-count-revoked"]')).toHaveText('1');

  const rows = page.locator('[data-mul="row"]');
  await expect(rows).toHaveCount(5);

  // Asset CBT code links to the asset page.
  const assetLink = page.locator('[data-testid="mul-table"] a', {
    hasText: 'CBT-TRK-000000000003',
  });
  await expect(assetLink).toHaveAttribute('href', '/assets/CBT-TRK-000000000003');

  // The machine's own rule on display: the cleared row whose term has ended
  // carries the explicit expired indicator (expired ≠ cleared).
  const clearedRow = page.locator('[data-mul="row"][data-mul-state="cleared"]');
  await expect(clearedRow.locator('[data-mul="expired"]')).toBeVisible();

  // The state filter narrows the table; resetting restores it.
  await page.click('[data-mul="filter-cleared"]');
  await expect(rows).toHaveCount(1);
  await page.click('[data-mul="filter-all"]');
  await expect(rows).toHaveCount(5);
});

test('the history drawer replays the audit trail; the audited action moves the machine', async ({
  page,
}) => {
  await loginToRegistry(page);

  await page.click('[data-mul="history-button"][data-mul-asset="CBT-TRK-000000000001"]');
  const drawer = page.locator('[data-testid="mul-drawer"]');
  await expect(drawer).toBeVisible();

  // The seeded replay, oldest first, with the operator's note.
  const entries = page.locator('[data-mul="history-entry"]');
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('Draft opened for the demo reel.');

  // ONLY the machine's legal edge from draft is offered — nothing else.
  await expect(page.locator('[data-mul="action-requested"]')).toBeVisible();
  await expect(page.locator('[data-mul="action-cleared"]')).toHaveCount(0);
  await expect(page.locator('[data-mul="action-disputed"]')).toHaveCount(0);

  // The audited action: the POST rides the existing route, the machine
  // moves, and the replay gains the transition.
  await page.fill('[data-mul="action-note"]', 'Licensee signed the master license.');
  await page.click('[data-mul="action-requested"]');
  await expect(page.locator('[data-mul="action-error"]')).toHaveCount(0);
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(1)).toContainText('requested');

  // The registry table re-renders at the machine's new state.
  await expect(page.locator('[data-mul="row"][data-mul-state="requested"]')).toHaveCount(2);

  // Every mutation lands in the audit log — the stub's captured inserts.
  const captured = await fetch(`http://127.0.0.1:${server.stubPort}/__captured`).then(
    (response) => response.json() as Promise<Array<{ action: string; target_row_id: string }>>,
  );
  expect(
    captured.some(
      (row) => row.action === 'mul.clearance.transition' && row.target_row_id === 'CBT-TRK-000000000001',
    ),
  ).toBe(true);
});

test('an illegal edge is refused by the machine and the refusal surfaces as an error', async ({
  page,
}) => {
  await loginToRegistry(page);

  // disputed offers exactly one edge: disputed → cleared.
  await page.click('[data-mul="history-button"][data-mul-asset="CBT-TRK-000000000004"]');
  const drawer = page.locator('[data-testid="mul-drawer"]');
  await expect(drawer).toBeVisible();
  await expect(page.locator('[data-mul="action-cleared"]')).toBeVisible();
  await expect(page.locator('[data-mul="action-requested"]')).toHaveCount(0);

  // A concurrent operator claims the edge first (a real, audited POST).
  const concurrentStatus = await page.evaluate(async () => {
    const response = await fetch('/api/admin/mul/clearances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetCbtCode: 'CBT-TRK-000000000004', to: 'cleared' }),
      credentials: 'include',
    });
    return response.status;
  });
  expect(concurrentStatus).toBe(200);

  // The now-stale button posts an edge the machine does not name from the
  // current state — it refuses with 409, and the drawer SURFACES the
  // refusal (the route's conflict message, naming the illegal edge and the
  // asset's now-current state) instead of hiding it.
  await page.click('[data-mul="action-cleared"]');
  const refusal = page.locator('[data-mul="action-error"]');
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText('invalid_transition:cleared->cleared');
  await expect(refusal).toContainText('no such edge');
});
