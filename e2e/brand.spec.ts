import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Spec §07 — Brand system gates: the Obsidian & Deep Gold shell, the
 * CV ribbon monogram, the no-blues rule, and sidebar route resolution.
 */

test('landing shows the CV ribbon monogram, gold gradient H1 "Own Your Creation.", and the Obsidian shell', async ({
  page,
}) => {
  await page.goto('/');

  // Landing H1 carries the tagline.
  await expect(page.locator('h1')).toHaveText(/Own Your Creation/);

  // Monogram renders in the landing top bar and again in the hero.
  const monograms = page.locator('svg[class*="monogram"], [data-monogram], svg[aria-label*="CV" i]');
  const count = await monograms.count();
  expect(count).toBeGreaterThanOrEqual(2);

  // Obsidian background token is applied to the page.
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(8, 8, 10)'); // #08080A

  // Favicon ships the monogram (defined once, referenced by the app).
  const icon = fs.readFileSync(path.join(process.cwd(), 'src/app/icon.svg'), 'utf8');
  expect(icon).toContain('CV');
});

test('the open black space beneath the URD zone carries the STAGE NAME statement and a fully invisible type-in field', async ({
  page,
}) => {
  await page.goto('/');

  // The entry area is NOT a new zone: the URD zone keeps its two rules, and
  // the entry area ends with exactly ONE golden ruler as its bottom line.
  await expect(page.locator('.gold-rule')).toHaveCount(3);

  // Statement carries the exact URD treatment.
  const statement = page.locator('p', { hasText: 'Stage Name' });
  await expect(statement).toHaveText('Stage Name');
  const statementClass = await statement.getAttribute('class');
  for (const token of [
    'font-mono',
    'text-sm',
    'uppercase',
    'tracking-[0.3em]',
    'text-gold-champagne',
  ]) {
    expect(statementClass, `statement class ${token}`).toContain(token);
  }

  // Fully invisible field: transparent, borderless in EVERY state — the only
  // things that ever become visible are the typed name and the gold caret.
  const input = page.getByRole('textbox', { name: 'Stage Name' });
  await expect(input).toBeVisible();
  expect(await input.getAttribute('placeholder')).toBeNull();

  const chromeOf = (el: Element) => {
    const s = getComputedStyle(el);
    return {
      background: s.backgroundColor,
      borderTopWidth: s.borderTopWidth,
      borderRightWidth: s.borderRightWidth,
      borderBottomWidth: s.borderBottomWidth,
      borderLeftWidth: s.borderLeftWidth,
      outlineStyle: s.outlineStyle,
      boxShadow: s.boxShadow,
      cursor: s.cursor,
    };
  };

  // At rest: no chrome at all, cursor-text for discoverability.
  const atRest = await input.evaluate(chromeOf);
  expect(atRest.background).toBe('rgba(0, 0, 0, 0)');
  expect(atRest.borderTopWidth).toBe('0px');
  expect(atRest.borderRightWidth).toBe('0px');
  expect(atRest.borderBottomWidth).toBe('0px');
  expect(atRest.borderLeftWidth).toBe('0px');
  expect(atRest.outlineStyle).toBe('none');
  expect(atRest.boxShadow).toBe('none');
  expect(atRest.cursor).toBe('text');

  // On focus: still no lines, no glow — every state chromeless.
  await input.focus();
  const onFocus = await input.evaluate(chromeOf);
  expect(onFocus.background).toBe('rgba(0, 0, 0, 0)');
  expect(onFocus.borderTopWidth).toBe('0px');
  expect(onFocus.borderRightWidth).toBe('0px');
  expect(onFocus.borderBottomWidth).toBe('0px');
  expect(onFocus.borderLeftWidth).toBe('0px');
  expect(onFocus.outlineStyle).toBe('none');
  expect(onFocus.boxShadow).toBe('none');

  // Placement: the field sits directly beneath the statement in the open black
  // space — never in the reserved region below.
  await expect(statement.locator('xpath=following-sibling::input[@aria-label="Stage Name"]')).toBeVisible();
  await expect(page.locator('section[class*="min-h-[300px]"]').locator('input')).toHaveCount(0);

  // The golden ruler directly below the input acts as the entry area's bottom
  // line: it is the input's only following sibling and NOTHING follows it in
  // the section — no elements, no spacing blocks, no further structure.
  const bottomLine = statement.locator('xpath=following-sibling::div[contains(@class, "gold-rule")]');
  await expect(bottomLine).toHaveCount(1);
  await expect(bottomLine.first().locator('xpath=following-sibling::*')).toHaveCount(0);

  // HARD ACCEPTANCE GEOMETRY: the band interior between the URD closing rule
  // and the bottom golden ruler measures EXACTLY 92px (32 + 20 + 40) — the
  // input occupies the existing 40px slot with zero net added height, fully
  // inside that slot, centered on the zone axis.
  const geometry = await page.evaluate(() => {
    const rules = [...document.querySelectorAll('.gold-rule')];
    const rule2 = rules[1].getBoundingClientRect();
    const rule3 = rules[2].getBoundingClientRect();
    const statement = [...document.querySelectorAll('p.font-mono')]
      .find((p) => p.textContent?.includes('Stage Name'))!
      .getBoundingClientRect();
    const input = document.querySelector('input[aria-label="Stage Name"]')!.getBoundingClientRect();
    return {
      bandInterior: rule3.top - rule2.bottom,
      statementGap: statement.top - rule2.bottom,
      inputHeight: input.height,
      inputTop: input.top,
      inputBottom: input.bottom,
      statementBottom: statement.bottom,
      rulerTop: rule3.top,
      ruleCenter: rule2.left + rule2.width / 2,
      inputCenter: input.left + input.width / 2,
    };
  });
  expect(geometry.bandInterior).toBeCloseTo(92, 0);
  expect(geometry.statementGap).toBeCloseTo(32, 0);
  expect(geometry.inputHeight).toBeCloseTo(40, 0);
  expect(geometry.inputTop).toBeGreaterThanOrEqual(geometry.statementBottom - 0.5);
  expect(geometry.inputBottom).toBeLessThanOrEqual(geometry.rulerTop + 0.5);
  expect(Math.abs(geometry.inputCenter - geometry.ruleCenter)).toBeLessThan(1);

  // Typing renders the name in the champagne statement treatment.
  await input.fill('Test Artist');
  await expect(input).toHaveValue('Test Artist');
  expect(await input.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(243, 229, 171)');
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
