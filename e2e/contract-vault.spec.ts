import { expect, test } from '@playwright/test';

/**
 * Spec §07 (directive §4) — Contract Vault gates: 16 deterministic agreements
 * across four categories (Music & Record Label, Film/TV & Hollywood, Gaming &
 * Interactive, Podcasts/Creators & Streamers), the /templates categorized
 * library, auto-fill from the asset of record (names, splits, identifiers —
 * PRO/IPI never fabricated), Draft/Pending/Completed presentation, signature
 * tracking, and draft → final → export.
 *
 * Runs after asset-studio.spec.ts (serial, single worker): the "E2E Pool
 * Gate Song" asset registered there is the asset of record here. Its holders
 * carry no ISNI/IPI — the auto-fill panels must show "To be completed", not
 * invented numbers.
 */

test('/templates lists 16 templates across the four industry sections', async ({ page }) => {
  await page.goto('/templates');

  // Four category sections render.
  for (const label of [
    'Music & Record Label',
    'Film, TV & Hollywood',
    'Gaming & Interactive',
    'Podcasts, Creators & Streamers',
  ]) {
    await expect(page.getByRole('heading', { name: label })).toBeVisible();
  }

  const cards = page.locator('a[href^="/contracts/new?template="]');
  await expect(cards).toHaveCount(16);

  // One named agreement per category spot-check (scoped to card links —
  // category blurbs can contain the same words).
  for (const name of [
    'Songwriter Split Sheet',
    'Film/TV Score Composer Contract',
    'Voiceover/MoCap Release',
    'Podcast Co-Host & Guest Split',
  ]) {
    await expect(page.locator('a[href^="/contracts/new?template="]', { hasText: name })).toBeVisible();
  }
});

test('/templates navigation generates an auto-filled agreement from the asset of record', async ({
  page,
}) => {
  await page.goto('/templates');

  await page.getByText('Songwriter Split Sheet').first().click();
  await page.waitForURL(/template=MUSIC_SPLIT_SHEET/);

  // Asset picker — choose the registered asset of record.
  await page.locator('a[href*="cbt=CBT-"]').first().click();
  await page.waitForURL(/template=MUSIC_SPLIT_SHEET&cbt=CBT-/);

  // Auto-fill panel: legal names and exact recorded splits from the pools.
  await expect(page.getByText('Auto-filled from the asset of record')).toBeVisible();
  await expect(page.getByText('Alice E2E').first()).toBeVisible();
  await expect(page.getByText('Bob E2E').first()).toBeVisible();
  await expect(page.getByText('100.0000%').first()).toBeVisible();

  // Registry identifiers map in; absent holder profile data renders as
  // to-be-completed — never fabricated.
  // The ISRC appears in the auto-fill pill and again inside the agreement
  // preview body — the first match (the pill) is the assertion target.
  await expect(page.getByText('US-S1M-26-77777').first()).toBeVisible();
  await expect(page.getByText('IPI (PRO): To be completed').first()).toBeVisible();

  // Status presentation maps the stored DRAFT to "Draft".
  await expect(page.getByTestId('contract-status-chip')).toHaveText('Draft');

  // Payout views render the (empty) ledger read for this asset.
  await expect(page.getByText('No settled revenue for this asset yet.')).toBeVisible();
});

test('vault lists 16 templates under the four category tabs', async ({ page }) => {
  await page.goto('/contracts');

  const templateCards = page.locator('a[href^="/contracts/new?template="]');
  await expect(templateCards).toHaveCount(16);

  // Category tabs (href-scoped — card names also contain category words).
  for (const key of ['MUSIC', 'FILM_TV', 'GAMING', 'CREATORS']) {
    await expect(page.locator(`a[href="/contracts?category=${key}"]`)).toBeVisible();
  }

  // Filtering: Gaming & Interactive shows exactly its three agreements.
  await page.locator('a[href="/contracts?category=GAMING"]').click();
  await page.waitForURL(/category=GAMING/);
  await expect(page.locator('a[href^="/contracts/new?template="]')).toHaveCount(3);
  await expect(page.getByText('In-Game Music Sync Licensing')).toBeVisible();
});

test('generates a Split Sheet from the asset of record, tracks signatures, saves a draft, finalizes, and exports', async ({
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

  // Client-side signature tracking flips the presentation to Pending.
  await page.getByRole('button', { name: 'Request signature' }).first().click();
  await expect(page.getByTestId('contract-status-chip')).toHaveText('Pending');
  await expect(page.getByText('Requested').first()).toBeVisible();

  await page.getByRole('button', { name: /Save draft/ }).click();
  // The first save creates the contract and navigates to its own editor page
  // (the editor re-mounts, so the button label resets to "Save draft") — the
  // reliable signal is the URL landing on the saved contract.
  await page.waitForURL(/\/contracts\/[a-zA-Z0-9_-]+$/);

  await page.getByRole('button', { name: /Mark final/ }).click();
  await expect(page.getByTestId('contract-status-chip')).toHaveText('Completed');
  await expect(page.getByText('FINAL — immutable')).toBeVisible();

  const exportHref = await page.locator('a[href$="/export"]').getAttribute('href');
  expect(exportHref).toMatch(/^\/contracts\/.+\/export$/);

  const res = await page.request.get(exportHref!);
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain('Split Sheet');
  expect(body).toContain('Alice E2E');
});
