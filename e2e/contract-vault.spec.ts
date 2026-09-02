import { expect, test } from '@playwright/test';

/**
 * Spec §07 — Contract Vault gates: 14 templates under two industries,
 * asset-of-record hydration, draft → final → export.
 *
 * Runs after asset-studio.spec.ts (serial, single worker): the "E2E Pool
 * Gate Song" asset registered there is the asset of record here.
 */

test('lists 14 templates under the Music and Film/Media/Merch tabs', async ({ page }) => {
  await page.goto('/contracts');

  const templateCards = page.locator('a[href^="/contracts/new?template="]');
  await expect(templateCards).toHaveCount(14);

  // Industry tabs (href-scoped — template card names also contain "Music").
  await expect(page.locator('a[href="/contracts?industry=MUSIC"]')).toBeVisible();
  await expect(page.locator('a[href="/contracts?industry=FILM_MEDIA_MERCH"]')).toBeVisible();

  // Both industries represented: at least one film template card is labelled.
  await expect(page.getByText('Film, Media & Merch').first()).toBeVisible();
});

test('generates a Split Sheet from the asset of record, saves a draft, finalizes, and exports', async ({
  page,
}) => {
  await page.goto('/contracts');

  await page.locator('a[href^="/contracts/new?template=MUSIC_SPLIT_SHEET"]').click();
  await page.waitForURL(/template=MUSIC_SPLIT_SHEET/);

  // Asset picker hydrates from stored pools — pick the E2E asset.
  await page.locator('a[href*="cbt=CBT-"]').first().click();
  await page.waitForURL(/template=MUSIC_SPLIT_SHEET&cbt=CBT-/);

  // The agreement hydrates from the stored pools: the E2E holders appear.
  await expect(page.getByText('Alice E2E').first()).toBeVisible();
  await expect(page.getByText('Bob E2E').first()).toBeVisible();

  await page.getByRole('button', { name: /Save draft/ }).click();
  // The first save creates the contract and navigates to its own editor page
  // (the editor re-mounts, so the button label resets to "Save draft") — the
  // reliable signal is the URL landing on the saved contract.
  await page.waitForURL(/\/contracts\/[a-zA-Z0-9_-]+$/);

  await page.getByRole('button', { name: /Mark final/ }).click();
  await expect(page.getByText('FINAL — immutable')).toBeVisible();

  const exportHref = await page.locator('a[href$="/export"]').getAttribute('href');
  expect(exportHref).toMatch(/^\/contracts\/.+\/export$/);

  const res = await page.request.get(exportHref!);
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain('Split Sheet');
  expect(body).toContain('Alice E2E');
});
