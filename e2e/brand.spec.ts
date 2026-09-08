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

  // The Stage Name zone closes with its own golden ruler, which doubles as
  // the shared top rule of the mirrored Legal Name zone beneath it
  // (micro-edit 9), whose own bottom ruler doubles as the shared top rule of
  // the mirrored Email zone (micro-edit 10): hero threshold, URD close,
  // shared rule, Legal Name bottom ruler, Email bottom ruler — FIVE golden
  // rulers total.
  await expect(page.locator('.gold-rule')).toHaveCount(5);

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

  // The golden ruler directly below the input remains the Stage Name zone's
  // bottom line: it is the input's immediate next sibling, and it now doubles
  // as the shared top rule of the Legal Name zone that opens directly beneath
  // it — byte-identical ruler, same approved y. Three golden rulers follow
  // the statement: the Stage Name bottom line, the Legal Name bottom ruler,
  // and the Email bottom ruler.
  const bottomLine = statement.locator('xpath=following-sibling::div[contains(@class, "gold-rule")]');
  await expect(bottomLine).toHaveCount(3);
  const sharedRule = input.locator('xpath=following-sibling::*[1][contains(@class, "gold-rule")]');
  await expect(sharedRule).toHaveCount(1);
  await expect(sharedRule.locator('xpath=following-sibling::*[1]')).toHaveText('Legal Name');

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

  // Typing renders the name exactly like the hero subtitle treatment —
  // "The Immutable Truth Engine" (text-lg text-emerald-300, default font, no
  // uppercase, normal letter-spacing): the name displays as the artist types
  // it, matched field-by-field against the subtitle's computed styles.
  await input.fill('Test Artist');
  await expect(input).toHaveValue('Test Artist');
  const subtitle = page.locator('p', { hasText: 'The Immutable Truth Engine' });
  const subtitleStyles = await subtitle.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      fontSize: s.fontSize,
      color: s.color,
      textTransform: s.textTransform,
      letterSpacing: s.letterSpacing,
      fontFamily: s.fontFamily,
    };
  });
  const typedStyles = await input.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      fontSize: s.fontSize,
      color: s.color,
      textTransform: s.textTransform,
      letterSpacing: s.letterSpacing,
      fontFamily: s.fontFamily,
      caretColor: s.caretColor,
    };
  });
  // Not the old champagne treatment; color serialization varies by browser
  // (Tailwind v4 emerald is lab-space), so pin the subtitle match instead of
  // a literal rgb string.
  expect(typedStyles.color).not.toBe('rgb(243, 229, 171)');
  expect(typedStyles.fontSize).toBe('18px');
  expect(typedStyles.textTransform).toBe('none');
  expect(typedStyles.color).toBe(subtitleStyles.color);
  expect(typedStyles.fontSize).toBe(subtitleStyles.fontSize);
  expect(typedStyles.letterSpacing).toBe(subtitleStyles.letterSpacing);
  expect(typedStyles.fontFamily).toBe(subtitleStyles.fontFamily);
  // The caret stays gold — distinct from the jade text color.
  expect(typedStyles.caretColor).not.toBe(typedStyles.color);
});

test('the mirrored Legal Name zone repeats the Stage Name treatment: identical statement, chromeless jade type-in, and an input-hugging bottom ruler with nothing beneath it', async ({
  page,
}) => {
  await page.goto('/');

  // Five golden rulers: hero threshold, URD close, shared Stage Name bottom
  // rule, the Legal Name bottom ruler, and the Email bottom ruler.
  await expect(page.locator('.gold-rule')).toHaveCount(5);

  // Statement repeats the Stage Name statement's treatment EXACTLY — the
  // source class string and every computed style match field-for-field.
  const stageStatement = page.locator('p', { hasText: 'Stage Name' });
  await expect(stageStatement).toHaveText('Stage Name');
  const legalStatement = page.locator('p', { hasText: 'Legal Name' });
  await expect(legalStatement).toHaveText('Legal Name');
  expect(await legalStatement.getAttribute('class')).toBe(await stageStatement.getAttribute('class'));

  // Placement: the Legal Name zone opens DIRECTLY below the shared rule with
  // the same 32px statement gap the Stage Name statement uses below its top
  // rule; the input fills the h-10 slot below the statement and the bottom
  // ruler HUGS the input exactly as the Stage Name zone's ruler hugs its own
  // — interior 32 + 20 + 40 = 92px, a true pixel mirror of the Stage Name
  // zone, all centered on the zone axis.
  const geometry = await page.evaluate(() => {
    const rules = [...document.querySelectorAll('.gold-rule')].map((r) => r.getBoundingClientRect());
    const statement = [...document.querySelectorAll('p.font-mono')]
      .find((p) => p.textContent?.includes('Legal Name'))!
      .getBoundingClientRect();
    const input = document.querySelector('input[aria-label="Legal Name"]')!.getBoundingClientRect();
    return {
      sharedRuleBottom: rules[2].bottom,
      statementGap: statement.top - rules[2].bottom,
      statementHeight: statement.height,
      inputHeight: input.height,
      inputTop: input.top,
      inputBottom: input.bottom,
      statementBottom: statement.bottom,
      rulerTop: rules[3].top,
      rulerGap: rules[3].top - input.bottom,
      bandInterior: rules[3].top - rules[2].bottom,
      ruleCenter: rules[2].left + rules[2].width / 2,
      inputCenter: input.left + input.width / 2,
    };
  });
  expect(geometry.statementGap).toBeCloseTo(32, 0);
  expect(geometry.statementHeight).toBeCloseTo(20, 0);
  expect(geometry.inputHeight).toBeCloseTo(40, 0);
  expect(geometry.inputTop).toBeGreaterThanOrEqual(geometry.statementBottom - 0.5);
  expect(geometry.rulerGap).toBeCloseTo(0, 0);
  expect(geometry.bandInterior).toBeCloseTo(92, 0);
  expect(Math.abs(geometry.inputCenter - geometry.ruleCenter)).toBeLessThan(1);

  // Fully invisible field, byte-identical to the Stage Name input: same class
  // string, transparent and borderless in EVERY state — only the typed name
  // and the gold caret ever appear.
  const stageInput = page.getByRole('textbox', { name: 'Stage Name' });
  const legalInput = page.getByRole('textbox', { name: 'Legal Name' });
  await expect(legalInput).toBeVisible();
  expect(await legalInput.getAttribute('placeholder')).toBeNull();
  expect(await legalInput.getAttribute('class')).toBe(await stageInput.getAttribute('class'));

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
  const atRest = await legalInput.evaluate(chromeOf);
  expect(atRest.background).toBe('rgba(0, 0, 0, 0)');
  expect(atRest.borderTopWidth).toBe('0px');
  expect(atRest.borderRightWidth).toBe('0px');
  expect(atRest.borderBottomWidth).toBe('0px');
  expect(atRest.borderLeftWidth).toBe('0px');
  expect(atRest.outlineStyle).toBe('none');
  expect(atRest.boxShadow).toBe('none');
  expect(atRest.cursor).toBe('text');

  // On focus: still no lines, no glow — every state chromeless.
  await legalInput.focus();
  const onFocus = await legalInput.evaluate(chromeOf);
  expect(onFocus.background).toBe('rgba(0, 0, 0, 0)');
  expect(onFocus.borderTopWidth).toBe('0px');
  expect(onFocus.borderRightWidth).toBe('0px');
  expect(onFocus.borderBottomWidth).toBe('0px');
  expect(onFocus.borderLeftWidth).toBe('0px');
  expect(onFocus.outlineStyle).toBe('none');
  expect(onFocus.boxShadow).toBe('none');

  // The Legal Name bottom ruler now doubles as the shared top rule of the
  // Email zone that opens directly beneath it (micro-edit 10) — the same
  // byte-identical ruler, same approved y. The Email zone's own bottom ruler
  // is the section's last element: NOTHING follows it in the section — no
  // elements, no spacing blocks, no further structure. And no entry inputs
  // leak into the reserved region below.
  const sharedTopRule = legalInput.locator('xpath=following-sibling::*[1][contains(@class, "gold-rule")]');
  await expect(sharedTopRule).toHaveCount(1);
  await expect(sharedTopRule.locator('xpath=following-sibling::*[1]')).toHaveText('Email');
  const finalRuler = page.locator('.gold-rule').nth(4);
  await expect(finalRuler.locator('xpath=following-sibling::*')).toHaveCount(0);
  await expect(page.locator('section[class*="min-h-[300px]"]').locator('input')).toHaveCount(0);

  // Typing renders the name with the same jade typed treatment as the Stage
  // Name field — matched field-for-field against the hero subtitle; the
  // caret stays gold.
  await legalInput.fill('Test Holder');
  await expect(legalInput).toHaveValue('Test Holder');
  const subtitle = page.locator('p', { hasText: 'The Immutable Truth Engine' });
  const subtitleStyles = await subtitle.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      fontSize: s.fontSize,
      color: s.color,
      textTransform: s.textTransform,
      letterSpacing: s.letterSpacing,
      fontFamily: s.fontFamily,
    };
  });
  const typedStyles = await legalInput.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      fontSize: s.fontSize,
      color: s.color,
      textTransform: s.textTransform,
      letterSpacing: s.letterSpacing,
      fontFamily: s.fontFamily,
      caretColor: s.caretColor,
    };
  });
  expect(typedStyles.color).not.toBe('rgb(243, 229, 171)');
  expect(typedStyles.fontSize).toBe('18px');
  expect(typedStyles.textTransform).toBe('none');
  expect(typedStyles.color).toBe(subtitleStyles.color);
  expect(typedStyles.fontSize).toBe(subtitleStyles.fontSize);
  expect(typedStyles.letterSpacing).toBe(subtitleStyles.letterSpacing);
  expect(typedStyles.fontFamily).toBe(subtitleStyles.fontFamily);
  expect(typedStyles.caretColor).not.toBe(typedStyles.color);
});

test('the mirrored Email zone repeats the Legal Name treatment: identical statement, chromeless jade type-in, and an input-hugging bottom ruler with nothing beneath it', async ({
  page,
}) => {
  await page.goto('/');

  // Five golden rulers: hero threshold, URD close, shared Stage Name bottom
  // rule, the Legal Name bottom ruler, and the Email bottom ruler.
  await expect(page.locator('.gold-rule')).toHaveCount(5);

  // Statement repeats the Stage Name statement's treatment EXACTLY — the
  // source class string and every computed style match field-for-field.
  const stageStatement = page.locator('p', { hasText: 'Stage Name' });
  await expect(stageStatement).toHaveText('Stage Name');
  const emailStatement = page.locator('p', { hasText: 'Email' });
  await expect(emailStatement).toHaveText('Email');
  expect(await emailStatement.getAttribute('class')).toBe(await stageStatement.getAttribute('class'));

  // Placement: the Email zone opens DIRECTLY below the shared rule with the
  // same 32px statement gap the other statements use below their top rule;
  // the input fills the h-10 slot below the statement and the bottom ruler
  // HUGS the input exactly as the Legal Name zone's ruler hugs its own —
  // interior 32 + 20 + 40 = 92px, a true pixel mirror of the Legal Name
  // zone, all centered on the zone axis.
  const geometry = await page.evaluate(() => {
    const rules = [...document.querySelectorAll('.gold-rule')].map((r) => r.getBoundingClientRect());
    const statement = [...document.querySelectorAll('p.font-mono')]
      .find((p) => p.textContent?.includes('Email'))!
      .getBoundingClientRect();
    const input = document.querySelector('input[aria-label="Email"]')!.getBoundingClientRect();
    return {
      sharedRuleBottom: rules[3].bottom,
      statementGap: statement.top - rules[3].bottom,
      statementHeight: statement.height,
      inputHeight: input.height,
      inputTop: input.top,
      inputBottom: input.bottom,
      statementBottom: statement.bottom,
      rulerTop: rules[4].top,
      rulerGap: rules[4].top - input.bottom,
      bandInterior: rules[4].top - rules[3].bottom,
      ruleCenter: rules[3].left + rules[3].width / 2,
      inputCenter: input.left + input.width / 2,
    };
  });
  expect(geometry.statementGap).toBeCloseTo(32, 0);
  expect(geometry.statementHeight).toBeCloseTo(20, 0);
  expect(geometry.inputHeight).toBeCloseTo(40, 0);
  expect(geometry.inputTop).toBeGreaterThanOrEqual(geometry.statementBottom - 0.5);
  expect(geometry.rulerGap).toBeCloseTo(0, 0);
  expect(geometry.bandInterior).toBeCloseTo(92, 0);
  expect(Math.abs(geometry.inputCenter - geometry.ruleCenter)).toBeLessThan(1);

  // Fully invisible field, byte-identical to the Stage Name input: same class
  // string, transparent and borderless in EVERY state — only the typed email
  // and the gold caret ever appear. Local-only: no validation, no submission
  // wiring.
  const stageInput = page.getByRole('textbox', { name: 'Stage Name' });
  const emailInput = page.getByRole('textbox', { name: 'Email' });
  await expect(emailInput).toBeVisible();
  expect(await emailInput.getAttribute('placeholder')).toBeNull();
  expect(await emailInput.getAttribute('class')).toBe(await stageInput.getAttribute('class'));

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
  const atRest = await emailInput.evaluate(chromeOf);
  expect(atRest.background).toBe('rgba(0, 0, 0, 0)');
  expect(atRest.borderTopWidth).toBe('0px');
  expect(atRest.borderRightWidth).toBe('0px');
  expect(atRest.borderBottomWidth).toBe('0px');
  expect(atRest.borderLeftWidth).toBe('0px');
  expect(atRest.outlineStyle).toBe('none');
  expect(atRest.boxShadow).toBe('none');
  expect(atRest.cursor).toBe('text');

  // On focus: still no lines, no glow — every state chromeless.
  await emailInput.focus();
  const onFocus = await emailInput.evaluate(chromeOf);
  expect(onFocus.background).toBe('rgba(0, 0, 0, 0)');
  expect(onFocus.borderTopWidth).toBe('0px');
  expect(onFocus.borderRightWidth).toBe('0px');
  expect(onFocus.borderBottomWidth).toBe('0px');
  expect(onFocus.borderLeftWidth).toBe('0px');
  expect(onFocus.outlineStyle).toBe('none');
  expect(onFocus.boxShadow).toBe('none');

  // The Email bottom ruler is the zone's last element: NOTHING follows it in
  // the section — no elements, no spacing blocks, no further structure. And
  // no entry inputs leak into the reserved region below.
  const newRuler = page.locator('.gold-rule').nth(4);
  await expect(newRuler.locator('xpath=following-sibling::*')).toHaveCount(0);
  await expect(page.locator('section[class*="min-h-[300px]"]').locator('input')).toHaveCount(0);

  // Typing renders with the same jade typed treatment as the other fields —
  // matched field-for-field against the hero subtitle; the caret stays gold.
  await emailInput.fill('artist@example.com');
  await expect(emailInput).toHaveValue('artist@example.com');
  const subtitle = page.locator('p', { hasText: 'The Immutable Truth Engine' });
  const subtitleStyles = await subtitle.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      fontSize: s.fontSize,
      color: s.color,
      textTransform: s.textTransform,
      letterSpacing: s.letterSpacing,
      fontFamily: s.fontFamily,
    };
  });
  const typedStyles = await emailInput.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      fontSize: s.fontSize,
      color: s.color,
      textTransform: s.textTransform,
      letterSpacing: s.letterSpacing,
      fontFamily: s.fontFamily,
      caretColor: s.caretColor,
    };
  });
  expect(typedStyles.color).not.toBe('rgb(243, 229, 171)');
  expect(typedStyles.fontSize).toBe('18px');
  expect(typedStyles.textTransform).toBe('none');
  expect(typedStyles.color).toBe(subtitleStyles.color);
  expect(typedStyles.fontSize).toBe(subtitleStyles.fontSize);
  expect(typedStyles.letterSpacing).toBe(subtitleStyles.letterSpacing);
  expect(typedStyles.fontFamily).toBe(subtitleStyles.fontFamily);
  expect(typedStyles.caretColor).not.toBe(typedStyles.color);
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
