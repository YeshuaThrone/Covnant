import { expect, test } from '@playwright/test';

/**
 * Spec §07 — Multi-pool save gate and identifier pills.
 *
 * Serial: the asset registered here is the fixture for the vault flow test.
 */

const POOLS = ['Master Recording', 'Writer / Composition', 'Publisher Administration'];
const BANK_FIELDS: Array<[string, string]> = [
  ['Bank name', 'E2E Bank'],
  ['Account number or IBAN', 'E2E-0001'],
  ['Routing number or BIC', '000000001'],
];

function poolSection(page: import('@playwright/test').Page, label: string) {
  return page.locator('section.glass-card', { has: page.locator('h3', { hasText: label }) });
}

async function completePool(
  page: import('@playwright/test').Page,
  label: string,
  holder: string,
) {
  const section = poolSection(page, label);
  await section.locator('input[placeholder="Rights holder"]').fill(holder);
  await section.locator('input[type="number"]').fill('100');
  for (const [placeholder, value] of BANK_FIELDS) {
    await section.locator(`input[placeholder="${placeholder}"]`).fill(value);
  }
}

test.describe.serial('multi-pool gate and identifier pills', () => {
  let cbtCode = '';

  test('Save enables exactly when all three pools read 100.0000%, then registers the asset', async ({
    page,
  }) => {
    await page.goto('/assets/new');

    await page.locator('input[placeholder="Song, film, episode, book…"]').fill('E2E Pool Gate Song');
    await page.locator('input[placeholder="US-XXX-26-00001"]').fill('US-S1M-26-77777');
    await page.locator('input[placeholder="T-000.000.000-0"]').fill('T-900.266.233-7');
    await page.locator('input[placeholder="10.5240/…"]').fill('10.5240/0000-7777');

    const save = page.getByRole('button', { name: /Register asset/ });
    await expect(save).toBeDisabled();

    // Pool 1 alone: still gated.
    await completePool(page, POOLS[0], 'Alice E2E');
    await expect(save).toBeDisabled();

    // Pool 2: still gated.
    await completePool(page, POOLS[1], 'Bob E2E');
    await expect(save).toBeDisabled();

    // Per-pool chips read the running totals.
    await expect(poolSection(page, POOLS[0]).locator('span.font-mono')).toHaveText(/100\.0000%/);

    // Pool 3 completes the gate: now, and only now, Save enables.
    await completePool(page, POOLS[2], 'Cara E2E');
    await expect(save).toBeEnabled();

    await save.click();
    await page.waitForURL(/\/assets\/CBT-/);

    cbtCode = new URL(page.url()).pathname.split('/').pop() ?? '';
    expect(cbtCode).toMatch(/^CBT-/);
  });

  test('asset detail renders the CBT/CVT/ISRC/ISWC/EIDR identifier pills', async ({ page }) => {
    await page.goto(`/assets/${cbtCode}`);

    // Pills: label + mono value pairs rendered by IdentifierBadge.
    await expect(page.getByText('US-S1M-26-77777')).toBeVisible();
    await expect(page.getByText('T-900.266.233-7')).toBeVisible();
    await expect(page.getByText('10.5240/0000-7777')).toBeVisible();
    // CVT display code: CVT-TRK for music tracks.
    await expect(page.getByText(/^CVT-/)).toHaveCount(1);
  });
});
