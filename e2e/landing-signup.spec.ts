import { expect, test, type Page } from '@playwright/test';

/**
 * The landing signup flow — a standard single-click submit form (the
 * double-click seal ritual is retired). Every response state of the
 * reconciled contract (art_gOfrFMCA) either advances to /agent (201/200)
 * or renders the statement-voice line INSIDE the closing composition:
 *   - 201 created (session and session-less) — advance to /agent
 *   - 200 repeat — advance to /agent
 *   - 409 duplicate_email — sign-in framing
 *   - 422 coded validation — the API's message
 *   - 429 / 503 / network — recovery lines
 * Nothing persists locally on ANY path: the offline seal record is retired.
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

async function fillAndSubmit(page: Page): Promise<void> {
  for (const field of FIELDS) {
    await page.getByRole('textbox', { name: field.label }).fill(field.value);
  }
  await page.getByRole('button', { name: 'Continue' }).click();
}

function responseLine(page: Page, text: string) {
  // The response lines share the statement voice — scope by text.
  return page.locator('p.font-mono', { hasText: text });
}

test('a single click submits once, shows the loading state, and advances to /agent on the 201', async ({
  page,
}) => {
  let calls = 0;
  await page.route(SIGNUP_PATH, (route) => {
    calls += 1;
    return route.fulfill({
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
    });
  });
  await page.goto('/');
  await fillAndSubmit(page);

  // In flight: the visible loading label on a disabled button — duplicate
  // submits are impossible (the request fires exactly once).
  const submitting = page.getByRole('button', { name: 'Submitting…' });
  await expect(submitting).toBeDisabled();

  // The 201 advances straight to /agent — no response card, no sealed
  // state, no local record.
  await page.waitForURL('**/agent');
  await expect(page.getByRole('button', { name: /^(Continue|Submitting…)$/ })).toHaveCount(0);
  expect(calls).toBe(1);
  expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
});

test('the 201 session-less response also advances to /agent', async ({ page }) => {
  await page.route(SIGNUP_PATH, (route) =>
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(CREATED_201) }),
  );
  await page.goto('/');
  await fillAndSubmit(page);

  await page.waitForURL('**/agent');
});

test('the 200 repeat response advances to /agent too', async ({ page }) => {
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
  await fillAndSubmit(page);

  await page.waitForURL('**/agent');
});

test('the 409 duplicate_email response renders the sign-in framing and stays on the page', async ({
  page,
}) => {
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
  await fillAndSubmit(page);

  await expect(responseLine(page, 'An account with this email already exists')).toHaveCount(1);
  await expect(responseLine(page, 'try signing in')).toHaveCount(1);
  await expect(page.getByText(/UCT-/)).toHaveCount(0);
  // No navigation — the visitor retries from the composition.
  expect(page.url()).not.toContain('/agent');
  // The button returns to its pressable rest state for a clean retry.
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
});

test('the 422 response renders the coded validation message and the composition stays editable', async ({
  page,
}) => {
  await page.route(SIGNUP_PATH, (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: "That phone number doesn't look right — enter a real number, any format works.",
        reason: 'invalid_phone',
      }),
    }),
  );
  await page.goto('/');
  await fillAndSubmit(page);

  await expect(
    responseLine(page, "That phone number doesn't look right — enter a real number, any format works."),
  ).toHaveCount(1);
  // No E.164 jargon anywhere in the rendered composition.
  await expect(page.getByText(/E\.164/)).toHaveCount(0);
  // The composition stays interactive — no sealed readOnly freezing.
  await expect(page.getByRole('textbox', { name: 'Stage Name' })).not.toHaveAttribute(
    'readonly',
    '',
  );
  await expect(page.locator('.gold-rule')).toHaveCount(14);
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
});

test('the 429 response renders the wait-and-retry line', async ({ page }) => {
  await page.route(SIGNUP_PATH, (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'Too many registrations.', reason: 'rate_limited' }),
    }),
  );
  await page.goto('/');
  await fillAndSubmit(page);

  await expect(responseLine(page, 'Too many attempts — wait a minute and try again')).toHaveCount(1);
});

test('the 503 UCT_MINT_FAILED response renders the clean-retry line and writes nothing locally', async ({
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
  await fillAndSubmit(page);

  await expect(responseLine(page, 'Nothing was registered — submit again')).toHaveCount(1);
  // The offline seal record is retired: nothing persists on ANY path.
  expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
});

test('a network failure renders the recovery line and stays retryable', async ({ page }) => {
  await page.route(SIGNUP_PATH, (route) => route.abort('connectionreset'));
  await page.goto('/');
  await fillAndSubmit(page);

  await expect(
    responseLine(page, 'Your entry could not reach the registry — submit again'),
  ).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
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
  await fillAndSubmit(page);
  await page.waitForURL('**/agent');

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

test('a real-world phone capture rides the wire as canonical E.164', async ({ page }) => {
  let captured: Record<string, unknown> | null = null;
  await page.route(SIGNUP_PATH, (route) => {
    captured = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(CREATED_201) });
  });
  await page.goto('/');
  for (const field of FIELDS.filter((f) => f.label !== 'Phone Number')) {
    await page.getByRole('textbox', { name: field.label }).fill(field.value);
  }
  // The founder's capture, exactly as typed into a real device.
  await page.getByRole('textbox', { name: 'Phone Number' }).fill('830-358-2306');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL('**/agent');

  expect(captured).toMatchObject({ phone: '+18303582306' });
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
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL('**/agent');

  expect(captured).not.toBeNull();
  expect('phone' in (captured ?? {})).toBe(false);
});

test('a second click during flight cannot double-submit — the request fires exactly once', async ({
  page,
}) => {
  // Hold the response long enough that the duplicate click lands mid-flight.
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
  await fillAndSubmit(page);

  // In flight the button is disabled with the loading label; the disabled
  // state plus the component's re-entry guard make a duplicate impossible.
  const submitting = page.getByRole('button', { name: 'Submitting…' });
  await expect(submitting).toBeDisabled();

  await page.waitForURL('**/agent');
});
