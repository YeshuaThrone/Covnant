import { expect, test } from '@playwright/test';

/**
 * E2E — the Covnant Control Board (/templates) under the founder's
 * 2026-09-20 directive: Control Board branding, zero Sovereign copy,
 * isolated entity pills, and per-tab swaps hydrated through the
 * per-sector entity doors (GET /api/v1/entities/[sector]).
 *
 * Runs unauthenticated against the dev-seed production build — which is
 * itself the J1 preview-carve-out proof: these doors render the same
 * public store read the page uses, so the unauthenticated session must
 * reach them exactly like the page.
 */

test.describe('Covnant Control Board', () => {
  test('renders the Control Board header with zero Sovereign copy', async ({ page }) => {
    await page.goto('/templates');
    await expect(page.getByRole('heading', { name: 'Covnant Control Board' })).toBeVisible();
    await expect(
      page.getByText('Atomic Entity Clearing & Real-Time Telemetry Matrix'),
    ).toBeVisible();
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/[Ss]overeign/);
  });

  test('renders isolated entity pills and the canonical Music telemetry', async ({ page }) => {
    await page.goto('/templates');
    await expect(page.locator('[data-entity-class="MUSIC"]').first()).toBeVisible();
    await expect(page.locator('[data-entity-class="FILM"]').first()).toBeVisible();
    // Drop-5 canonical Music record — bound from the store engine.
    await expect(page.getByText('US-S1Z-26-00001')).toBeVisible();
    await expect(page.getByText('ASCAP')).toBeVisible();
    // Split badges unchanged.
    await expect(page.getByText('Ownership reserve 50%').first()).toBeVisible();
    await expect(page.getByText('Creative payout 35%').first()).toBeVisible();
    await expect(page.getByText('Operations yield 15%').first()).toBeVisible();
  });

  test('swaps tabs through the per-sector entity doors', async ({ page }) => {
    await page.goto('/templates');
    const sectorCalls: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/entities/')) {
        sectorCalls.push(request.url());
      }
    });

    await page.getByTestId('vertical-tab').filter({ hasText: 'Audio & Recorded Sound' }).click();
    await expect(page).toHaveURL(/category=AUDIO_AND_RECORDED_SOUND/);
    // The tab activation fetched sector doors — not a client-side array filter.
    expect(sectorCalls.length).toBeGreaterThanOrEqual(1);
    // Hydrated board shows the vertical's bound entities; never an empty state.
    await expect(page.locator('[data-entity-class="MUSIC"]').first()).toBeVisible();
    await expect(page.getByTestId('template-vertical-section')).toBeVisible();
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/[Ss]overeign/);
  });

  test('deep-links a vertical view with SSR content and no Sovereign copy', async ({ page }) => {
    await page.goto('/templates?category=PUBLISHING_AND_LITERARY');
    await expect(page.getByRole('heading', { name: 'Covnant Control Board' })).toBeVisible();
    await expect(page.locator('[data-entity-class="PUBLISHING"]').first()).toBeVisible();
    await expect(page.locator('[data-entity-class="FILM"]')).toHaveCount(0);
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/[Ss]overeign/);
  });

  test('serves the sector doors fail-closed — 200 for known, 404 for unknown', async ({
    request,
  }) => {
    const known = await request.get('/api/v1/entities/MUSIC');
    expect(known.status()).toBe(200);
    const body = (await known.json()) as { ok: boolean; sector: string; atomicRecords: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.sector).toBe('MUSIC');
    expect(body.atomicRecords.length).toBeGreaterThanOrEqual(1);

    const unknown = await request.get('/api/v1/entities/GALACTIC');
    expect(unknown.status()).toBe(404);
    const unknownBody = (await unknown.json()) as { ok: boolean; reason: string };
    expect(unknownBody.ok).toBe(false);
    expect(unknownBody.reason).toBe('unknown_sector');
  });
});
