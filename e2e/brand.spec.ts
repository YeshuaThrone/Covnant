import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Spec §07 — Brand system gates: the landing identity (CV emblem,
 * "Own Your Creation.", identity form with SMS device ping), the
 * Obsidian & Deep Gold shell, the no-blues rule, and sidebar route
 * resolution.
 */

test('landing shows the CV emblem, "Own Your Creation.", and reveals the identity form with SMS device ping', async ({
  page,
}) => {
  await page.goto('/');

  // Dialog handler registered before submit — the landing alerts on SMS ping.
  let dialogMessage: string | null = null;
  page.on('dialog', async (dialog) => {
    dialogMessage = dialog.message();
    await dialog.dismiss();
  });

  // CV emblem renders twice: the nav badge and the hero emblem.
  await expect(page.getByText('CV', { exact: true })).toHaveCount(2);

  // Landing H1 carries the tagline.
  await expect(page.locator('h1')).toHaveText(/Own Your Creation/);

  // 'Enter your world' reveals the identity form with its four fields.
  await page.getByRole('button', { name: 'Enter your world' }).click();
  const form = page.locator('form');
  await expect(form).toBeVisible();
  await expect(form.getByLabel('Legal Name')).toBeVisible();
  await expect(form.getByLabel('Artist Name')).toBeVisible();
  await expect(form.getByLabel('Business Email')).toBeVisible();
  await expect(form.getByLabel('Phone Number (SMS Required)')).toBeVisible();

  // Submitting pings the device and confirms via the SMS alert.
  await form.getByLabel('Legal Name').fill('Test Creator');
  await form.getByLabel('Artist Name').fill('Test Artist');
  await form.getByLabel('Business Email').fill('creator@example.com');
  await form.getByLabel('Phone Number (SMS Required)').fill('(000) 000-0000');
  await form.getByRole('button', { name: 'Send SMS & Enter World' }).click();
  await expect.poll(() => dialogMessage).toBe('SMS verification sent to (000) 000-0000');

  // Favicon ships the monogram (defined once, referenced by the app).
  const icon = fs.readFileSync(path.join(process.cwd(), 'src/app/icon.svg'), 'utf8');
  expect(icon).toContain('CV');
});

test('Bluesy artifacts and electric blues are absent repo-wide; vault and verification labels are present', async ({
  request,
}) => {
  // Repo-wide grep: no retired brand strings, no electric-blue values.
  const forbidden = /Bluesy|AI assistant|pricing tier|0066ff|00c8ff|electric[- ]?blue/i;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|css|md|svg)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (forbidden.test(text)) offenders.push(path.relative(process.cwd(), full));
      }
    }
  };
  walk(path.join(process.cwd(), 'src'));
  walk(path.join(process.cwd(), 'mcp'));
  expect(offenders).toEqual([]);

  // Vault and Smart Ledger verification labels are live in the app.
  const contracts = await request.get('/contracts');
  expect(await contracts.text()).toMatch(/Vault/i);
  const ledger = await request.get('/ledger');
  expect(await ledger.text()).toMatch(/Smart Ledger/i);
});

test('the Obsidian shell carries the full sidebar and every workspace route resolves', async ({
  page,
  request,
}) => {
  await page.goto('/dashboard');

  // Fixed sidebar with the nine workspace destinations.
  const sidebar = page.locator('aside[data-shell="sidebar"]');
  await expect(sidebar).toBeVisible();
  for (const label of [
    'Dashboard',
    'Catalog',
    'Contracts',
    'Templates',
    'Ownership Ledger',
    'Vault',
    'Pricing',
    'Settings',
    'Admin',
  ]) {
    await expect(sidebar.getByRole('link', { name: label })).toBeVisible();
  }

  // Every nav destination resolves — real views or declared stubs.
  for (const route of [
    '/dashboard',
    '/catalog',
    '/contracts',
    '/templates',
    '/ledger',
    '/vault',
    '/pricing',
    '/settings',
    '/admin',
  ]) {
    const res = await request.get(route);
    expect(res.status(), `route ${route}`).toBe(200);
  }
});
