/**
 * Universal Execution Lane e2e — the founder's production URL pattern
 * (/contracts/new?template=<key>&cbt=<cbt>) renders fully hydrated through
 * the ONE backend seam, every vertical's asset picker renders its sector,
 * and the /templates and /admin regressions still hold.
 *
 * Runs against the shared DON_DEV_SEED webServer from playwright.config.ts.
 */
import { expect, test } from '@playwright/test';

const FOUNDER_URL =
  '/contracts/new?template=FASHION_RUNWAY_TALENT_RELEASE&cbt=CBT-TRK-A51DF05B4279';

test.describe('execution lane — founder URL hydration', () => {
  test('renders the founder URL fully hydrated — template, asset, identifiers, pools, Covnant Block', async ({ page }) => {
    await page.goto(FOUNDER_URL);

    // Template card — alias resolved to the FASHION atomic record.
    await expect(page.getByRole('heading', { name: 'Template of record' })).toBeVisible();
    await expect(page.getByText('TPL-FSH-001').first()).toBeVisible();
    await expect(page.getByText('resolved from key FASHION_RUNWAY_TALENT_RELEASE')).toBeVisible();
    await expect(page.getByText('PRODUCTION_READY').first()).toBeVisible();

    // Asset of record — bound, nothing invented.
    await expect(page.getByRole('heading', { name: 'Asset of record' })).toBeVisible();
    await expect(page.getByText('E2E Pool Gate Song').first()).toBeVisible();
    await expect(page.getByText('CBT-TRK-A51DF05B4279').first()).toBeVisible();
    await expect(page.getByText('US-S1Z-26-42791')).toBeVisible();
    await expect(page.getByText('bound · no manual entry, nothing invented')).toBeVisible();

    // Identities — full UCT blocks, never 'To be completed'.
    await expect(page.getByText('Yeshua Throne').first()).toBeVisible();
    await expect(page.getByText('0000-0001-2345-6789').first()).toBeVisible();
    await expect(page.getByText('To be completed')).toHaveCount(0);

    // Pools — 50/35/15 reconciled in integer bps.
    await expect(page.getByText('Ownership reserve').first()).toBeVisible();
    await expect(page.getByText('5,000 bps').first()).toBeVisible();
    await expect(page.getByText('3,500 bps').first()).toBeVisible();
    await expect(page.getByText('1,500 bps').first()).toBeVisible();

    // Live contract preview — the COVNANT spelling and the display lineage.
    await expect(page.getByText('Covnant Block: CBT-TRK-A51DF05B4279').first()).toBeVisible();
    await expect(page.getByText('CVT-TRK-4279').first()).toBeVisible();

    // Guard verdicts visible in the payload.
    await expect(page.getByText('Guard report').first()).toBeVisible();

    // DEMO disclosure.
    await expect(page.getByText('DEMO DATA — seeded master-store record').first()).toBeVisible();
  });

  test('blocks cross-domain execution behind a visible 409 verdict at the API while the page renders', async ({ request }) => {
    const response = await request.post('/api/v1/contracts/execute', {
      data: { templateKey: 'FASHION_RUNWAY_TALENT_RELEASE', cbt: 'CBT-TRK-A51DF05B4279' },
    });
    expect(response.status()).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('guard_blocked');
  });
});

test.describe('execution lane — every vertical renders', () => {
  test('the film vertical renders its sector payload through the picker', async ({ page }) => {
    await page.goto(FOUNDER_URL);
    await page.getByRole('link', { name: 'Meridian Line — Theatrical Master' }).click();
    await expect(page.getByText('CBT-FLM-7C3A91D2E40B').first()).toBeVisible();
    await expect(page.getByText('Covnant Block: CBT-FLM-7C3A91D2E40B').first()).toBeVisible();
    await expect(page.getByText('CVT-FLM-E40B').first()).toBeVisible();
  });

  test('the publishing vertical renders its sector payload through the picker', async ({ page }) => {
    await page.goto(FOUNDER_URL);
    await page.getByRole('link', { name: 'The Ownership Ledger — Hardcover Edition' }).click();
    await expect(page.getByText('CBT-BOK-2E6B4F08A3D9').first()).toBeVisible();
    await expect(page.getByText('Covnant Block: CBT-BOK-2E6B4F08A3D9').first()).toBeVisible();
    await expect(page.getByText('CVT-BOK-A3D9').first()).toBeVisible();
  });

  test('the fashion vertical renders the seeded fashion asset', async ({ page }) => {
    await page.goto(FOUNDER_URL);
    await page.getByRole('link', { name: 'Sovereign Fit — Capsule Drop 4' }).click();
    await expect(page.getByText('CBT-FSH-3F7A1B9D5E2C').first()).toBeVisible();
    await expect(page.getByText('Covnant Block: CBT-FSH-3F7A1B9D5E2C').first()).toBeVisible();
  });

  test('unknown template key redirects to the vault — no invented record', async ({ page }) => {
    await page.goto('/contracts/new?template=NOT_A_TEMPLATE&cbt=CBT-TRK-A51DF05B4279');
    expect(page.url()).toContain('/contracts');
  });

  test('unknown CBT with a known template fails closed on 404 — no invented record', async ({ page }) => {
    const response = await page.goto('/contracts/new?template=TPL-MUS-001&cbt=CBT-XXX-000000000000');
    expect(response?.status()).toBe(404);
    await expect(page.getByText('could not be found', { exact: false })).toBeVisible();
  });
});

test.describe('execution lane — regressions', () => {
  test('/templates still renders', async ({ page }) => {
    await page.goto('/templates');
    await expect(page.getByText('Contract Templates', { exact: false })).toBeVisible();
  });

  test('/admin still renders behind the gate', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Covenant operations' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Console sections' })).toBeVisible();
  });
});
