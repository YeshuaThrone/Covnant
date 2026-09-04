import { expect, test, type Page } from '@playwright/test';

/**
 * CovnantSDK gateway E2E — the root surface now runs the real identity flow,
 * so the Supabase boundary is stubbed at the network layer (real SMS OTP
 * cannot run in CI). Tests intercept:
 *   - POST {SUPABASE_URL}/auth/v1/otp        → SMS code "sent"
 *   - POST {SUPABASE_URL}/auth/v1/verify     → verified session
 *   - GET  {SUPABASE_URL}/auth/v1/user       → session user lookup
 *   - POST /api/users/register               → telemetry persisted
 *   - GET  /api/admin/ledger                 → 403 (default) / records (admin)
 * following the repo's established page.route stubbing pattern.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321';

const GATEWAY_FORM = {
  legalName: 'Yeshua Throne',
  artistName: 'Throne',
  regularEmail: 'creator@covnant.test',
  phone: '212-555-0134',
};

let registerCalls: Array<{ headers: Record<string, string>; body: unknown }> = [];

async function stubSupabaseAuth(page: Page): Promise<void> {
  await page.route(`${SUPABASE_URL}/auth/v1/otp`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route(`${SUPABASE_URL}/auth/v1/verify`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'e2e-access-token',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: 4102444800,
        refresh_token: 'e2e-refresh-token',
        user: {
          id: 'e2e-user-1',
          aud: 'authenticated',
          role: 'authenticated',
          email: GATEWAY_FORM.regularEmail,
          app_metadata: { provider: 'phone' },
          user_metadata: {},
          created_at: '2026-09-04T00:00:00.000Z',
        },
      }),
    });
  });
  await page.route(`${SUPABASE_URL}/auth/v1/user`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-user-1',
        aud: 'authenticated',
        role: 'authenticated',
        email: GATEWAY_FORM.regularEmail,
        app_metadata: { provider: 'phone' },
        user_metadata: {},
        created_at: '2026-09-04T00:00:00.000Z',
      }),
    });
  });
}

async function stubRegister(page: Page): Promise<void> {
  await page.route('**/api/users/register', async (route) => {
    const request = route.request();
    registerCalls.push({
      headers: request.headers(),
      body: request.postDataJSON(),
    });
    await route.fulfill({ status: 201, contentType: 'application/json', body: '{"ok":true}' });
  });
}

test.beforeEach(() => {
  registerCalls = [];
});

test('root gateway renders the identity intake form', async ({ page }) => {
  await stubSupabaseAuth(page);
  await stubRegister(page);

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'COVNANT' })).toBeVisible();
  await expect(page.getByText('Identity Verification Required')).toBeVisible();
  await expect(page.getByLabel('LEGAL NAME')).toBeVisible();
  await expect(page.getByLabel('ARTIST / CREATOR NAME')).toBeVisible();
  await expect(page.getByLabel('EMAIL', { exact: true })).toBeVisible();
  await expect(page.getByLabel('PHONE NUMBER (SMS VERIFICATION REQUIRED)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ping Device & Send Code' })).toBeVisible();
});

test('invalid phone shows the banner and never calls Supabase', async ({ page }) => {
  await stubSupabaseAuth(page);
  await stubRegister(page);

  let otpCalled = false;
  await page.route(`${SUPABASE_URL}/auth/v1/otp`, async (route) => {
    otpCalled = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');
  await page.getByLabel('LEGAL NAME').fill(GATEWAY_FORM.legalName);
  await page.getByLabel('ARTIST / CREATOR NAME').fill(GATEWAY_FORM.artistName);
  await page.getByLabel('EMAIL', { exact: true }).fill(GATEWAY_FORM.regularEmail);
  await page.getByLabel('PHONE NUMBER (SMS VERIFICATION REQUIRED)').fill('123');
  await page.getByRole('button', { name: 'Ping Device & Send Code' }).click();

  await expect(page.getByText('Please enter a valid 10-digit phone number.')).toBeVisible();
  expect(otpCalled).toBe(false);
});

test('full handshake: SMS code, verification, registration, Your World, dashboard', async ({ page }) => {
  await stubSupabaseAuth(page);
  await stubRegister(page);

  await page.goto('/');

  // Step 1 — identity intake.
  await page.getByLabel('LEGAL NAME').fill(GATEWAY_FORM.legalName);
  await page.getByLabel('ARTIST / CREATOR NAME').fill(GATEWAY_FORM.artistName);
  await page.getByLabel('EMAIL', { exact: true }).fill(GATEWAY_FORM.regularEmail);
  await page.getByLabel('PHONE NUMBER (SMS VERIFICATION REQUIRED)').fill(GATEWAY_FORM.phone);
  await page.getByRole('button', { name: 'Ping Device & Send Code' }).click();

  await expect(page.getByText('Device Handshake Verification')).toBeVisible();
  await expect(page.getByLabel('ENTER 6-DIGIT CODE')).toBeVisible();

  // Step 2 — verification code.
  await page.getByLabel('ENTER 6-DIGIT CODE').fill('123456');
  await page.getByRole('button', { name: 'Verify Device & Enter Your World' }).click();

  // Registration must carry the verified session bearer token and the
  // normalized +1 E.164 phone.
  await expect(page.getByText('Covnant Ledger Handshake Active & Verified')).toBeVisible();
  expect(registerCalls).toHaveLength(1);
  const authorization = registerCalls[0].headers.authorization ?? registerCalls[0].headers.Authorization ?? '';
  expect(authorization).toBe('Bearer e2e-access-token');
  expect(registerCalls[0].body).toMatchObject({
    legalName: GATEWAY_FORM.legalName,
    artistName: GATEWAY_FORM.artistName,
    regularEmail: GATEWAY_FORM.regularEmail,
    phone: '+12125550134',
    phoneVerified: true,
  });

  // World view stays verification-gated and exposes the workspace entry point.
  await expect(page.getByRole('heading', { name: 'Enter Your World.' })).toBeVisible();
  await page.getByRole('button', { name: 'Enter the Workspace' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('admin vault shows access denied for unauthenticated visitors', async ({ page }) => {
  await stubSupabaseAuth(page);
  await page.route('**/api/admin/ledger', async (route) => {
    await route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"Forbidden"}' });
  });

  await page.goto('/');

  // The admin tab is hidden without a CEO session; the vault route is
  // enforced server-side regardless.
  await expect(page.getByText('Covnant Admin')).toHaveCount(0);
});
