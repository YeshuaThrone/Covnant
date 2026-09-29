/**
 * POST /api/covnant/auth/phone/verify — route acceptance tests. The spec's
 * security envelope, asserted through the service-role seam: constant-time
 * comparison over a real HMAC digest, single-use codes (reuse and lost-race
 * rejected), attempts capped at 5, expiry, the plain-language copies, the
 * profile's phone_verified_at flip, and the indistinguishable invalid_code
 * for unknown profiles / absent rows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../verify/route';
import { resetRateLimits } from '@/lib/server/rateLimit';
import { hashOtp } from '@/lib/covnant/otp/service';
import { createSupabaseFake, type FakeHarness } from './supabaseFake';

const SECRET = 'test-otp-hash-secret';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const PHONE = '+15125550123';
const EMAIL = 'creator@example.com';
const CODE = '012345';

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

function post(email: unknown, code: unknown, ip = '203.0.113.20'): Promise<Response> {
  return POST(
    new Request('https://covnant.test/api/covnant/auth/phone/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ email, code }),
    }),
  );
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** An unexpired, unused row holding a real digest of CODE. */
function liveRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'row-1',
    user_id: USER_ID,
    phone: PHONE,
    otp_hash: hashOtp(USER_ID, PHONE, CODE, SECRET),
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    verified_at: null,
    attempts: 0,
    ...overrides,
  };
}

beforeEach(() => {
  harnessHolder.current = createSupabaseFake();
  process.env.OTP_HASH_SECRET = SECRET;
  resetRateLimits();
});

afterEach(() => {
  delete process.env.OTP_HASH_SECRET;
  vi.restoreAllMocks();
});

describe('the happy path', () => {
  it('verifies the correct code, consumes the row, and flips the profile column', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone_verified_at: null };
    harness!.state.latestRow = liveRow();

    const response = await post(EMAIL, CODE);

    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toEqual({ ok: true, verified: true });

    // Single-use claim: the conditional update on the row id, verified_at IS NULL.
    const claim = harness!.calls.updates.find((call) => call.patch.verified_at !== undefined);
    expect(claim).toBeDefined();
    expect(claim!.eqFilters).toContainEqual(['id', 'row-1']);
    expect(claim!.isFilters).toContainEqual(['verified_at', null]);
    expect(claim!.countOption).toBe('exact');

    // The founder's "mark the profile as phone_verified" — the existing column.
    const mark = harness!.calls.updates.find((call) => call.patch.phone_verified_at !== undefined);
    expect(mark).toBeDefined();
    expect(mark!.eqFilters).toContainEqual(['id', USER_ID]);
    expect(String(mark!.patch.phone_verified_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('never echoes the code or the stored hash back in any body', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone_verified_at: null };
    harness!.state.latestRow = liveRow();

    const response = await post(EMAIL, CODE);
    const text = JSON.stringify(await bodyOf(response));

    expect(text).not.toContain(CODE);
    expect(text).not.toContain(String(harness!.state.latestRow.otp_hash));
  });

  it('is idempotent for an already-verified profile — verified:true, zero writes', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone_verified_at: new Date().toISOString() };

    const response = await post(EMAIL, CODE);

    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toEqual({ ok: true, verified: true });
    expect(harness!.calls.updates).toHaveLength(0);
  });
});

describe('wrong and dead codes', () => {
  it('rejects a wrong code with plain-language copy and burns one attempt', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone_verified_at: null };
    harness!.state.latestRow = liveRow();

    const response = await post(EMAIL, '012346');

    expect(response.status).toBe(400);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ ok: false, reason: 'invalid_code' });
    expect(String(body.error)).toMatch(/code/i);
    expect(String(body.error)).not.toMatch(/hash|hmac|row|attempt 3/i);

    const bump = harness!.calls.updates.find((call) => call.patch.attempts !== undefined);
    expect(bump).toBeDefined();
    expect(bump!.patch.attempts).toBe(1);
    expect(bump!.eqFilters).toContainEqual(['id', 'row-1']);
  });

  it('kills the row at the 5th wrong attempt — a fresh code is required', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone_verified_at: null };
    harness!.state.latestRow = liveRow({ attempts: 4 });

    const response = await post(EMAIL, '012346');

    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toMatchObject({ reason: 'too_many_attempts' });
  });

  it('refuses an expired row as code_expired', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone_verified_at: null };
    harness!.state.latestRow = liveRow({
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });

    const response = await post(EMAIL, CODE);

    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toMatchObject({ reason: 'code_expired' });
    expect(harness!.calls.updates).toHaveLength(0);
  });

  it('refuses a reused (already-verified) row as code_used — codes are single-use', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone_verified_at: null };
    harness!.state.latestRow = liveRow({ verified_at: new Date().toISOString() });

    const response = await post(EMAIL, CODE);

    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toMatchObject({ reason: 'code_used' });
    expect(harness!.calls.updates).toHaveLength(0);
  });

  it('refuses a row that already burned its attempts before any comparison', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone_verified_at: null };
    harness!.state.latestRow = liveRow({ attempts: 5 });

    const response = await post(EMAIL, CODE);

    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toMatchObject({ reason: 'too_many_attempts' });
  });

  it('reports code_used when a concurrent verify won the single-use claim (lost race)', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone_verified_at: null };
    harness!.state.latestRow = liveRow();
    harness!.state.updateCount = 0;

    const response = await post(EMAIL, CODE);

    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toMatchObject({ reason: 'code_used' });
  });
});

describe('no oracle for account existence', () => {
  it('answers an unknown profile with the SAME invalid_code body as a wrong code', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = null;

    const unknownResponse = await post('ghost@example.com', CODE);
    const unknownBody = await bodyOf(unknownResponse);
    // The unknown-profile request itself must be write-free — captured before
    // the second (wrong-code) request, which legitimately bumps attempts.
    const updatesAfterUnknown = harness!.calls.updates.length;

    harness!.state.profile = { id: USER_ID, phone_verified_at: null };
    harness!.state.latestRow = liveRow();
    const wrongResponse = await post(EMAIL, '999999');
    const wrongBody = await bodyOf(wrongResponse);

    expect(unknownResponse.status).toBe(400);
    expect(unknownBody).toEqual(wrongBody);
    expect(updatesAfterUnknown).toBe(0);
  });

  it('answers a profile with no verification rows identically to a wrong code', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone_verified_at: null };
    harness!.state.latestRow = null;

    const response = await post(EMAIL, CODE);

    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toMatchObject({ reason: 'invalid_code' });
  });
});

describe('configuration and shape validation', () => {
  it('fails closed with 503 when OTP_HASH_SECRET is missing', async () => {
    delete process.env.OTP_HASH_SECRET;
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone_verified_at: null };

    const response = await post(EMAIL, CODE);

    expect(response.status).toBe(503);
    expect(harness!.calls.updates).toHaveLength(0);
  });

  it('rejects a malformed code shape without burning an attempt', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone_verified_at: null };
    harness!.state.latestRow = liveRow();

    for (const bad of ['01234', '0123456', 'abcdef', '12 456']) {
      const response = await post(EMAIL, bad, '203.0.113.30');
      expect(response.status).toBe(400);
      await expect(bodyOf(response)).resolves.toMatchObject({ reason: 'invalid_code' });
    }
    expect(harness!.calls.updates).toHaveLength(0);
  });

  it('trims whitespace around an otherwise valid code', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone_verified_at: null };
    harness!.state.latestRow = liveRow();

    const response = await post(EMAIL, `  ${CODE}  `);

    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toEqual({ ok: true, verified: true });
  });

  it('surfaces a store failure as a sanitized 500 with zero state change', async () => {
    const harness = harnessHolder.current;
    harness!.state.profile = { id: USER_ID, phone_verified_at: null };
    harness!.state.error = { message: 'connection reset' };

    const response = await post(EMAIL, CODE);

    expect(response.status).toBe(500);
    await expect(bodyOf(response)).resolves.toMatchObject({ ok: false });
  });
});
