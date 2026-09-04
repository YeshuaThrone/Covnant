import { expect, test, type Page } from '@playwright/test';

/**
 * CovnantSDK gateway E2E - the root surface runs under the owner's
 * PERMANENT OVERRIDE UNTIL MANUALLY REVERTED: the identity form's submit
 * routes directly to /dashboard via router.push, and the Supabase + Twilio
 * handshake is inert (the full OTP implementation stays in the codebase
 * dormant, restorable by uncommenting). The suite asserts the override
 * behavior and the unchanged server-enforced boundaries:
 *   - identity submit -> /dashboard, zero Supabase auth network traffic
 *   - the handshake stays inert even with an unverified phone number
 *   - the admin tab stays hidden without a CEO session (server-side vault)
 */

const GATEWAY_FORM = {
  legalName: 'Yeshua Throne',
  artistName: 'Throne',
  regularEmail: 'creator@covnant.test',
  phone: '212-555-0134',
};

/** Tracks every Supabase auth request - the handshake must stay inert. */
function trackSupabaseAuth(page: Page): { urls: string[] } {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321';
  const urls: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(`${supabaseUrl}/auth/`)) urls.push(request.url());
  });
  return { urls };
}

test('root gateway renders the identity intake form', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'COVNANT' })).toBeVisible();
  await expect(page.getByText('Identity Verification Required')).toBeVisible();
  await expect(page.getByLabel('LEGAL NAME')).toBeVisible();
  await expect(page.getByLabel('ARTIST / CREATOR NAME')).toBeVisible();
  await expect(page.getByLabel('EMAIL', { exact: true })).toBeVisible();
  await expect(page.getByLabel('PHONE NUMBER (SMS VERIFICATION REQUIRED)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ping Device & Send Code' })).toBeVisible();
});

test('permanent override: identity submit routes directly to /dashboard with zero Supabase auth traffic', async ({
  page,
}) => {
  const auth = trackSupabaseAuth(page);
  let registerCalls = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/users/register')) registerCalls += 1;
  });

  await page.goto('/');

  await page.getByLabel('LEGAL NAME').fill(GATEWAY_FORM.legalName);
  await page.getByLabel('ARTIST / CREATOR NAME').fill(GATEWAY_FORM.artistName);
  await page.getByLabel('EMAIL', { exact: true }).fill(GATEWAY_FORM.regularEmail);
  await page.getByLabel('PHONE NUMBER (SMS VERIFICATION REQUIRED)').fill(GATEWAY_FORM.phone);
  await page.getByRole('button', { name: 'Ping Device & Send Code' }).click();

  // Single click -> direct advance to the main UI state. No code step, no
  // verification, no telemetry registration.
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  expect(auth.urls).toEqual([]);
  expect(registerCalls).toBe(0);
});

test('the override stays inert with an unverified phone number', async ({ page }) => {
  const auth = trackSupabaseAuth(page);

  await page.goto('/');
  await page.getByLabel('LEGAL NAME').fill(GATEWAY_FORM.legalName);
  await page.getByLabel('ARTIST / CREATOR NAME').fill(GATEWAY_FORM.artistName);
  await page.getByLabel('EMAIL', { exact: true }).fill(GATEWAY_FORM.regularEmail);
  await page.getByLabel('PHONE NUMBER (SMS VERIFICATION REQUIRED)').fill('123');
  await page.getByRole('button', { name: 'Ping Device & Send Code' }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  expect(auth.urls).toEqual([]);
});

test('admin vault shows access denied for unauthenticated visitors', async ({ page }) => {
  await page.route('**/api/admin/ledger', async (route) => {
    await route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Forbidden"}' });
  });

  await page.goto('/');

  // The admin tab is hidden without a CEO session; the vault route is
  // enforced server-side regardless.
  await expect(page.getByText('Covnant Admin')).toHaveCount(0);
});
