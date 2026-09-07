import { expect, test } from '@playwright/test';

/**
 * Identity badge in the workspace shell — the persistent sidebar slot renders
 * the honest unregistered state on every workspace route, hidden below lg
 * (the mobile top-bar header stays untouched this generation).
 */

test('the shell sidebar carries the unregistered identity badge on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dashboard');

  const badge = page.locator('aside[data-shell="sidebar"] [data-identity="unregistered"]');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('data-state', 'unregistered');
  await expect(badge).toHaveText(/No identity yet/);

  // The mobile header block carries no identity surface.
  await expect(page.locator('[data-shell="mobile-top"] [data-identity]')).toHaveCount(0);
});

test('the identity badge is hidden below lg', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await page.goto('/dashboard');

  // The sidebar itself collapses below lg; the badge inside it must not render.
  const badge = page.locator('[data-identity="unregistered"]');
  await expect(badge).toBeHidden();
});
