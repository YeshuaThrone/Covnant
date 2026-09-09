import { expect, test, type Page } from '@playwright/test';

/**
 * PR C — the seal wires to POST /api/covnant/auth/signup. Every response
 * state of the reconciled contract (art_gOfrFMCA) renders in the existing
 * statement voice, INSIDE the closing composition above the final ruler:
 *   - 201 created (session and session-less) — UCT + provisioning
 *   - 200 repeat — status-only, never a UCT
 *   - 409 duplicate_email — sign-in framing
 *   - 422 coded validation — the API's message
 *   - 429 / 503 / network — recovery lines, local seal record preserved
 * The API is STUBBED per test (page.route) — no backend is needed and no
 * real account is ever created. Zone grammar and the fourteen golden
 * rulers stay untouched throughout.
 */

const SIGNUP_PATH = '**/api/covnant/auth/signup';

const CREATED_201 = {
  ok: true,
  created: true,
  uct: 'UCT-US-2026-9A3F02B7-K4',
  uctCreatedAt: '2026-09-09T20:31:04.000Z',
  jurisdiction: 'US',
  status: 'PENDING',
  reason: 'INCREASE_NOT_CONFIGURED',
  alreadyRegistered: false,
  rightsHolderId: 'b2f1c3a9-1111-4222-8333-444455556666',
  assetId: '7e6d5c4b-9999-4888-a777-666555544444',
  session: null,
  user: { id: 'auth_user_1', email: 'artist@example.com', email_confirmed_at: null },
  profile: { id: 'auth_user_1', stage_name: 'Nova Reign' },
};

const FIELDS = [
  { label: 'Stage Name', value: 'Nova Reign' },
  { label: 'Legal Name', value: 'Jordan A. Reyes' },
  { label: 'Email', value: 'artist@example.com' },
  { label: 'Phone Number', value: '+15125550123' },
  { label: 'Core Industry & Title', value: 'Music — Recording' },
  { label: 'Password', value: 'correct-horse-battery' },
] as const;

async function fillAndSeal(page: Page): Promise<void> {
  for (const field of FIELDS) {
    await page.getByRole('textbox', { name: field.label }).fill(field.value);
  }
  await page.getByRole('button', { name: /^(Submit|SEALED)$/ }).click();
}

function sealResponseLine(page: Page, text: string) {
  // The response lines share the unseal hint's statement voice — scope by
  // text; the copy never collides with the hint's own phrase.
  return page.locator('p.font-mono', { hasText: text });
}

test('seal → 201 with a session renders the UCT, provisioning, and the signed-in state', async ({
  page,
}) => {
  // Confirmation OFF (dev state): a full session rides the 201.
  await page.route(SIGNUP_PATH, (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        ...CREATED_201,
        session: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          expires_at: 9999999999,
          token_type: 'bearer',
        },
      }),
    }),
  );
  await page.goto('/');
  await fillAndSeal(page);

  await expect(sealResponseLine(page, 'Your Covnant Tag UCT-US-2026-9A3F02B7-K4')).toHaveCount(1);
  await expect(sealResponseLine(page, 'Provisioning queued')).toHaveCount(1);
  await expect(sealResponseLine(page, 'Your account is live — you are signed in')).toHaveCount(1);
  // A session-carrying 201 is NOT the check-your-inbox state.
  await expect(sealResponseLine(page, 'Check your inbox')).toHaveCount(0);

  // The response renders inside the closing composition: the hint stays,
  // the button stays SEALED, and no new golden ruler appeared.
  await expect(sealResponseLine(page, 'Double-click to unseal')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^(Submit|SEALED)$/ })).toHaveText('SEALED');
  await expect(page.locator('.gold-rule')).toHaveCount(14);
});

test('seal → 201 session-less leads with check-your-inbox and discloses the UCT once', async ({
  page,
}) => {
  await page.route(SIGNUP_PATH, (route) =>
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(CREATED_201) }),
  );
  await page.goto('/');
  await fillAndSeal(page);

  // Session-less 201 is a SUCCESS — the account exists, activation pending.
  await expect(sealResponseLine(page, 'Check your inbox to activate your account')).toHaveCount(1);
  await expect(sealResponseLine(page, 'Your Covnant Tag UCT-US-2026-9A3F02B7-K4')).toHaveCount(1);
  await expect(sealResponseLine(page, 'Your account is live')).toHaveCount(0);
});

test('seal → 200 repeat renders the status-only card and never a UCT', async ({ page }) => {
  await page.route(SIGNUP_PATH, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        created: false,
        status: 'PENDING',
        reason: 'INCREASE_NOT_CONFIGURED',
        alreadyRegistered: true,
        rightsHolderId: 'b2f1c3a9-1111-4222-8333-444455556666',
        assetId: '7e6d5c4b-9999-4888-a777-666555544444',
      }),
    }),
  );
  await page.goto('/');
  await fillAndSeal(page);

  await expect(sealResponseLine(page, 'This email already holds its Covnant Tag')).toHaveCount(1);
  await expect(sealResponseLine(page, 'Provisioning queued')).toHaveCount(1);
  // Enumeration protection made visible: no UCT text anywhere, and no
  // retry-the-UCT affordance.
  await expect(page.getByText(/UCT-/)).toHaveCount(0);
});

test('seal → 409 duplicate_email routes to the sign-in framing', async ({ page }) => {
  await page.route(SIGNUP_PATH, (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: 'An account with this email already exists. Try signing in.',
        reason: 'duplicate_email',
      }),
    }),
  );
  await page.goto('/');
  await fillAndSeal(page);

  await expect(sealResponseLine(page, 'An account with this email already exists')).toHaveCount(1);
  await expect(sealResponseLine(page, 'try signing in')).toHaveCount(1);
  await expect(page.getByText(/UCT-/)).toHaveCount(0);
});

test('seal → 422 renders the API coded validation message', async ({ page }) => {
  await page.route(SIGNUP_PATH, (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: 'phone must be an E.164 number (for example +15125550123).',
        reason: 'invalid_phone',
      }),
    }),
  );
  await page.goto('/');
  await fillAndSeal(page);

  await expect(
    sealResponseLine(page, 'phone must be an E.164 number (for example +15125550123).'),
  ).toHaveCount(1);
  // The composition stays sealed — the escape-hatch hint remains.
  await expect(sealResponseLine(page, 'Double-click to unseal')).toHaveCount(1);
  await expect(page.locator('.gold-rule')).toHaveCount(14);
});

test('seal → 429 renders the wait-and-retry line', async ({ page }) => {
  await page.route(SIGNUP_PATH, (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'Too many registrations.', reason: 'rate_limited' }),
    }),
  );
  await page.goto('/');
  await fillAndSeal(page);

  await expect(sealResponseLine(page, 'Too many attempts — wait a minute and try again')).toHaveCount(1);
});

test('seal → 503 UCT_MINT_FAILED renders the clean-retry line and keeps the offline record', async ({
  page,
}) => {
  await page.route(SIGNUP_PATH, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'mint failed', reason: 'UCT_MINT_FAILED' }),
    }),
  );
  await page.goto('/');
  await fillAndSeal(page);

  await expect(sealResponseLine(page, 'Nothing was registered — unseal and submit again')).toHaveCount(1);

  // The local seal record is the offline/fallback record — preserved even
  // when the registry stage fails. The stored shape is unchanged.
  const stored = await page.evaluate(() => window.localStorage.getItem('covnant.sealedEntry'));
  expect(JSON.parse(stored ?? 'null')).toEqual({
    sealed: true,
    values: {
      stageName: 'Nova Reign',
      legalName: 'Jordan A. Reyes',
      email: 'artist@example.com',
      phoneNumber: '+15125550123',
      password: 'correct-horse-battery',
      coreIndustryTitle: 'Music — Recording',
    },
  });
});

test('a network failure renders the recovery line and the offline record persists', async ({
  page,
}) => {
  await page.route(SIGNUP_PATH, (route) => route.abort('connectionreset'));
  await page.goto('/');
  await fillAndSeal(page);

  await expect(
    sealResponseLine(page, 'Your seal could not reach the registry — unseal and submit again'),
  ).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^(Submit|SEALED)$/ })).toHaveText('SEALED');
  const stored = await page.evaluate(() => window.localStorage.getItem('covnant.sealedEntry'));
  expect(JSON.parse(stored ?? 'null')).toEqual({ sealed: true, values: expect.anything() });
});

test('the request body carries the six values as captured: combined field unsplitted, terms true', async ({
  page,
}) => {
  let captured: Record<string, unknown> | null = null;
  await page.route(SIGNUP_PATH, (route) => {
    captured = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(CREATED_201) });
  });
  await page.goto('/');
  await fillAndSeal(page);
  await expect(sealResponseLine(page, 'Your Covnant Tag')).toHaveCount(1);

  expect(captured).toMatchObject({
    stage_name: 'Nova Reign',
    legal_name: 'Jordan A. Reyes',
    email: 'artist@example.com',
    phone: '+15125550123',
    // The combined Core Industry & Title value rides AS CAPTURED in both
    // contract fields — the zone is never split, no second input exists.
    core_industry: 'Music — Recording',
    title: 'Music — Recording',
    password: 'correct-horse-battery',
    udr_terms_accepted: true,
  });
});

test('a blank phone capture omits the phone field entirely', async ({ page }) => {
  let captured: Record<string, unknown> | null = null;
  await page.route(SIGNUP_PATH, (route) => {
    captured = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(CREATED_201) });
  });
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Stage Name' }).fill('Nova Reign');
  await page.getByRole('textbox', { name: 'Legal Name' }).fill('Jordan A. Reyes');
  await page.getByRole('textbox', { name: 'Email' }).fill('artist@example.com');
  await page.getByRole('textbox', { name: 'Core Industry & Title' }).fill('Producer');
  await page.getByRole('textbox', { name: 'Password' }).fill('correct-horse-battery');
  await page.getByRole('button', { name: /^(Submit|SEALED)$/ }).click();
  await expect(sealResponseLine(page, 'Your Covnant Tag')).toHaveCount(1);

  expect(captured).not.toBeNull();
  expect('phone' in (captured ?? {})).toBe(false);
});

test('unsealing mid-flight abandons the response rendering — the composition starts clean', async ({
  page,
}) => {
  // Hold the response long enough that the double-click lands mid-flight.
  await page.route(SIGNUP_PATH, (route) =>
    setTimeout(
      () =>
        void route
          .fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(CREATED_201) })
          .catch(() => undefined),
      2000,
    ),
  );
  await page.goto('/');
  await fillAndSeal(page);
  await expect(page.getByRole('button', { name: /^(Submit|SEALED)$/ })).toHaveText('SEALED');

  // The escape hatch stays live during flight: unseal, fields editable.
  await page.getByRole('button', { name: /^(Submit|SEALED)$/ }).dblclick();
  await expect(page.getByRole('button', { name: /^(Submit|SEALED)$/ })).toHaveText('Submit');

  // The late-arriving response is discarded — no contract lines render into
  // the unsealed composition.
  await page.waitForTimeout(2500);
  await expect(sealResponseLine(page, 'Your Covnant Tag')).toHaveCount(0);
  await expect(sealResponseLine(page, 'Check your inbox')).toHaveCount(0);
});
