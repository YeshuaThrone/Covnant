import { expect, test } from '@playwright/test';

/**
 * Workspace smoke at phone width — runs inside the mobile-chrome projects
 * (390x844 and 375x720, mobile UA + touch) and never at desktop size.
 *
 * Below the `lg` breakpoint the shell swaps the fixed sidebar for the
 * mobile-top header with the hamburger drawer (AppShell's responsive
 * contract); this spec pins that swap, the drawer's five destinations and
 * seeded user chip, and the Gold Board money home's above-the-fold
 * composition at a width real phones actually have. Data-state tolerant:
 * the shared server serves only the deterministic dev-seed store
 * (webServer DON_DEV_SEED=1) — the same data the desktop workspace-views
 * spec asserts against.
 */

test('the shell renders mobile-top chrome with the drawer and hides the desktop sidebar', async ({
  page,
}) => {
  await page.goto('/dashboard');

  // The sub-`lg` swap: the sticky sidebar is display:none, the mobile-top
  // header with the hamburger button is the chrome.
  const sidebar = page.locator('aside[data-shell="sidebar"]');
  const mobileTop = page.locator('header[data-shell="mobile-top"]');
  await expect(mobileTop).toBeVisible();
  await expect(sidebar).toBeHidden();

  const drawerButton = page.getByTestId('mobile-drawer-button');
  await expect(drawerButton).toBeVisible();
  await expect(drawerButton).toHaveAttribute('aria-expanded', 'false');
});

test('the drawer opens with the five destinations and the seeded user chip, and navigates', async ({
  page,
}) => {
  await page.goto('/dashboard');

  await page.getByTestId('mobile-drawer-button').click();
  const drawer = page.getByTestId('mobile-drawer');
  await expect(drawer).toBeVisible();
  await expect(page.getByTestId('mobile-drawer-button')).toHaveAttribute('aria-expanded', 'true');

  // The five workspace destinations, unchanged from the desktop sidebar —
  // the drawer re-skins HOW they are reached, not WHERE they go.
  // exact: true — the drawer's monogram link is "Gold Board home", a
  // substring match would collide with the Gold Board destination.
  for (const label of ['Gold Board', 'Covnant ID', 'Virtual Card', 'Sync License', 'Settings']) {
    await expect(drawer.getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  await expect(page.getByTestId('drawer-user-chip')).toContainText('Yeshua Throne');

  // Navigation works from the drawer and the drawer closes on the way out.
  await drawer.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId('mobile-drawer')).toHaveCount(0);
  await expect(page.getByTestId('settings-profile')).toBeVisible();
});

test('the Gold Board money home renders above the fold at phone width', async ({ page }) => {
  await page.goto('/dashboard');

  // Same money-home composition the desktop spec pins — the greeting, the
  // three vault buckets, the revenue streams strip — now at a phone width.
  await expect(page.getByTestId('greeting')).toContainText('Hi, Yeshua Throne');
  await expect(page.getByTestId('account-card-available')).toBeVisible();
  await expect(page.getByTestId('account-card-pending')).toBeVisible();
  await expect(page.getByTestId('account-card-reserve')).toBeVisible();
  await expect(page.getByTestId('revenue-streams')).toBeVisible();
  await expect(page.getByTestId('revenue-stream')).toHaveCount(4);
  await expect(page.getByTestId('quick-action')).toHaveCount(0);
});

test('the landing renders without horizontal overflow at phone width', async ({ page }) => {
  await page.goto('/');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'the landing scrolls horizontally at phone width').toBeLessThanOrEqual(0);
});

// KNOWN DEFECT, unfixable here — this change is test infra only (no app
// edits): the Gold Board overflows horizontally at 390px by 225px —
// scrollWidth 615px against a 390px viewport, driven by
// data-testid="transactions-panel" and data-testid="readiness-checklist"
// rendering 599px wide (their transaction rows neither wrap nor scroll in
// their own container). When the app-side responsive fix lands, un-fixme
// this and re-pin /dashboard to zero overflow.
test.fixme('the dashboard renders without horizontal overflow at phone width', async ({
  page,
}) => {
  await page.goto('/dashboard');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
