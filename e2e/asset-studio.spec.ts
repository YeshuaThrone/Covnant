import { expect, test } from '@playwright/test';

/**
 * Directive §2 — zero-friction MUL-gated registration.
 *
 * Serial: the asset registered here ("E2E Pool Gate Song") is the fixture for
 * the contract vault flow test.
 */

const POOLS = ['Master Recording', 'Writer / Composition', 'Publisher Administration'];
const BANK_FIELDS: Array<[string, string]> = [
  ['Bank name', 'E2E Bank'],
  ['Account number or IBAN', 'E2E-0001'],
  ['Routing number or BIC', '000000001'],
];
const TITLE_INPUT = 'input[placeholder="Song, film, episode, book…"]';
const ASSET_TITLE = 'E2E Pool Gate Song';

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

/** Fill the identity + all three pools exactly as the studio requires. */
async function fillRegistrationForm(page: import('@playwright/test').Page) {
  await page.goto('/assets/new');
  await page.locator(TITLE_INPUT).fill(ASSET_TITLE);
  await completePool(page, POOLS[0], 'Alice E2E');
  await completePool(page, POOLS[1], 'Bob E2E');
  await completePool(page, POOLS[2], 'Cara E2E');
}

test.describe.serial('MUL gate, auto identifier pills, duplicate shield', () => {
  let cbtCode = '';

  test('MUL gate: no manual identifier inputs, license prompt opens before any registration', async ({
    page,
  }) => {
    await page.goto('/assets/new');

    // Zero-friction flow: the manual ISRC / ISWC / EIDR entry fields are gone.
    await expect(page.locator('input[placeholder="US-XXX-26-00001"]')).toHaveCount(0);
    await expect(page.locator('input[placeholder="T-000.000.000-0"]')).toHaveCount(0);
    await expect(page.locator('input[placeholder="10.5240/…"]')).toHaveCount(0);

    // The save gate still applies: Register stays disabled until pools are exact.
    const register = page.getByRole('button', { name: /Register asset/ });
    await expect(register).toBeDisabled();

    await fillRegistrationForm(page);
    await expect(register).toBeEnabled();
    await register.click();

    // The MUL agreement prompt is the registration gate — nothing is written yet.
    const dialog = page.getByRole('dialog', {
      name: /Master Recording & Universal Asset License/,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Accept MUL & Register Asset');
    await expect(page).toHaveURL(/\/assets\/new$/);
  });

  test('accepting MUL registers the asset and auto-provisions universal tracking pills', async ({
    page,
  }) => {
    await fillRegistrationForm(page);

    await page.getByRole('button', { name: /Register asset/ }).click();
    await page.getByRole('button', { name: /Accept MUL & Register Asset/ }).click();
    await page.waitForURL(/\/assets\/CBT-/);

    cbtCode = new URL(page.url()).pathname.split('/').pop() ?? '';
    expect(cbtCode).toMatch(/^CBT-/);

    // Auto pills on asset detail — Music & Audio: ISRC (Recording) + ISWC (Composition).
    await expect(page.getByText('ISRC (Recording)')).toBeVisible();
    await expect(page.getByText('ISWC (Composition)')).toBeVisible();
    await expect(page.getByText(cbtCode)).toBeVisible();
    await expect(page.getByText(/CVT-ISRC-[0-9A-F]{4}/)).toBeVisible();
    await expect(page.getByText(/CVT-ISWC-[0-9A-F]{4}/)).toBeVisible();

    // No fabricated real-world registry codes: every derived value is a CVT key.
    await expect(page.getByText(/[A-Z]{2}-[A-Z0-9]{3}-[0-9]{2}-[0-9]{5}/)).toHaveCount(0);
    await expect(page.getByText(/10\.5240\//)).toHaveCount(0);

    // Smart-ledger verification strip: Pre-Reconciled is active (pools are
    // exact); Audited and Immutable stay pending until settlements exist.
    // All three render their text label in every state — never color-only.
    const strip = page.locator('span[data-verification]');
    await expect(strip).toHaveCount(3);
    await expect(page.locator('span[data-verification="pre-reconciled"]')).toHaveAttribute('data-state', 'active');
    await expect(page.locator('span[data-verification="audited"]')).toHaveAttribute('data-state', 'pending');
    await expect(page.locator('span[data-verification="immutable-ledger-active"]')).toHaveAttribute('data-state', 'pending');
  });

  test('registering the same asset twice shows the gold banner and preserves the form state', async ({
    page,
  }) => {
    await fillRegistrationForm(page);

    await page.getByRole('button', { name: /Register asset/ }).click();
    await page.getByRole('button', { name: /Accept MUL & Register Asset/ }).click();

    // In-app gold banner — never a raw Postgres error.
    const banner = page.locator('aside.banner-gold');
    await expect(banner).toContainText('Asset already registered in CBT catalog');
    await expect(page.getByText(/duplicate key/i)).toHaveCount(0);
    await expect(page.getByText(/Database registration failed/i)).toHaveCount(0);

    // UI state fully preserved: still on the form, title intact, pools still exact.
    await expect(page).toHaveURL(/\/assets\/new$/);
    await expect(page.locator(TITLE_INPUT)).toHaveValue(ASSET_TITLE);
    await expect(poolSection(page, POOLS[0]).locator('span.font-mono')).toHaveText(/100\.0000%/);
    await expect(poolSection(page, POOLS[2]).locator('span.font-mono')).toHaveText(/100\.0000%/);

    // The Asset Studio's registered-asset list holds exactly one copy of the
    // asset of record (the full catalog view is a stub in this release).
    await page.goto('/assets');
    await expect(page.getByText(ASSET_TITLE)).toHaveCount(1);
  });
});
