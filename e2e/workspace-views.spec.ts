import { expect, test } from '@playwright/test';

/**
 * Spec §5 — the core workspace views behind the sidebar: dashboard metrics
 * and quick actions, catalog grid with universal registry pills, ledger
 * reconciliation audit, membership plans without payment rails, and
 * client-side settings persistence. Data-state tolerant: runs green in both
 * memory mode and Supabase mode.
 */

test('dashboard renders The Don home: three vault cards, revenue streams, no quick actions', async ({
  page,
}) => {
  await page.goto('/dashboard');

  // The Don home replaced the metric-card dashboard: the greeting + three
  // vault-bucket cards are the new above-the-fold composition.
  await expect(page.getByTestId('greeting')).toContainText('Hi, Yeshua Throne');
  await expect(page.getByTestId('account-card-available')).toBeVisible();
  await expect(page.getByTestId('account-card-pending')).toBeVisible();
  await expect(page.getByTestId('account-card-reserve')).toBeVisible();

  // D1 removed Quick Actions from the Gold Board: the strip carries the
  // revenue-streams section instead.
  await expect(page.getByTestId('quick-action')).toHaveCount(0);
  await expect(page.getByTestId('revenue-streams')).toBeVisible();
  await expect(page.getByTestId('revenue-stream')).toHaveCount(4);
});

test('catalog shows registered assets with universal registry pills, or the empty state', async ({
  page,
}) => {
  await page.goto('/catalog');
  await expect(page.getByRole('heading', { name: 'Covenant Block Catalog' })).toBeVisible();

  const cards = page.getByTestId('catalog-card');
  const empty = page.getByTestId('catalog-empty');

  if ((await cards.count()) > 0) {
    const first = cards.first();
    await first.click();
    await page.waitForURL(/\/assets\/CBT-/);
  } else {
    await expect(empty).toBeVisible();
    await expect(empty.getByRole('link', { name: /Register the first asset/ })).toBeVisible();
  }
});

test('ledger renders the reconciliation audit above the settlement table', async ({ page }) => {
  await page.goto('/ledger');

  // Reconciliation status strip — badge text varies with data state.
  await expect(page.getByLabel('Reconciliation audit').getByText(/Reconciled|Attention|No settlements/)).toBeVisible();

  // Exact per-currency totals render when the ledger holds rows.
  if ((await page.getByTestId('reconciliation-totals').count()) > 0) {
    await expect(page.getByTestId('reconciliation-totals')).toContainText('Gross');
  }

  await expect(page.getByRole('columnheader', { name: 'Transaction' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run system audit' })).toBeVisible();
});

test('membership plans render as static marketing with no payment rails', async ({ page }) => {
  await page.goto('/pricing');

  await expect(page.getByTestId('plan-list')).toBeVisible();
  await expect(page.getByTestId('plan-list')).toContainText('Creator');
  await expect(page.getByTestId('plan-list')).toContainText('Studio');
  await expect(page.getByTestId('plan-list')).toContainText('Institution');

  // No payments integration: the honest billing note, and no checkout form.
  await expect(page.getByTestId('billing-note')).toContainText('no payments are processed today');
  await expect(page.locator('form')).toHaveCount(0);
});

test('settings renders real account facts with fiat-only currency and honest unavailable states', async ({
  page,
}) => {
  await page.goto('/settings');

  // Profile — real session/seeded facts, not browser-local preferences.
  await expect(page.getByTestId('settings-profile')).toBeVisible();
  await expect(page.getByTestId('settings-stage-name')).toContainText('Yeshua Throne');
  await expect(page.getByTestId('settings-kyc')).toBeVisible();
  await expect(page.getByTestId('settings-provisioning')).toBeVisible();

  // Payout account — the real link state.
  await expect(page.getByTestId('settings-bank-status')).toBeVisible();

  // Currency is fiat-only: USD, with no currency selector at all.
  await expect(page.getByTestId('settings-currency-value')).toHaveText('USD');
  await expect(page.getByTestId('settings-currency-note')).toContainText('fiat only');
  await expect(page.getByTestId('display-currency')).toHaveCount(0);

  // Notifications and security have no backing store — honest disclosures,
  // no fake toggles or forms.
  await expect(page.getByTestId('settings-notifications-note')).toContainText(
    'not available yet',
  );
  await expect(page.getByTestId('settings-security-note')).toContainText(
    'not available yet',
  );
  await expect(page.locator('form')).toHaveCount(0);
});
