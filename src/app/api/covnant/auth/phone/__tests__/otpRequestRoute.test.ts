/**
 * POST /api/covnant/auth/phone/otp — route acceptance tests. The spec's
 * observable contract, asserted through the service-role seam: eligibility
 * gating (existing profile + matching canonical phone + unverified), the
 * generic no-enumeration envelope, the server-enforced 60s cooldown,
 * resend consuming prior rows, fail-open delivery (provider throw and
 * non-ok degrade to 200 delivered:false), fail-closed configuration, and
 * the code never appearing in any response body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../otp/route';
import { resetRateLimits } from '@/lib/server/rateLimit';
import { codeFromMessage, createSupabaseFake, type FakeHarness } from './supabaseFake';

const SECRET = 'test-otp-hash-secret';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const PHONE = '+15125550123';
const EMAIL = 'creator@example.com';

const harnessHolder = vi.hoisted(() => ({ current: null as FakeHarness | null }));

vi.mock('@/lib/server/supabase', () => ({
  readSupabaseEnv: () => ({
    url: 'https://test-project.supabase.co',
    anonKey: 'test-anon-key',
    serviceRoleKey: 'test-service-role-key',
  }),
  createAdminClient: () => harnessHolder.current?.admin ?? null,
}));

vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => null) }));

/** The controllable provider seam — every failure mode is settable per test. */
const providerHolder = vi.hoisted(() => ({
  result: { ok: true } as { ok: boolean },
  thrown: null as unknown,
  messages: [] as string[],
}));

vi.mock('@/lib/covnant/otp/smsProvider', () => ({
  getSmsProvider: () => ({
    name: 'textbee',
    sendSms: async (phone: string, message: { body: string }) => {
      providerHolder.messages.push(`${phone}:${message.body}`);
      if (providerHolder.thrown !== null) throw providerHolder.thrown;
      return { ...providerHolder.result, via: 'textbee' };
    },
  }),
}));

function post(email: unknown, phone: unknown, ip = '203.0.113.10'): Promise<Response> {
  return POST(
    new Request('https://covnant.test/api/covnant/auth/phone/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ email, phone }),
    }),
  );
}

const RECENT_ROW = { created_at: new Date().toISOString() };
const OLD_ROW = { created_at: new Date(Date.now() - 5 * 60_000).toISOString() };

beforeEach(() => {
  harnessHolder.current = createSupabaseFake();
  providerHolder.result = { ok: true };
  providerHolder.thrown = null;
  providerHolder.messages = [];
  process.env.OTP_HASH_SECRET = SECRET;
  resetRateLimits();
});

afterEach(() => {
  delete process.env.OTP_HASH_SECRET;
  vi.restoreAllMocks();
});

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('eligible request — the real send', () => {
  it('stores a hashed code, dispatches the SMS, and returns 200 ok', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone: PHONE, phone_verified_at: null };
    harness!.state.latestRow = OLD_ROW;

    const response = await post(EMAIL, PHONE);

    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toEqual({ ok: true, delivered: true, deliveredVia: 'textbee' });

    // Exactly one new row — hashed at rest, bound to the user, expiring in ~5 min.
    expect(harness!.calls.inserts).toHaveLength(1);
    const insert = harness!.calls.inserts[0];
    expect(insert.table).toBe('phone_verifications');
    expect(insert.payload.user_id).toBe(USER_ID);
    expect(insert.payload.phone).toBe(PHONE);
    expect(insert.payload.otp_hash).toMatch(/^[0-9a-f]{64}$/);
    const expiresAt = new Date(insert.payload.expires_at as string).getTime();
    expect(expiresAt - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);

    // Prior unexpired rows were consumed before the insert.
    const consume = harness!.calls.updates.find((call) => call.patch.expires_at !== undefined);
    expect(consume).toBeDefined();
    expect(consume!.isFilters).toContainEqual(['verified_at', null]);

    // The provider got the canonical phone and a message carrying the code.
    expect(providerHolder.messages).toHaveLength(1);
    expect(providerHolder.messages[0].startsWith(PHONE)).toBe(true);
    expect(codeFromMessage(providerHolder.messages[0])).toMatch(/^\d{6}$/);
  });

  it('normalizes any input phone format through the shared normalizer before matching', async () => {
    const harness = harnessHolder.current;
    // The profile holds the CANONICAL form; the request sends the same
    // number in a different surface format — matching happens after
    // normalization.
    harness!.state.profile = { id: USER_ID, phone: '+18303582306', phone_verified_at: null };
    harness!.state.latestRow = OLD_ROW;

    const response = await post(EMAIL, '(830) 358-2306');

    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toEqual({ ok: true, delivered: true, deliveredVia: 'textbee' });
    expect(providerHolder.messages[0].startsWith('+18303582306')).toBe(true);
  });
});

describe('ineligible requests — the generic no-enumeration envelope', () => {
  it.each([
    ['unknown email', { id: USER_ID, phone: PHONE, phone_verified_at: null }, EMAIL, '+15125550124'],
    ['mismatched phone', { id: USER_ID, phone: '+15125550124', phone_verified_at: null }, EMAIL, PHONE],
    ['already verified', { id: USER_ID, phone: PHONE, phone_verified_at: new Date().toISOString() }, EMAIL, PHONE],
  ])('%s returns the same generic success with no insert and no send', async (_name, profile, email, phone) => {
    const harness = harnessHolder.current;
    harness!.state.profile = profile;

    const response = await post(email, phone);

    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toEqual({ ok: true, delivered: false, deliveredVia: null });
    expect(harness!.calls.inserts).toHaveLength(0);
    expect(providerHolder.messages).toHaveLength(0);
  });
});

describe('server-enforced resend cooldown', () => {
  it('rejects a request inside the 60-second window with 429 resend_cooldown', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone: PHONE, phone_verified_at: null };
    harness!.state.latestRow = RECENT_ROW;

    const response = await post(EMAIL, PHONE);

    expect(response.status).toBe(429);
    await expect(bodyOf(response)).resolves.toMatchObject({ ok: false, reason: 'resend_cooldown' });
    expect(harness!.calls.inserts).toHaveLength(0);
  });

  it('allows a request after the window passes', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone: PHONE, phone_verified_at: null };
    harness!.state.latestRow = { created_at: new Date(Date.now() - 61_000).toISOString() };

    const response = await post(EMAIL, PHONE);

    expect(response.status).toBe(200);
    expect(harness!.calls.inserts).toHaveLength(1);
  });
});

describe('fail-open delivery', () => {
  it('degrades a provider throw to 200 with delivered:false — never an error wall', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone: PHONE, phone_verified_at: null };
    harness!.state.latestRow = OLD_ROW;
    providerHolder.thrown = new TypeError('fetch failed');

    const response = await post(EMAIL, PHONE);

    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toEqual({ ok: true, delivered: false, deliveredVia: null });
    expect(harness!.calls.inserts).toHaveLength(1);
  });

  it('degrades a provider-reported failure to 200 with delivered:false', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone: PHONE, phone_verified_at: null };
    harness!.state.latestRow = OLD_ROW;
    providerHolder.result = { ok: false };

    const response = await post(EMAIL, PHONE);

    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toEqual({ ok: true, delivered: false, deliveredVia: null });
  });
});

describe('fail-closed configuration and validation', () => {
  it('returns 503 when OTP_HASH_SECRET is missing — no code is generated', async () => {
    delete process.env.OTP_HASH_SECRET;
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone: PHONE, phone_verified_at: null };

    const response = await post(EMAIL, PHONE);

    expect(response.status).toBe(503);
    expect(harness!.calls.inserts).toHaveLength(0);
  });

  it('rejects a malformed body with 400', async () => {
    const response = await POST(
      new Request('https://covnant.test/api/covnant/auth/phone/otp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json at all',
      }),
    );
    expect(response.status).toBe(400);
  });

  it.each([
    ['invalid email', 'not-an-email', PHONE],
    ['invalid phone', EMAIL, 'hello'],
    ['missing phone', EMAIL, null],
  ])('%s is a sanitized 400 with no lookup side effects', async (_name, email, phone) => {
    const harness = harnessHolder.current;
    const response = await post(email, phone);
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toMatchObject({ ok: false });
    expect(harness!.calls.inserts).toHaveLength(0);
  });
});

describe('the per-IP window', () => {
  it('blocks the 4th request within a minute with 429 rate_limited', async () => {
    const harness = harnessHolder.current;
    // Ineligible (generic) path still counts — the limiter guards the lookup.
    const response = await post(EMAIL, PHONE, '198.51.100.7')
      .then(() => post(EMAIL, PHONE, '198.51.100.7'))
      .then(() => post(EMAIL, PHONE, '198.51.100.7'))
      .then(() => post(EMAIL, PHONE, '198.51.100.7'));

    expect(response.status).toBe(429);
    await expect(bodyOf(response)).resolves.toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(harness!.calls.inserts).toHaveLength(0);
  });
});

describe('response hygiene', () => {
  it('never carries the code (or anything 6-digit) in the success body', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone: PHONE, phone_verified_at: null };
    harness!.state.latestRow = OLD_ROW;

    const response = await post(EMAIL, PHONE);
    const text = JSON.stringify(await bodyOf(response));
    const code = codeFromMessage(providerHolder.messages[0]);

    expect(text).not.toContain(code);
    expect(text).not.toMatch(/\d{6}/);
    // And the stored hash is not the plaintext code either.
    expect(String(harness!.calls.inserts[0].payload.otp_hash)).not.toContain(code);
  });
});
