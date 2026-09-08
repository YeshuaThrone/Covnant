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

test('the COMPANY ID statement fills the former reserved black-space region: capability-card panel, sans gold header, two interior rules, frozen copy, and the twelfth golden ruler', async ({
  page,
}) => {
  await page.goto('/');

  // ONE glass panel page-wide, recovered verbatim from the removed
  // capability cards (133ec05): glass-card p-6 flex flex-col gap-3,
  // holding the centered max-w-3xl column.
  const panel = page.locator('.glass-card');
  await expect(panel).toHaveCount(1);
  const panelClass = (await panel.getAttribute('class')) ?? '';
  for (const token of ['glass-card', 'p-6', 'flex', 'flex-col', 'gap-3', 'max-w-3xl', 'text-center']) {
    expect(panelClass).toContain(token);
  }

  // Header in the cards' exact title voice (text-lg font-semibold
  // text-gold, Title Case) — the mono statement treatment is gone: no
  // font-mono, no tracking-[0.3em], no uppercase, no champagne.
  const header = panel.locator('h2');
  await expect(header).toHaveCount(1);
  await expect(header).toHaveText('Company ID');
  const headerClass = (await header.getAttribute('class')) ?? '';
  for (const token of ['text-lg', 'font-semibold', 'text-gold']) {
    expect(headerClass).toContain(token);
  }
  for (const token of ['font-mono', 'tracking-[0.3em]', 'uppercase', 'text-gold-champagne']) {
    expect(headerClass).not.toContain(token);
  }

  // Three paragraphs keep the exact hero-headline gradient sweep (static
  // — no animation), now inside the panel.
  const paragraphs = panel.locator('p.bg-gradient-to-r');
  await expect(paragraphs).toHaveCount(3);
  const paragraphTokens = [
    'from-gold-champagne',
    'via-emerald-200',
    'to-gold',
    'bg-clip-text',
    'text-transparent',
    'font-bold',
    'tracking-tight',
  ];
  for (const paragraphClass of await paragraphs.evaluateAll((els) => els.map((el) => el.getAttribute('class') ?? ''))) {
    for (const token of paragraphTokens) {
      expect(paragraphClass).toContain(token);
    }
  }

  // The user's copy is frozen and renders exactly once in the DOM —
  // no copyediting, exact punctuation.
  await expect(page.getByText('autonomous clearinghouse built with Integrity')).toHaveCount(1);
  await expect(page.getByText('in house clearing framework protocol')).toHaveCount(1);
  await expect(page.getByText('Own Your Creation!')).toHaveCount(1);
  await expect(page.getByText('etc., every, any & all global enterprises')).toHaveCount(1);

  // TWO interior gold rules separate the paragraphs inside the panel
  // (same grammar as every other rule, centered), and the section's
  // closing rule stays after the panel — the composition's twelfth, which
  // doubles as the ENTERPRISE DIRECT zone's top ruler (micro-edit 13).
  const interiorRules = panel.locator('div.gold-rule');
  await expect(interiorRules).toHaveCount(2);
  for (const ruleClass of await interiorRules.evaluateAll((els) => els.map((el) => el.getAttribute('class') ?? ''))) {
    for (const token of ['gold-rule', 'w-64', 'mx-auto']) {
      expect(ruleClass).toContain(token);
    }
  }
  const section = page.locator('section[class*="min-h-[300px]"]');
  const closerRules = section.locator('xpath=./div[contains(@class, "gold-rule")]');
  await expect(closerRules).toHaveCount(1);
  // Page-wide the composition counts FOURTEEN golden rulers: the closer
  // stays the twelfth; the ENTERPRISE DIRECT top ruler (amendment 13.1) is
  // the thirteenth and the bottom ruler is the fourteenth.
  await expect(page.locator('.gold-rule')).toHaveCount(14);
  await expect(section.locator('input')).toHaveCount(0);
});

test("the ENTERPRISE DIRECT zone closes the page beneath the Company ID section: one champagne mono statement flanked by the composition's twin final rulers (amendment 13.1)", async ({
  page,
}) => {
  await page.goto('/');

  // The user's own digits render exactly once, case-insensitive on the
  // rendered page — the uppercase class lifts the Title Case literal into
  // the ENTERPRISE DIRECT statement voice.
  const statement = page.getByText(/enterprise direct: 830-358-2306/i);
  await expect(statement).toHaveCount(1);

  // Canonical champagne mono zone treatment — the statement's class string
  // is BYTE-IDENTICAL to the Universal Royalty Distribution statement's.
  const urdStatement = page.locator('p', { hasText: 'Universal Royalty Distribution' });
  await expect(urdStatement).toHaveText('Universal Royalty Distribution');
  expect(await statement.getAttribute('class')).toBe(await urdStatement.getAttribute('class'));
  const statementClass = (await statement.getAttribute('class')) ?? '';
  for (const token of ['mt-8', 'font-mono', 'text-sm', 'uppercase', 'tracking-[0.3em]', 'text-gold-champagne']) {
    expect(statementClass).toContain(token);
  }

  // The zone is its OWN section directly before the footer. Amendment
  // 13.1 gives the zone its OWN top golden ruler as the section's FIRST
  // element — mirroring the URD zone grammar (rule → statement → rule) —
  // so the statement is flanked by twin w-64 rulers: the section holds
  // exactly TWO gold rules. The top ruler repeats the same class/width as
  // the URD zone's rulers. Display statement only: no input, no glass
  // card, no tel: link.
  const zone = statement.locator('xpath=ancestor::section[1]');
  const firstChild = zone.locator('xpath=./*[1]');
  expect(await firstChild.getAttribute('class')).toBe('gold-rule w-64');
  const zoneRules = zone.locator('div.gold-rule');
  await expect(zoneRules).toHaveCount(2);
  await expect(zone.locator('input, .glass-card, a[href^="tel:"]')).toHaveCount(0);

  // The top ruler sits IMMEDIATELY above the statement — the URD zone's
  // grammar: rule → mt-8 statement → rule. The bottom ruler repeats the
  // URD zone's mt-10 rhythm below the statement and is the composition's
  // FOURTEENTH golden ruler — nothing follows it in its section, and the
  // footer is the zone's next sibling.
  const precedingRule = statement.locator('xpath=preceding-sibling::*[1][contains(@class, "gold-rule")]');
  await expect(precedingRule).toHaveCount(1);
  const topRule = zoneRules.nth(0);
  expect(await topRule.getAttribute('class')).toBe('gold-rule w-64');
  const bottomRule = zoneRules.nth(1);
  const bottomRuleClass = (await bottomRule.getAttribute('class')) ?? '';
  for (const token of ['gold-rule', 'mt-10', 'w-64']) {
    expect(bottomRuleClass).toContain(token);
  }
  await expect(page.locator('.gold-rule')).toHaveCount(14);
  await expect(bottomRule.locator('xpath=following-sibling::*')).toHaveCount(0);
  const zoneIsLastSection = await page.evaluate(() => {
    const sections = document.querySelectorAll('main > section');
    const enterpriseZone = [...sections].find((s) => /enterprise direct: 830-358-2306/i.test(s.textContent ?? ''));
    return !!enterpriseZone && enterpriseZone.nextElementSibling?.tagName === 'FOOTER';
  });
  expect(zoneIsLastSection).toBe(true);
});

test('the open black space beneath the URD zone carries the STAGE NAME statement and a fully invisible type-in field', async ({
  page,
}) => {
  await page.goto('/');

  // The Stage Name zone closes with its own golden ruler, which doubles as
  // the shared top rule of the mirrored Legal Name zone beneath it
  // (micro-edit 9), whose own bottom ruler doubles as the shared top rule of
  // the mirrored Email zone (micro-edit 10), whose own bottom ruler doubles
  // as the shared top rule of the mirrored Phone Number zone (amendment
  // 11.2), whose own bottom ruler doubles as the shared top rule of the
  // mirrored Core Industry & Title zone (micro-edit 10), whose own bottom
  // ruler doubles as the shared top rule of the mirrored Password zone
  // (micro-edit 11 move), whose own bottom ruler opens the final Consent &
  // Seal zone, whose own bottom ruler the COMPANY ID statement (micro-edit
  // 12) closes with the composition's final golden ruler: hero threshold,
  // URD close, shared rule, Legal Name bottom ruler, Email bottom ruler,
  // Phone Number bottom ruler, Core Industry & Title bottom ruler, Password
  // bottom ruler, Agreement bottom ruler, Company ID closing ruler, plus
  // the TWO interior paragraph rules inside the Company ID panel
  // (amendments 12.1–12.3), and the ENTERPRISE DIRECT twin rulers — top
  // (amendment 13.1) and bottom (micro-edit 13) — FOURTEEN golden rulers
  // total.
  await expect(page.locator('.gold-rule')).toHaveCount(14);

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
  // it — byte-identical ruler, same approved y. Seven golden rulers follow
  // the statement: the Stage Name bottom line, the Legal Name bottom ruler,
  // the Email bottom ruler, the Phone Number bottom ruler, the Password
  // bottom ruler, the Core Industry & Title bottom ruler, and the Agreement
  // bottom ruler.
  const bottomLine = statement.locator('xpath=following-sibling::div[contains(@class, "gold-rule")]');
  await expect(bottomLine).toHaveCount(7);
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

  // Thirteen golden rulers: hero threshold, URD close, shared Stage Name
  // bottom rule, the Legal Name bottom ruler, the Email bottom ruler, the
  // Phone Number bottom ruler (amendment 11.2), the Core Industry & Title
  // bottom ruler, the Password bottom ruler, the Agreement bottom ruler,
  // the Company ID closing ruler (micro-edit 12), and the ENTERPRISE
  // DIRECT twin rulers — top (amendment 13.1) and bottom (micro-edit 13) —
  // plus the TWO interior paragraph rules inside the Company ID panel.
  await expect(page.locator('.gold-rule')).toHaveCount(14);

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
  // byte-identical ruler, same approved y. The composition's last element
  // is the ENTERPRISE DIRECT zone's bottom golden ruler (micro-edit 13,
  // fourteenth overall): NOTHING follows it in its section — no elements,
  // no spacing blocks, no further structure. The COMPANY ID closing ruler
  // (micro-edit 12) remains the last element of its OWN section — the
  // ENTERPRISE DIRECT zone is a sibling section, not an append inside it.
  // And no entry inputs leak into that section below.
  const sharedTopRule = legalInput.locator('xpath=following-sibling::*[1][contains(@class, "gold-rule")]');
  await expect(sharedTopRule).toHaveCount(1);
  await expect(sharedTopRule.locator('xpath=following-sibling::*[1]')).toHaveText('Email');
  const companyCloser = page.locator('.gold-rule').nth(11);
  await expect(companyCloser.locator('xpath=following-sibling::*')).toHaveCount(0);
  const finalRuler = page.locator('.gold-rule').nth(13);
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

  // Thirteen golden rulers: hero threshold, URD close, shared Stage Name
  // bottom rule, the Legal Name bottom ruler, the Email bottom ruler, the
  // Phone Number bottom ruler (amendment 11.2), the Core Industry & Title
  // bottom ruler, the Password bottom ruler, the Agreement bottom ruler,
  // the Company ID closing ruler (micro-edit 12), and the ENTERPRISE
  // DIRECT twin rulers — top (amendment 13.1) and bottom (micro-edit 13) —
  // plus the TWO interior paragraph rules inside the Company ID panel.
  await expect(page.locator('.gold-rule')).toHaveCount(14);

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

  // The Email bottom ruler now doubles as the shared top rule of the Phone
  // Number zone that opens directly beneath it (amendment 11.2) — the same
  // byte-identical ruler, same approved y. And no entry
  // inputs leak into the reserved region below.
  const sharedTopRule = emailInput.locator('xpath=following-sibling::*[1][contains(@class, "gold-rule")]');
  await expect(sharedTopRule).toHaveCount(1);
  await expect(sharedTopRule.locator('xpath=following-sibling::*[1]')).toHaveText('Phone Number');
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

test('the mirrored Phone Number zone sits UNDER the Email zone (amendment 11.2): identical statement, empty chromeless jade type-in, and an input-hugging bottom ruler', async ({
  page,
}) => {
  await page.goto('/');

  // Fourteen golden rulers — the Phone Number bottom ruler inserts between
  // the Email and Core Industry & Title rulers (amendment 11.2), and the
  // ENTERPRISE DIRECT twin rulers (top: amendment 13.1; bottom: micro-edit
  // 13) close the page, plus the TWO interior paragraph rules inside the
  // Company ID panel.
  await expect(page.locator('.gold-rule')).toHaveCount(14);

  // Statement repeats the Stage Name statement's treatment EXACTLY — the
  // source class string matches field-for-field.
  const stageStatement = page.locator('p', { hasText: 'Stage Name' });
  await expect(stageStatement).toHaveText('Stage Name');
  const phoneStatement = page.locator('p', { hasText: 'Phone Number' });
  await expect(phoneStatement).toHaveText('Phone Number');
  expect(await phoneStatement.getAttribute('class')).toBe(await stageStatement.getAttribute('class'));

  // Placement (amendment 11.2): the Phone Number zone opens DIRECTLY below
  // the shared rule (the Email bottom ruler) with the same 32px statement
  // gap; interior 32 + 20 + 40 = 92px, a true pixel mirror of the Email
  // zone, all centered on the zone axis.
  const geometry = await page.evaluate(() => {
    const rules = [...document.querySelectorAll('.gold-rule')].map((r) => r.getBoundingClientRect());
    const statement = [...document.querySelectorAll('p.font-mono')]
      .find((p) => p.textContent?.trim() === 'Phone Number')!
      .getBoundingClientRect();
    const input = document.querySelector('input[aria-label="Phone Number"]')!.getBoundingClientRect();
    return {
      statementGap: statement.top - rules[4].bottom,
      statementHeight: statement.height,
      inputHeight: input.height,
      rulerGap: rules[5].top - input.bottom,
      bandInterior: rules[5].top - rules[4].bottom,
      ruleCenter: rules[4].left + rules[4].width / 2,
      inputCenter: input.left + input.width / 2,
    };
  });
  expect(geometry.statementGap).toBeCloseTo(32, 0);
  expect(geometry.statementHeight).toBeCloseTo(20, 0);
  expect(geometry.inputHeight).toBeCloseTo(40, 0);
  expect(geometry.rulerGap).toBeCloseTo(0, 0);
  expect(geometry.bandInterior).toBeCloseTo(92, 0);
  expect(Math.abs(geometry.inputCenter - geometry.ruleCenter)).toBeLessThan(1);

  // Column order (amendment 11.2): the six entries collect top-to-bottom as
  // Stage Name → Legal Name → Email → Phone Number → Core Industry & Title
  // → Password.
  const tops = await page.evaluate(() =>
    ['Stage Name', 'Legal Name', 'Email', 'Phone Number', 'Core Industry & Title', 'Password'].map(
      (label) => document.querySelector(`input[aria-label="${label}"]`)!.getBoundingClientRect().top,
    ),
  );
  for (let i = 1; i < tops.length; i++) {
    expect(tops[i]).toBeGreaterThan(tops[i - 1]);
  }

  // Fully invisible field, byte-identical to the Stage Name input, EMPTY by
  // default (no prefill — the user asked for a phone zone, not a stored
  // value): type tel for semantic correctness, editable, no placeholder,
  // local-only.
  const stageInput = page.getByRole('textbox', { name: 'Stage Name' });
  const phoneInput = page.getByRole('textbox', { name: 'Phone Number' });
  await expect(phoneInput).toBeVisible();
  await expect(phoneInput).toHaveValue('');
  expect(await phoneInput.getAttribute('type')).toBe('tel');
  expect(await phoneInput.getAttribute('placeholder')).toBeNull();
  expect(await phoneInput.getAttribute('class')).toBe(await stageInput.getAttribute('class'));

  // The Phone Number bottom ruler now opens the Core Industry & Title zone:
  // the 'Core Industry & Title' statement sits directly beneath it — same
  // byte-identical ruler, same approved y.
  const sharedTopRule = phoneInput.locator('xpath=following-sibling::*[1][contains(@class, "gold-rule")]');
  await expect(sharedTopRule).toHaveCount(1);
  await expect(sharedTopRule.locator('xpath=following-sibling::*[1]')).toHaveText('Core Industry & Title');
});

test('the mirrored Core Industry & Title zone repeats the Email treatment: identical statement, chromeless jade type-in, and an input-hugging bottom ruler with nothing beneath it', async ({
  page,
}) => {
  await page.goto('/');

  // Thirteen golden rulers: hero threshold, URD close, shared Stage Name
  // bottom rule, the Legal Name bottom ruler, the Email bottom ruler, the
  // Phone Number bottom ruler (amendment 11.2), the Core Industry & Title
  // bottom ruler, the Password bottom ruler, the Agreement bottom ruler,
  // the Company ID closing ruler (micro-edit 12), and the ENTERPRISE
  // DIRECT twin rulers — top (amendment 13.1) and bottom (micro-edit 13) —
  // plus the TWO interior paragraph rules inside the Company ID panel.
  await expect(page.locator('.gold-rule')).toHaveCount(14);

  // Statement repeats the Stage Name statement's treatment EXACTLY — the
  // source class string and every computed style match field-for-field.
  const stageStatement = page.locator('p', { hasText: 'Stage Name' });
  await expect(stageStatement).toHaveText('Stage Name');
  const industryStatement = page.locator('p', { hasText: 'Core Industry & Title' });
  await expect(industryStatement).toHaveText('Core Industry & Title');
  expect(await industryStatement.getAttribute('class')).toBe(await stageStatement.getAttribute('class'));

  // Placement: the Core Industry & Title zone opens DIRECTLY below the
  // shared rule (the Email bottom ruler) with the same 32px statement gap
  // the other statements use below their top rule; the input fills the h-10
  // slot below the statement and the bottom ruler HUGS the input exactly as
  // the Email zone's ruler hugs its own — interior 32 + 20 + 40 = 92px, a
  // true pixel mirror of the Email zone, all centered on the zone axis.
  const geometry = await page.evaluate(() => {
    const rules = [...document.querySelectorAll('.gold-rule')].map((r) => r.getBoundingClientRect());
    const statement = [...document.querySelectorAll('p.font-mono')]
      .find((p) => p.textContent?.includes('Core Industry & Title'))!
      .getBoundingClientRect();
    const input = document.querySelector('input[aria-label="Core Industry & Title"]')!.getBoundingClientRect();
    return {
      sharedRuleBottom: rules[5].bottom,
      statementGap: statement.top - rules[5].bottom,
      statementHeight: statement.height,
      inputHeight: input.height,
      statementBottom: statement.bottom,
      inputTop: input.top,
      rulerTop: rules[6].top,
      rulerGap: rules[6].top - input.bottom,
      bandInterior: rules[6].top - rules[5].bottom,
      ruleCenter: rules[5].left + rules[5].width / 2,
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
  // string, transparent and borderless in EVERY state — only the typed value
  // and the gold caret ever appear. Local-only: no validation, no submission
  // wiring.
  const stageInput = page.getByRole('textbox', { name: 'Stage Name' });
  const industryInput = page.getByRole('textbox', { name: 'Core Industry & Title' });
  await expect(industryInput).toBeVisible();
  expect(await industryInput.getAttribute('placeholder')).toBeNull();
  expect(await industryInput.getAttribute('class')).toBe(await stageInput.getAttribute('class'));

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
  const atRest = await industryInput.evaluate(chromeOf);
  expect(atRest.background).toBe('rgba(0, 0, 0, 0)');
  expect(atRest.borderTopWidth).toBe('0px');
  expect(atRest.borderRightWidth).toBe('0px');
  expect(atRest.borderBottomWidth).toBe('0px');
  expect(atRest.borderLeftWidth).toBe('0px');
  expect(atRest.outlineStyle).toBe('none');
  expect(atRest.boxShadow).toBe('none');
  expect(atRest.cursor).toBe('text');

  // On focus: still no lines, no glow — every state chromeless.
  await industryInput.focus();
  const onFocus = await industryInput.evaluate(chromeOf);
  expect(onFocus.background).toBe('rgba(0, 0, 0, 0)');
  expect(onFocus.borderTopWidth).toBe('0px');
  expect(onFocus.borderRightWidth).toBe('0px');
  expect(onFocus.borderBottomWidth).toBe('0px');
  expect(onFocus.borderLeftWidth).toBe('0px');
  expect(onFocus.outlineStyle).toBe('none');
  expect(onFocus.boxShadow).toBe('none');

  // The Core Industry & Title bottom ruler now doubles as the shared top
  // rule of the Password zone that opens directly beneath it (micro-edit 11
  // reorder) — the same byte-identical ruler, same approved y. And no entry
  // inputs leak into the reserved region below.
  const sharedTopRule = industryInput.locator('xpath=following-sibling::*[1][contains(@class, "gold-rule")]');
  await expect(sharedTopRule).toHaveCount(1);
  await expect(sharedTopRule.locator('xpath=following-sibling::*[1]')).toHaveText('Password');
  await expect(page.locator('section[class*="min-h-[300px]"]').locator('input')).toHaveCount(0);

  // Typing renders with the same jade typed treatment as the other fields —
  // matched field-for-field against the hero subtitle; the caret stays gold.
  await industryInput.fill('Music Producer');
  await expect(industryInput).toHaveValue('Music Producer');
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
  const typedStyles = await industryInput.evaluate((el) => {
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

test('the mirrored Password zone closes the entry column above the consent composition (micro-edit 11): identical statement, chromeless jade type-in pre-filled with Covenant, and an input-hugging bottom ruler', async ({
  page,
}) => {
  await page.goto('/');

  // Thirteen golden rulers: hero threshold, URD close, shared Stage Name
  // bottom rule, the Legal Name bottom ruler, the Email bottom ruler, the
  // Phone Number bottom ruler (amendment 11.2), the Core Industry & Title
  // bottom ruler, the Password bottom ruler, the Agreement bottom ruler,
  // the Company ID closing ruler (micro-edit 12), and the ENTERPRISE
  // DIRECT twin rulers — top (amendment 13.1) and bottom (micro-edit 13) —
  // plus the TWO interior paragraph rules inside the Company ID panel.
  await expect(page.locator('.gold-rule')).toHaveCount(14);

  // Statement repeats the Stage Name statement's treatment EXACTLY — the
  // source class string and every computed style match field-for-field.
  const stageStatement = page.locator('p', { hasText: 'Stage Name' });
  await expect(stageStatement).toHaveText('Stage Name');
  const passwordStatement = page.locator('p', { hasText: 'Password' });
  await expect(passwordStatement).toHaveText('Password');
  expect(await passwordStatement.getAttribute('class')).toBe(await stageStatement.getAttribute('class'));

  // Placement (micro-edit 11): the Password zone opens DIRECTLY below the
  // shared rule (the Core Industry & Title bottom ruler) with the same 32px
  // statement gap; interior 32 + 20 + 40 = 92px, a true pixel mirror of the
  // Email zone, all centered on the zone axis.
  const geometry = await page.evaluate(() => {
    const rules = [...document.querySelectorAll('.gold-rule')].map((r) => r.getBoundingClientRect());
    const statement = [...document.querySelectorAll('p.font-mono')]
      .find((p) => p.textContent?.trim() === 'Password')!
      .getBoundingClientRect();
    const input = document.querySelector('input[aria-label="Password"]')!.getBoundingClientRect();
    return {
      statementGap: statement.top - rules[6].bottom,
      statementHeight: statement.height,
      inputHeight: input.height,
      rulerGap: rules[7].top - input.bottom,
      bandInterior: rules[7].top - rules[6].bottom,
      ruleCenter: rules[6].left + rules[6].width / 2,
      inputCenter: input.left + input.width / 2,
    };
  });
  expect(geometry.statementGap).toBeCloseTo(32, 0);
  expect(geometry.statementHeight).toBeCloseTo(20, 0);
  expect(geometry.inputHeight).toBeCloseTo(40, 0);
  expect(geometry.rulerGap).toBeCloseTo(0, 0);
  expect(geometry.bandInterior).toBeCloseTo(92, 0);
  expect(Math.abs(geometry.inputCenter - geometry.ruleCenter)).toBeLessThan(1);

  // Fully invisible field, byte-identical to the Stage Name input, PRE-FILLED
  // with 'Covenant' (exactly 8 letters) as the delegated starting value:
  // type text so the jade letters show, editable, no placeholder, local-only.
  const stageInput = page.getByRole('textbox', { name: 'Stage Name' });
  const passwordInput = page.getByRole('textbox', { name: 'Password' });
  await expect(passwordInput).toBeVisible();
  await expect(passwordInput).toHaveValue('Covenant');
  expect(await passwordInput.getAttribute('type')).toBe('text');
  expect(await passwordInput.getAttribute('placeholder')).toBeNull();
  expect(await passwordInput.getAttribute('class')).toBe(await stageInput.getAttribute('class'));

  // The Password bottom ruler now opens the final Consent & Seal zone: the
  // 'Accept UDR Terms' consent label sits directly beneath it — same
  // byte-identical ruler, same approved y.
  const sharedTopRule = passwordInput.locator('xpath=following-sibling::*[1][contains(@class, "gold-rule")]');
  await expect(sharedTopRule).toHaveCount(1);
  await expect(sharedTopRule.locator('xpath=following-sibling::*[1]')).toHaveText('Accept UDR Terms');

  // The pre-filled value renders with the same jade typed treatment as the
  // other fields — matched field-for-field against the hero subtitle; the
  // caret stays gold.
  const subtitle = page.locator('p', { hasText: 'The Immutable Truth Engine' });
  const subtitleStyles = await subtitle.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, fontSize: s.fontSize, fontFamily: s.fontFamily };
  });
  const prefilledStyles = await passwordInput.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, fontSize: s.fontSize, fontFamily: s.fontFamily, caretColor: s.caretColor };
  });
  expect(prefilledStyles.color).toBe(subtitleStyles.color);
  expect(prefilledStyles.fontSize).toBe(subtitleStyles.fontSize);
  expect(prefilledStyles.fontFamily).toBe(subtitleStyles.fontFamily);
  expect(prefilledStyles.caretColor).not.toBe(prefilledStyles.color);
});

test('the final Consent & Seal zone: an Accept UDR Terms checkbox in the statement voice, a Submit button in the input slot, and a local-only seal that freezes all six entries', async ({
  page,
}) => {
  await page.goto('/');

  // Thirteen golden rulers: hero threshold, URD close, shared Stage Name
  // bottom rule, the Legal Name bottom ruler, the Email bottom ruler, the
  // Phone Number bottom ruler (amendment 11.2), the Core Industry & Title
  // bottom ruler, the Password bottom ruler, the Agreement bottom ruler,
  // the Company ID closing ruler (micro-edit 12), and the ENTERPRISE
  // DIRECT twin rulers — top (amendment 13.1) and bottom (micro-edit 13) —
  // plus the TWO interior paragraph rules inside the Company ID panel.
  await expect(page.locator('.gold-rule')).toHaveCount(14);

  // The wide agreement statement is GONE (micro-edit 11): neither the full
  // string nor any fragment of it appears anywhere on the page.
  await expect(page.locator('p', { hasText: 'I agree to the Universal' })).toHaveCount(0);
  expect(await page.content()).not.toContain('Royalty Administration');

  // The consent label repeats the Stage Name statement's treatment EXACTLY —
  // the source class string matches field-for-field (mono voice, uppercase,
  // 0.3em tracking, champagne), so it sits in the same vertical rhythm as
  // the statements it joins.
  const stageStatement = page.locator('p', { hasText: 'Stage Name' });
  await expect(stageStatement).toHaveText('Stage Name');
  const consentLabel = page.locator('label', { hasText: 'Accept UDR Terms' });
  await expect(consentLabel).toHaveText('Accept UDR Terms');
  expect(await consentLabel.getAttribute('class')).toBe(await stageStatement.getAttribute('class'));

  // The checkbox is the NATIVE box: type checkbox, unchecked by default, no
  // added border-radius or chrome, champagne accent-color.
  const consentCheckbox = page.getByRole('checkbox', { name: 'Accept UDR Terms' });
  await expect(consentCheckbox).toBeVisible();
  expect(await consentCheckbox.getAttribute('type')).toBe('checkbox');
  expect(await consentCheckbox.isChecked()).toBe(false);
  expect(await consentCheckbox.getAttribute('class')).not.toContain('rounded');
  expect(await consentCheckbox.getAttribute('class')).not.toContain('border');
  const checkboxAccent = await consentCheckbox.evaluate((el) => getComputedStyle(el).accentColor);
  expect(checkboxAccent).toBe('rgb(243, 229, 171)'); // gold-champagne #f3e5ab

  // Placement: the consent label opens DIRECTLY below the shared rule (the
  // Password bottom ruler) with the same 32px statement gap; the button
  // fills the EXACT input slot (h-10 w-64) and the bottom ruler HUGS the
  // button with zero margin, everything centered on the zone axis.
  const geometry = await page.evaluate(() => {
    const rules = [...document.querySelectorAll('.gold-rule')].map((r) => r.getBoundingClientRect());
    const label = [...document.querySelectorAll('label')]
      .find((l) => l.textContent?.trim() === 'Accept UDR Terms')!
      .getBoundingClientRect();
    const checkbox = document.querySelector('input[type="checkbox"]')!.getBoundingClientRect();
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Submit'
    )!
      .getBoundingClientRect();
    return {
      labelGap: label.top - rules[7].bottom,
      rowCenter: (checkbox.left + label.right) / 2,
      buttonHeight: button.height,
      buttonWidth: button.width,
      labelBottom: label.bottom,
      buttonTop: button.top,
      rulerGap: rules[8].top - button.bottom,
      ruleCenter: rules[7].left + rules[7].width / 2,
      buttonCenter: button.left + button.width / 2,
    };
  });
  expect(geometry.labelGap).toBeCloseTo(32, 0);
  expect(geometry.buttonHeight).toBeCloseTo(40, 0);
  expect(geometry.buttonWidth).toBeCloseTo(256, 0);
  expect(geometry.buttonTop).toBeGreaterThanOrEqual(geometry.labelBottom - 0.5);
  expect(geometry.rulerGap).toBeCloseTo(0, 0);
  expect(Math.abs(geometry.rowCenter - geometry.ruleCenter)).toBeLessThan(1);
  expect(Math.abs(geometry.buttonCenter - geometry.ruleCenter)).toBeLessThan(1);

  // Keyboard focus (Tab from the Password field) lands on the checkbox, and
  // its focus-visible gold outline matches the Submit button's pattern.
  await page.getByRole('textbox', { name: 'Password' }).focus();
  await page.keyboard.press('Tab');
  const outlineOf = (el: Element) => {
    const s = getComputedStyle(el);
    return { outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, outlineColor: s.outlineColor };
  };
  const checkboxFocus = await consentCheckbox.evaluate(outlineOf);
  expect(checkboxFocus.outlineStyle).toBe('solid');
  expect(checkboxFocus.outlineWidth).toBe('1px');
  await page.keyboard.press('Tab'); // checkbox → Submit
  // The button transitions colors (incl. outline-color) over 200ms — poll
  // until the transition settles, then require the SAME outline pattern.
  await expect(async () => {
    const buttonFocus = await page.getByRole('button', { name: 'Submit' }).evaluate(outlineOf);
    expect(buttonFocus).toEqual(checkboxFocus);
  }).toPass({ timeout: 2000 });

  // Button treatment at rest: statement-voice label, NO box — a borderless
  // pressable label (transparent background, pointer cursor) whose label
  // brightens on hover so people know to press it.
  const button = page.getByRole('button', { name: /^(Submit|SEALED)$/ });
  await expect(button).toBeVisible();
  expect(await button.getAttribute('type')).toBe('button');
  const REST_BUTTON_CLASS =
    'h-10 w-64 bg-transparent font-mono text-sm uppercase tracking-[0.3em] transition-colors duration-200 cursor-pointer text-gold-champagne/90 hover:text-gold-champagne focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold-champagne';
  expect(await button.getAttribute('class')).toBe(REST_BUTTON_CLASS);
  // ABSENCE of a border: no border class in the string, and the computed
  // box renders zero-width edges.
  expect(await button.getAttribute('class')).not.toContain('border');
  const restStyles = await button.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      borderTopWidth: s.borderTopWidth,
      background: s.backgroundColor,
      cursor: s.cursor,
      textTransform: s.textTransform,
    };
  });
  expect(restStyles.borderTopWidth).toBe('0px');
  expect(restStyles.background).toBe('rgba(0, 0, 0, 0)');
  expect(restStyles.cursor).toBe('pointer');
  expect(restStyles.textTransform).toBe('uppercase');
  const restLabelColor = await button.evaluate((el) => getComputedStyle(el).color);

  // Seal flow: type into all six entries, then click Submit. The consent
  // checkbox is deliberately left UNCHECKED — it does NOT gate the seal.
  await page.getByRole('textbox', { name: 'Stage Name' }).fill('Nova Reign');
  await page.getByRole('textbox', { name: 'Legal Name' }).fill('Nova Reign');
  await page.getByRole('textbox', { name: 'Email' }).fill('nova@example.com');
  await page.getByRole('textbox', { name: 'Phone Number' }).fill('+1 555 010 2030');
  await page.getByRole('textbox', { name: 'Password' }).fill('Nova Reign Studio');
  await page.getByRole('textbox', { name: 'Core Industry & Title' }).fill('Producer');
  await button.click();

  // All six inputs are sealed: readOnly with values kept, jade styling kept,
  // caret suppressed, cursor-default.
  const sealedEntries = [
    { label: 'Stage Name', value: 'Nova Reign' },
    { label: 'Legal Name', value: 'Nova Reign' },
    { label: 'Email', value: 'nova@example.com' },
    { label: 'Phone Number', value: '+1 555 010 2030' },
    { label: 'Password', value: 'Nova Reign Studio' },
    { label: 'Core Industry & Title', value: 'Producer' },
  ] as const;
  const SEALED_INPUT_CLASS =
    'h-10 w-64 cursor-default bg-transparent text-center text-lg text-emerald-300 caret-transparent outline-none';
  for (const entry of sealedEntries) {
    const input = page.getByRole('textbox', { name: entry.label });
    await expect(input).toHaveValue(entry.value);
    await expect(input).toHaveAttribute('readonly', '');
    expect(await input.getAttribute('class')).toBe(SEALED_INPUT_CLASS);
  }

  // The jade typed styling is kept when sealed — matched against the hero
  // subtitle.
  const subtitle = page.locator('p', { hasText: 'The Immutable Truth Engine' });
  const subtitleColor = await subtitle.evaluate((el) => getComputedStyle(el).color);
  const sealedColor = await page
    .getByRole('textbox', { name: 'Stage Name' })
    .evaluate((el) => getComputedStyle(el).color);
  expect(sealedColor).toBe(subtitleColor);

  // The six values plus the sealed flag persist locally under one key.
  const stored = await page.evaluate(() => window.localStorage.getItem('covnant.sealedEntry'));
  expect(JSON.parse(stored ?? 'null')).toEqual({
    sealed: true,
    values: {
      stageName: 'Nova Reign',
      legalName: 'Nova Reign',
      email: 'nova@example.com',
      phoneNumber: '+1 555 010 2030',
      password: 'Nova Reign Studio',
      coreIndustryTitle: 'Producer',
    },
  });

  // The checkbox persists nothing: still unchecked after sealing (it is not
  // part of the seal payload — the stored shape above carries ONLY sealed
  // plus the six values).
  await expect(consentCheckbox).not.toBeChecked();

  // The button enters the sealed state: label reads SEALED (amendment 11.1
  // — the escape must be discoverable), borderless (no box to solidify),
  // label dimmed slightly.
  await expect(button).toHaveText('SEALED');

  // The discoverability hint line sits directly beneath the sealed button:
  // statement voice, exact text, present ONLY while sealed. It lives INSIDE
  // the closing composition — the final ruler still closes the zone
  // (fourteen golden rulers, unchanged by the seal — amendment 13.1).
  const unsealHint = page.locator('p.font-mono', { hasText: 'Double-click to unseal' });
  await expect(unsealHint).toHaveText('Double-click to unseal');
  expect(await unsealHint.getAttribute('class')).toBe(
    'mt-2 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne',
  );
  await expect(page.locator('.gold-rule')).toHaveCount(14);
  const SEALED_BUTTON_CLASS =
    'h-10 w-64 bg-transparent font-mono text-sm uppercase tracking-[0.3em] transition-colors duration-200 cursor-default text-gold-champagne/50';
  expect(await button.getAttribute('class')).toBe(SEALED_BUTTON_CLASS);
  expect(await button.getAttribute('class')).not.toContain('border');
  // Label dimmed: after the 200ms color transition the sealed label differs
  // from both the rest-state /90 label and the statement's full-strength
  // gold — computed-color comparison, independent of Tailwind v4's oklab
  // format.
  await expect(async () => {
    const sealedLabelColor = await button.evaluate((el) => getComputedStyle(el).color);
    expect(sealedLabelColor).not.toBe(restLabelColor);
    const statementColor = await consentLabel.evaluate((el) => getComputedStyle(el).color);
    expect(sealedLabelColor).not.toBe(statementColor);
  }).toPass({ timeout: 2000 });

  // A refresh rehydrates the sealed composition: values restored, fields
  // still readOnly, button still sealed.
  await page.reload();
  for (const entry of sealedEntries) {
    const input = page.getByRole('textbox', { name: entry.label });
    await expect(input).toHaveValue(entry.value);
    await expect(input).toHaveAttribute('readonly', '');
    expect(await input.getAttribute('class')).toBe(SEALED_INPUT_CLASS);
  }
  await expect(button).toHaveText('SEALED');
  expect(await button.getAttribute('class')).toBe(SEALED_BUTTON_CLASS);
  await expect(consentCheckbox).not.toBeChecked();

  // A second click is a no-op: the stored state is untouched and everything
  // stays sealed.
  const storedBefore = await page.evaluate(() => window.localStorage.getItem('covnant.sealedEntry'));
  await button.click();
  const storedAfter = await page.evaluate(() => window.localStorage.getItem('covnant.sealedEntry'));
  expect(storedAfter).toBe(storedBefore);
  await expect(page.getByRole('textbox', { name: 'Stage Name' })).toHaveAttribute('readonly', '');
  await expect(button).toHaveText('SEALED');

  // The ENTERPRISE DIRECT bottom ruler (micro-edit 13, fourteenth overall
  // after amendment 13.1's top ruler) is the composition's last element:
  // NOTHING follows it in its section — no elements, no spacing blocks, no
  // further structure. The COMPANY ID closing ruler (micro-edit 12) remains
  // the last element of ITS OWN section — the ENTERPRISE DIRECT zone is a
  // sibling section, not an append inside it. And no entry inputs leak
  // into that section below.
  const companyCloser = page.locator('.gold-rule').nth(11);
  await expect(companyCloser.locator('xpath=following-sibling::*')).toHaveCount(0);
  const finalRuler = page.locator('.gold-rule').nth(13);
  await expect(finalRuler.locator('xpath=following-sibling::*')).toHaveCount(0);
  await expect(page.locator('section[class*="min-h-[300px]"]').locator('input')).toHaveCount(0);
});

test('the sealed composition UNSEALS on a double-click: fields turn editable again, the local key is cleared, and a refresh stays unsealed', async ({
  page,
}) => {
  await page.goto('/');

  // Seal first: type into all six entries, then click Submit once.
  await page.getByRole('textbox', { name: 'Stage Name' }).fill('Nova Reign');
  await page.getByRole('textbox', { name: 'Legal Name' }).fill('Nova Reign');
  await page.getByRole('textbox', { name: 'Email' }).fill('nova@example.com');
  await page.getByRole('textbox', { name: 'Phone Number' }).fill('+1 555 010 2030');
  await page.getByRole('textbox', { name: 'Password' }).fill('Nova Reign Studio');
  await page.getByRole('textbox', { name: 'Core Industry & Title' }).fill('Producer');
  await page.getByRole('button', { name: 'Submit' }).click();
  const SEALED_INPUT_CLASS =
    'h-10 w-64 cursor-default bg-transparent text-center text-lg text-emerald-300 caret-transparent outline-none';
  for (const label of ['Stage Name', 'Legal Name', 'Email', 'Phone Number', 'Password', 'Core Industry & Title']) {
    const input = page.getByRole('textbox', { name: label });
    await expect(input).toHaveAttribute('readonly', '');
    expect(await input.getAttribute('class')).toBe(SEALED_INPUT_CLASS);
  }
  const stored = await page.evaluate(() => window.localStorage.getItem('covnant.sealedEntry'));
  expect(JSON.parse(stored ?? 'null')).toMatchObject({ sealed: true });

  // The sealed button carries the discoverability tooltip ONLY while sealed,
  // reads SEALED, and shows the unseal hint line (amendment 11.1).
  const button = page.getByRole('button', { name: /^(Submit|SEALED)$/ });
  expect(await button.getAttribute('title')).toBe('Double-click to unseal');
  await expect(button).toHaveText('SEALED');
  await expect(page.locator('p.font-mono', { hasText: 'Double-click to unseal' })).toBeVisible();

  // Double-click unseals: the seal key is removed and every field turns
  // editable again with the jade unsealed styling.
  await button.dblclick();
  const UNSEALED_INPUT_CLASS =
    'h-10 w-64 cursor-text bg-transparent text-center text-lg text-emerald-300 caret-amber-400/70 outline-none';
  for (const label of ['Stage Name', 'Legal Name', 'Email', 'Phone Number', 'Password', 'Core Industry & Title']) {
    const input = page.getByRole('textbox', { name: label });
    await expect(input).not.toHaveAttribute('readonly', '');
    expect(await input.getAttribute('class')).toBe(UNSEALED_INPUT_CLASS);
  }
  expect(await page.evaluate(() => window.localStorage.getItem('covnant.sealedEntry'))).toBeNull();

  // The unseal hint line is GONE from the DOM — it exists only while sealed.
  await expect(page.locator('p.font-mono', { hasText: 'Double-click to unseal' })).toHaveCount(0);

  // The button returns to the bright pressable rest state and loses the
  // tooltip.
  const REST_BUTTON_CLASS =
    'h-10 w-64 bg-transparent font-mono text-sm uppercase tracking-[0.3em] transition-colors duration-200 cursor-pointer text-gold-champagne/90 hover:text-gold-champagne focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold-champagne';
  expect(await button.getAttribute('class')).toBe(REST_BUTTON_CLASS);
  expect(await button.getAttribute('title')).toBeNull();

  // The fields kept their values through the unseal — they are editable, not
  // wiped.
  await expect(page.getByRole('textbox', { name: 'Stage Name' })).toHaveValue('Nova Reign');

  // A refresh stays unsealed: no stored key, nothing rehydrates to readOnly.
  await page.reload();
  for (const label of ['Stage Name', 'Legal Name', 'Email', 'Phone Number', 'Password', 'Core Industry & Title']) {
    await expect(page.getByRole('textbox', { name: label })).not.toHaveAttribute('readonly', '');
  }
  expect(await page.evaluate(() => window.localStorage.getItem('covnant.sealedEntry'))).toBeNull();

  // Re-seal with a single click — and the sealed single click is STILL a
  // no-op (the regex locator resolves Submit unsealed and SEALED sealed).
  await button.click();
  await expect(page.getByRole('textbox', { name: 'Stage Name' })).toHaveAttribute('readonly', '');
  const storedBefore = await page.evaluate(() => window.localStorage.getItem('covnant.sealedEntry'));
  await button.click();
  const storedAfter = await page.evaluate(() => window.localStorage.getItem('covnant.sealedEntry'));
  expect(storedAfter).toBe(storedBefore);
  expect(await button.getAttribute('title')).toBe('Double-click to unseal');
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
