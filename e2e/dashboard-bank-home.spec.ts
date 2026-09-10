/**
 * The Don dashboard home — e2e (bank reference: BANKAPPDT&MOBILE,
 * element-for-element). The dashboard is fixture-backed, so no auth is
 * needed: these gates run against the production build's /dashboard
 * directly.
 *
 * Covers: the desktop composition (wordmark, greeting + avatar chip,
 * three vault-bucket cards with right-aligned balances, payout rail
 * tiles, quick actions on real routes, dense transactions + See more,
 * readiness panel, thin footer); the ~390px experience (single-card
 * carousel with dots, hamburger drawer); the signup-success gateway
 * (the landing CTA lands on /dashboard and The Don renders); and the
 * brand rails (browser title, no UCT anywhere).
 */

import { expect, test } from '@playwright/test';

test.describe('The Don dashboard home — desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('renders the full bank reference composition', async ({ page }) => {
    await page.goto('/dashboard');

    // Browser title — the rebrand reaches the tab.
    await expect(page).toHaveTitle('The Don — Covnant');

    // Sidebar shell: THE DON brand chip + the user chip from the provider.
    await expect(page.getByTestId('shell-user-chip')).toContainText('Nova Reign');
    await expect(page.locator('[data-shell="sidebar"]')).toContainText('THE DON');

    // Page header wordmark + greeting + avatar chip.
    await expect(page.getByTestId('don-wordmark')).toContainText('THE DON');
    await expect(page.getByTestId('greeting')).toContainText('Hi, Nova Reign');
    await expect(page.getByTestId('avatar-chip')).toBeVisible();

    // Accounts — three bucket cards, right-aligned balances, View all.
    await expect(page.getByTestId('vault-bucket-card')).toHaveCount(3);
    const available = page.getByTestId('bucket-available');
    await expect(available).toContainText('$2,478.30');
    await expect(available.locator('[data-testid="bucket-balance"]')).toHaveClass(/text-right/);
    await expect(page.getByTestId('bucket-pending')).toContainText('$912.05');
    await expect(page.getByTestId('bucket-reserve')).toContainText('$450.00');
    await expect(page.getByTestId('accounts-view-all')).toHaveAttribute('href', '/ledger');

    // Payout tiles — the sandbox rail vocabulary.
    await expect(page.getByTestId('payout-tile')).toHaveCount(2);
    await expect(page.getByTestId('payout-rtp')).toContainText('Instant');
    await expect(page.getByTestId('payout-ach')).toContainText('+3 business days');

    // Quick actions — compact squares on real routes.
    await expect(page.getByTestId('quick-action')).toHaveCount(3);
    await expect(page.locator('a[data-testid="quick-action"]').first()).toHaveAttribute(
      'href',
      '/assets',
    );

    // Transactions — dense rows with pairs, See more into the ledger.
    await expect(page.getByTestId('transaction-row')).toHaveCount(6);
    await expect(page.getByTestId('transaction-row').first()).toContainText('DR $0.00 / CR $129.90');
    await expect(page.getByTestId('see-more')).toHaveAttribute('href', '/ledger');

    // Readiness panel + thin footer.
    await expect(page.getByTestId('readiness-row').first()).toBeVisible();
    await expect(page.locator('footer')).toContainText('Covnant');
  });

  test('never fabricates identity or breaks the brand rails', async ({ page }) => {
    await page.goto('/dashboard');
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('UCT-'); // the signup contract's disclosure, not here
    expect(body).not.toContain('accountNumber');
    expect(body).not.toContain('routingNumber');
  });
});

test.describe('The Don dashboard home — 390px mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('shows a single-card carousel with three dots and the hamburger drawer', async ({ page }) => {
    await page.goto('/dashboard');

    // The accounts row is a horizontal carousel (flex, not the desktop grid).
    const row = page.getByTestId('accounts-row');
    await expect(row).toHaveClass(/overflow-x-auto/);
    await expect(row).not.toHaveClass(/md:grid/);

    // Carousel dots — three tabs; tapping the second dot marks it active.
    const dots = page.getByTestId('carousel-dots').getByRole('tab');
    await expect(dots).toHaveCount(3);
    await dots.nth(1).click();
    await expect(dots.nth(1)).toHaveAttribute('aria-selected', 'true');

    // The sidebar is hidden; navigation is the hamburger drawer.
    await expect(page.locator('[data-shell="sidebar"]')).toBeHidden();
    await page.getByTestId('mobile-drawer-button').click();
    const drawer = page.getByTestId('mobile-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('THE DON');
    await expect(drawer.getByRole('link', { name: 'Ownership Ledger' })).toBeVisible();
    await expect(drawer).toContainText('Nova Reign'); // the user chip rides along

    // Escape closes the drawer.
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });

  test('keeps quick actions and payout tiles in a compact grid', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('quick-action')).toHaveCount(3);
    await expect(page.getByTestId('payout-tile')).toHaveCount(2);
    await expect(page.getByTestId('payout-rtp')).toContainText('Instant');
  });
});

test.describe('the signup-success gateway', () => {
  test('the landing CTA lands on /dashboard and The Don renders', async ({ page }) => {
    // The PR #12 gateway override: signup success routes to /dashboard.
    // The fixture-backed dashboard renders unconditionally, so the honest
    // e2e for the override is: the landing's entry CTA leads here.
    await page.goto('/');
    await page.getByRole('link', { name: /enter your world/i }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId('greeting')).toContainText('Hi, Nova Reign');
    await expect(page.getByTestId('don-wordmark')).toContainText('THE DON');
  });
});
