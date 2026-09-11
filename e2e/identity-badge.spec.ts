import { expect, test } from '@playwright/test';

/**
 * Identity surface in the workspace shell — the fixture era. The Don home
 * is backed by the dashboard fixtures provider, so the shell's honest
 * identity slot is the fixture holder's user chip (stage name + initials)
 * at the sidebar's bottom — a display, not a control — and the mobile top
 * bar carries no identity surface (the chip rides inside the drawer).
 */

test('the shell sidebar carries the fixture holder user chip on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dashboard');

  // The sidebar is the desktop identity surface: the COVNANT brand chip + the
  // chip (brand slot = Covnant; the page-title slot carries The Don).
  const sidebar = page.locator('aside[data-shell="sidebar"]');
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toContainText('COVNANT');
  const chip = page.getByTestId('shell-user-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Nova Reign');
  await expect(chip).toContainText('NR');

  // No fabricated identity anywhere: no UCT, no unregistered placeholder.
  await expect(page.locator('[data-identity="unregistered"]')).toHaveCount(0);
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('UCT-');

  // The mobile top bar carries no identity surface on desktop (CSS-hidden
  // at lg; its hamburger + drawer own the mobile slot).
  await expect(page.locator('[data-shell="mobile-top"]')).toBeHidden();
});

test('the sidebar identity slot is hidden below lg — the drawer carries the chip', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await page.goto('/dashboard');

  // The sidebar collapses below lg; the chip is not visible until the
  // drawer opens.
  await expect(page.locator('aside[data-shell="sidebar"]')).toBeHidden();
  await expect(page.getByTestId('shell-user-chip')).toBeHidden();

  // The drawer is the mobile identity surface: open it, its chip is there.
  await page.getByTestId('mobile-drawer-button').click();
  const drawer = page.getByTestId('mobile-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId('drawer-user-chip')).toBeVisible();
  await expect(drawer.getByTestId('drawer-user-chip')).toContainText('Nova Reign');
});
