import { expect, test } from '@playwright/test';

/**
 * Spec §07 (directive §4) — Contract Vault gates: 20 deterministic agreements
 * across the SIX MASTER entertainment verticals (founder canon — Film &
 * Television, Audio & Recorded Sound, Publishing & Literary, Live Performance
 * & Comedy, Interactive & Digital Media, Commercial & Brand Licensing), the
 * /templates master-vertical
 * library, auto-fill from the asset of record (names, splits, identifiers —
 * PRO/IPI never fabricated), Draft/Pending/Completed presentation, signature
 * tracking, and draft → final → export.
 *
 * Runs after asset-studio.spec.ts (serial, single worker): the "E2E Pool
 * Gate Song" asset registered there is the asset of record here. Its holders
 * carry no ISNI/IPI — the auto-fill panels must show "To be completed", not
 * invented numbers.
 */

test('/templates hydrates the Covnant Control Board across the six master verticals', async ({ page }) => {
  await page.goto('/templates');

  // All six master vertical sections render (founder taxonomy).
  for (const label of [
    'Film & Television',
    'Audio & Recorded Sound',
    'Publishing & Literary',
    'Live Performance & Comedy',
    'Interactive & Digital Media',
    'Commercial & Brand Licensing',
  ]) {
    await expect(page.getByRole('heading', { name: label })).toBeVisible();
  }

  // The completed 31-record factory library renders as data cards.
  await expect(page.getByTestId('factory-template-card')).toHaveCount(31);

  // The founder-verbatim seeds render with their canon 50/35/15 structure.
  for (const [templateId, name] of [
    ['TPL-AUD-001', 'Master Recording & Streaming Royalty Agreement'],
    ['TPL-FLM-004', 'Global SVOD & AVOD Distribution Option Contract'],
    ['TPL-LIT-002', 'Audiobook & Digital E-Book Rights Acquisition'],
    ['TPL-LVE-009', 'Live Stand-Up & Concert Touring Ticket Escrow'],
  ] as const) {
    const card = page.locator(`[data-testid="factory-template-card"][data-template-id="${templateId}"]`);
    await expect(card).toContainText(name);
    await expect(card).toContainText('Ownership reserve 50%');
    await expect(card).toContainText('Creative payout 35%');
    await expect(card).toContainText('Operations yield 15%');
  }

  // Jurisdiction, engineered clauses, and execution history render on the card.
  const aud = page.locator('[data-testid="factory-template-card"][data-template-id="TPL-AUD-001"]');
  await expect(aud).toContainText('US-TX Ledger Standard');
  await expect(aud).toContainText('Sub-Second Micro-Royalty Routing');
  await expect(aud).toContainText('1,420 executions');

  // The DEMO DATA disclosure stays on the factory.
  await expect(page.getByTestId('demo-data-badge')).toBeVisible();

  // The atomic entity registry joins the page — 26
  // sector records beneath the factory grids, every field from the store.
  await expect(page.getByTestId('atomic-template-card')).toHaveCount(26);
  const flm = page.locator('[data-testid="atomic-template-card"][data-template-id="TPL-FLM-001"]');
  await expect(flm).toContainText('Feature Film Theatrical Distribution Master Agreement');
  await expect(flm).toContainText('Film Studio');
  await expect(flm).toContainText('Box Office Gross Receipts and ISAN Telemetry');
  await expect(flm).toContainText('Ownership reserve 50%');
  await expect(flm).toContainText('Creative payout 35%');
  await expect(flm).toContainText('Operations yield 15%');
  await expect(flm).toContainText('Box Office Gross Escrow Lock');
  await expect(flm).toContainText('890 executions');
  await expect(flm.locator('[data-testid="atomic-sector-chip"]')).toHaveText('FILM');
  await expect(flm.locator('[data-testid="factory-execution-status"]')).toHaveText('PRODUCTION READY');
  // The generated theatrical record survives the collision — renumbered to
  // TPL-FLM-007 for the founder's verbatim seed, otherwise intact.
  const flm7 = page.locator('[data-testid="factory-template-card"][data-template-id="TPL-FLM-007"]');
  await expect(flm7).toContainText('Theatrical Distribution & Box Office Settlement');
});

test('/templates vertical tabs swap the factory library per master vertical', async ({ page }) => {
  // A vertical tab shows ONLY that vertical's fully populated library.
  await page.goto('/templates?category=INTERACTIVE_AND_DIGITAL_MEDIA');
  await expect(page.getByRole('heading', { name: 'Interactive & Digital Media' })).toBeVisible();
  await expect(page.getByTestId('factory-template-card')).toHaveCount(4);
  await expect(page.getByText('Video Game Distribution & Microtransaction Royalty Agreement')).toBeVisible();
  await expect(page.getByText('Master Recording & Streaming Royalty Agreement')).toHaveCount(0);

  // The atomic registry swaps with the tab — this vertical clears the eight
  // interactive/digital sectors, founder seeds included.
  await expect(page.getByTestId('atomic-template-card')).toHaveCount(8);
  await expect(page.getByText('3D CAD Mesh Spatial Asset Licensing Agreement')).toBeVisible();
  await expect(page.getByText('Virtual Avatar Rigging and Model Ownership Contract')).toBeVisible();
  await expect(page.getByTestId('atomic-template-card').filter({ hasText: 'MOTORSPORT' })).toHaveCount(0);

  // Clicking another tab swaps every card for that vertical's library.
  await page.locator('a[href="/templates?category=LIVE_PERFORMANCE_AND_COMEDY"]').click();
  await page.waitForURL(/category=LIVE_PERFORMANCE_AND_COMEDY/);
  await expect(page.getByRole('heading', { name: 'Live Performance & Comedy' })).toBeVisible();
  await expect(page.getByTestId('factory-template-card')).toHaveCount(5);
  await expect(page.getByText('Live Stand-Up & Concert Touring Ticket Escrow')).toBeVisible();
  await expect(page.getByText('Video Game Distribution & Microtransaction Royalty Agreement')).toHaveCount(0);

  // The atomic swap follows: four live-economy sectors, founder seeds first.
  await expect(page.getByTestId('atomic-template-card')).toHaveCount(4);
  await expect(page.getByText('Motorsport Circuit Trackage Media Rights Agreement')).toBeVisible();
  await expect(page.getByText('Arena Venue Facility Access and Gate Yield Clearing')).toBeVisible();
  await expect(page.getByText('3D CAD Mesh Spatial Asset Licensing Agreement')).toHaveCount(0);

  // All verticals restores the completed library.
  await page.getByRole('tab', { name: 'All verticals' }).click();
  await page.waitForURL(/\/templates$/);
  await expect(page.getByTestId('factory-template-card')).toHaveCount(31);
  await expect(page.getByTestId('atomic-template-card')).toHaveCount(26);
});

test('template navigation generates an auto-filled agreement from the asset of record', async ({
  page,
}) => {
  // The vault owns the generation flow — the factory cards link its data,
  // the vault's catalog cards start the drafts.
  await page.goto('/contracts');

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

  // Registry identifiers map in: the MUL flow auto-provisions the canonical
  // CBT and CVT tracking pills (codes derive per registration, so assert the
  // pattern, not a literal). Absent holder-profile data renders as
  // to-be-completed — never fabricated.
  await expect(page.getByText(/CBT-TRK-[0-9A-F]{12}/).first()).toBeVisible();
  await expect(page.getByText(/CVT-TRK-/).first()).toBeVisible();
  await expect(page.getByText('IPI (PRO): To be completed').first()).toBeVisible();

  // Status presentation maps the stored DRAFT to "Draft".
  await expect(page.getByTestId('contract-status-chip')).toHaveText('Draft');

  // Payout views render the (empty) ledger read for this asset.
  await expect(page.getByText('No settled revenue for this asset yet.')).toBeVisible();
});

test('vault lists 20 templates under the six master vertical tabs', async ({ page }) => {
  await page.goto('/contracts');

  const templateCards = page.locator('a[href^="/contracts/new?template="]');
  await expect(templateCards).toHaveCount(20);

  // Master vertical tabs (href-scoped — card names also contain category words).
  for (const key of [
    'FILM_AND_TELEVISION',
    'AUDIO_AND_RECORDED_SOUND',
    'PUBLISHING_AND_LITERARY',
    'LIVE_PERFORMANCE_AND_COMEDY',
    'INTERACTIVE_AND_DIGITAL_MEDIA',
    'COMMERCIAL_AND_BRAND_LICENSING',
  ]) {
    await expect(page.locator(`a[href="/contracts?category=${key}"]`)).toBeVisible();
  }

  // Filtering: Interactive & Digital Media shows exactly its three agreements.
  await page.locator('a[href="/contracts?category=INTERACTIVE_AND_DIGITAL_MEDIA"]').click();
  await page.waitForURL(/category=INTERACTIVE_AND_DIGITAL_MEDIA/);
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

  // Verification strip rides the active contract editor, and the reconciled
  // asset of record leaves posting unlocked (no amber lock notice, buttons live).
  // (role="alert" is owned by Next's route announcer — match the lock text.)
  await expect(page.locator('span[data-verification="pre-reconciled"]')).toHaveAttribute('data-state', 'active');
  await expect(page.getByText(/Pre-posting reconciliation locked/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Save draft/ })).toBeEnabled();

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
