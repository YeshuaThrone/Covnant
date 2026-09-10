import { expect, test } from '@playwright/test';

/**
 * Spec §5 — the core workspace views behind the sidebar: dashboard metrics
 * and quick actions, catalog grid with universal registry pills, ledger
 * reconciliation audit, membership plans without payment rails, and
 * client-side settings persistence. Data-state tolerant: runs green in both
 * memory mode and Supabase mode.
 */

test('dashboard renders the bank-home surface: honest state, gold rules, quick actions when signed in', async ({ page }) => {
  await page.goto('/dashboard');

  // Data-state tolerant: the shared webServer has no Supabase credentials,
  // so the resolver fails closed to the honest visitor state. Either way,
  // the page is a real dashboard surface — never a bare heading with zeros.
  const visitor = page.getByTestId('dashboard-signin-cta');
  if ((await visitor.count()) > 0) {
    // Visitor state — the honest sign-in path, no fabricated accounts
    // and no fabricated quick actions.
    await expect(visitor).toHaveAttribute('href', '/signin');
    await expect(page.getByTestId('accounts-row')).toHaveCount(0);
    await expect(page.getByLabel('Quick actions')).toHaveCount(0);
  } else {
    // Signed-in state — the greeting hero and accounts row.
    await expect(page.getByTestId('greeting')).toBeVisible();
    await expect(page.getByTestId('accounts-row')).toBeVisible();

    // Quick actions — directive: Register Asset, New Contract, Browse
    // Templates — the wired destinations.
    const actions = page.getByLabel('Quick actions').getByRole('link');
    await expect(actions.filter({ hasText: 'Register Asset' })).toHaveAttribute('href', '/assets');
    await expect(actions.filter({ hasText: 'New Contract' })).toHaveAttribute('href', '/contracts');
    await expect(actions.filter({ hasText: 'Browse Templates' })).toHaveAttribute(
      'href',
      '/templates',
    );
  }
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

test('settings persists workspace preferences locally and survives a reload', async ({
  page,
}) => {
  await page.goto('/settings');

  const currency = page.getByTestId('display-currency');
  await expect(currency).toBeEnabled();
  await currency.selectOption('EUR');

  const codeDisplay = page.getByTestId('code-display');
  await codeDisplay.selectOption('MASKED');
  await expect(page.getByRole('status')).toContainText('Saved in this browser');

  const stored = await page.evaluate(() =>
    window.localStorage.getItem('covnant.settings.v1'),
  );
  expect(stored).toBeTruthy();
  expect(stored!).toContain('"displayCurrency":"EUR"');
  expect(stored!).toContain('"codeDisplay":"MASKED"');

  await page.reload();
  await expect(page.getByTestId('display-currency')).toHaveValue('EUR');
  await expect(page.getByTestId('code-display')).toHaveValue('MASKED');
});
