/**
 * The Don dashboard home — e2e (bank reference: BANKAPPDT&MOBILE,
 * element-for-element). The dashboard is LIVE-data backed: the production
 * server boots with DON_DEV_SEED=1 (see playwright.config.ts), which
 * seeds the in-memory store through the real engines and serves the
 * seeded persona — so no auth is needed and these gates run against the
 * production build's /dashboard directly.
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
    await expect(page).toHaveTitle('Goldboard — Covnant');

    // Sidebar shell: the COVNANT brand chip (brand slot) + the user chip
    // from the provider; the page header below carries The Don wordmark.
    await expect(page.getByTestId('shell-user-chip')).toContainText('Nova Reign');
    await expect(page.locator('[data-shell="sidebar"]')).toContainText('COVNANT');

    // Page header wordmark + greeting + avatar chip. The seeded render IS
    // the sessionless demo view — exactly ONE DEMO DATA badge, top of the
    // main content, opposite the wordmark.
    await expect(page.getByTestId('don-wordmark')).toContainText('THE DON');
    await expect(page.getByTestId('demo-data-badge')).toHaveCount(1);
    await expect(page.getByTestId('demo-data-badge')).toBeVisible();
    await expect(page.getByTestId('greeting')).toContainText('Hi, Nova Reign');
    await expect(page.getByTestId('avatar-chip')).toBeVisible();

    // Accounts — three bucket cards, right-aligned balances, View all.
    await expect(page.getByTestId('account-card-available')).toBeVisible();
    await expect(page.getByTestId('account-card-pending')).toBeVisible();
    await expect(page.getByTestId('account-card-reserve')).toBeVisible();
    await expect(page.getByTestId('account-card-available-balance')).toContainText('$800.00');
    await expect(page.getByTestId('account-card-available-balance')).toHaveClass(/text-right/);
    await expect(page.getByTestId('account-card-pending-balance')).toContainText('$2,474.85');
    await expect(page.getByTestId('account-card-reserve-balance')).toContainText('$450.00');
    await expect(page.getByTestId('accounts-view-all')).toHaveAttribute('href', '/ledger');

    // Payout tiles — the sandbox rail vocabulary.
    await expect(page.getByTestId('payout-tile')).toHaveCount(2);
    await expect(page.locator('[data-testid="payout-tile"][data-rail="rtp"]')).toContainText(
      'Instant',
    );
    await expect(page.locator('[data-testid="payout-tile"][data-rail="ach"]')).toContainText(
      '+3 business days',
    );

    // Quick actions — compact squares on real routes.
    await expect(page.getByTestId('quick-action')).toHaveCount(3);
    await expect(page.locator('a[data-testid="quick-action"]').first()).toHaveAttribute(
      'href',
      '/assets',
    );

    // Transactions — dense rows with pairs, See more into the ledger. The
    // newest seeded journal is the ACH payout hold (Aug 7).
    await expect(page.getByTestId('transactions-row')).toHaveCount(6);
    await expect(page.getByTestId('transactions-row').first()).toContainText('DR $450.00 / CR $0.00');
    await expect(page.getByTestId('transactions-see-more')).toHaveAttribute('href', '/ledger');

    // Readiness panel + thin footer.
    await expect(page.getByTestId('readiness-kyc')).toBeVisible();
    await expect(page.getByTestId('readiness-kyc')).toHaveAttribute('data-state', 'complete');
    await expect(page.locator('footer')).toContainText('Covnant');

    // The carousel dots are mobile-only (md:hidden) — hidden at 1440px.
    await expect(page.getByTestId('carousel-dots')).toBeHidden();
  });

  test('never fabricates identity or breaks the brand rails', async ({ page }) => {
    await page.goto('/dashboard');
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('UCT-'); // the signup contract's disclosure, not here
    expect(body).not.toContain('accountNumber');
    expect(body).not.toContain('routingNumber');
  });

  test('the demo door: the seeded dashboard lands sessionless — zero actions, no sign-in wall', async ({ page }) => {
    await page.goto('/dashboard');

    // The populated dashboard renders immediately — no NO SESSION wall, no
    // sign-in redirect, and exactly ONE DEMO DATA disclosure so the seeded
    // balances never present as a real holder's.
    await expect(page.getByTestId('greeting')).toContainText('Hi, Nova Reign');
    await expect(page.getByTestId('account-card-available')).toBeVisible();
    await expect(page.getByTestId('demo-data-badge')).toHaveCount(1);
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('NO SESSION');
    expect(body).not.toContain('Your vault lives behind your sign-in');
  });
});

test.describe('The Don dashboard home — 390px mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('shows a single-card carousel with three dots and the hamburger drawer', async ({ page }) => {
    await page.goto('/dashboard');

    // The accounts row is a horizontal carousel on mobile: the dots are
    // visible only below md (md:hidden), the discriminating signal.
    const dots = page.getByTestId('carousel-dots');
    await expect(dots).toBeVisible();
    await expect(dots.getByRole('tab')).toHaveCount(3);
    await dots.getByRole('tab').nth(1).click();
    await expect(dots.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');

    // The demo disclosure rides at 390px too — opposite the wordmark.
    await expect(page.getByTestId('demo-data-badge')).toBeVisible();

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
    await expect(page.locator('[data-testid="payout-tile"][data-rail="rtp"]')).toContainText(
      'Instant',
    );
  });
});

test.describe('the signup-success gateway', () => {
  test('the landing CTA lands on /dashboard and The Don renders', async ({ page }) => {
    // The PR #12 gateway override: signup success routes to /dashboard.
    // The dev-seed-backed dashboard renders unconditionally, so the honest
    // e2e for the override is: the landing's entry CTA leads here.
    await page.goto('/');
    await page.getByRole('link', { name: /enter your world/i }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId('greeting')).toContainText('Hi, Nova Reign');
    await expect(page.getByTestId('don-wordmark')).toContainText('THE DON');
  });
});
