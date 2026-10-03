/**
 * POST /api/covnant/auth/confirmation/resend — route acceptance tests.
 * The email-verification path's resend control: the generic no-enumeration
 * success envelope, the shared email rule, the per-IP and per-email
 * windows, fail-closed configuration, and the sanitized classification of
 * GoTrue's resend failures. The route never sees a token; the tests pin
 * that the wire carries only { email }.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../route';
import { resetRateLimits } from '@/lib/server/rateLimit';

const resendMock = vi.hoisted(() => vi.fn());
const envHolder = vi.hoisted(() => ({
  env: {
    url: 'https://test-project.supabase.co',
    anonKey: 'test-anon-key',
    serviceRoleKey: 'test-service-role-key',
  } as { url: string; anonKey: string; serviceRoleKey: string } | null,
}));

vi.mock('@/lib/server/supabase', () => ({
  readSupabaseEnv: () => envHolder.env,
  createAuthClient: () => ({ auth: { resend: resendMock } }),
}));

vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => null) }));

function post(email: unknown, ip = '203.0.113.10', raw?: string): Promise<Response> {
  return POST(
    new Request('https://covnant.test/api/covnant/auth/confirmation/resend', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: raw ?? JSON.stringify({ email }),
    }),
  );
}

beforeEach(() => {
  resendMock.mockReset();
  resendMock.mockResolvedValue({ data: {}, error: null });
  envHolder.env = {
    url: 'https://test-project.supabase.co',
    anonKey: 'test-anon-key',
    serviceRoleKey: 'test-service-role-key',
  };
  resetRateLimits();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetRateLimits();
});

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('the real resend', () => {
  it('calls GoTrue resend with the normalized signup email and returns the generic 200', async () => {
    const response = await post('  Creator@Example.com  ');

    expect(response.status).toBe(200);
    await expect(bodyOf(response)).resolves.toEqual({ ok: true });
    expect(resendMock).toHaveBeenCalledWith({
      type: 'signup',
      email: 'creator@example.com',
    });
  });
});

describe('request validation', () => {
  it('rejects a malformed body with 400', async () => {
    const response = await post(undefined, '203.0.113.10', 'not json at all');
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toMatchObject({ ok: false, reason: 'malformed_body' });
    expect(resendMock).not.toHaveBeenCalled();
  });

  it.each([
    ['an array body', '["creator@example.com"]'],
    ['a null body', 'null'],
  ])('rejects a %s with 400 malformed_body', async (_label, raw) => {
    const response = await post(undefined, '203.0.113.10', raw);
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toMatchObject({ ok: false, reason: 'malformed_body' });
  });

  it('rejects an invalid email with the sanitized 400 and never reaches Supabase', async () => {
    const response = await post('not-an-email');
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toMatchObject({ ok: false, reason: 'invalid_email' });
    expect(resendMock).not.toHaveBeenCalled();
  });

  it('rejects a missing email with the same sanitized 400', async () => {
    const response = await post(undefined);
    expect(response.status).toBe(400);
    await expect(bodyOf(response)).resolves.toMatchObject({ ok: false, reason: 'invalid_email' });
  });
});

describe('the per-email cooldown', () => {
  it('rejects a second request for the same address inside the minute with 429 resend_cooldown', async () => {
    const first = await post('creator@example.com', '198.51.100.4');
    const second = await post('creator@example.com', '198.51.100.4');

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    await expect(bodyOf(second)).resolves.toMatchObject({ ok: false, reason: 'resend_cooldown' });
    expect(resendMock).toHaveBeenCalledTimes(1);
  });

  it('serves different addresses independently inside the same minute', async () => {
    const first = await post('a@example.com', '198.51.100.5');
    const second = await post('b@example.com', '198.51.100.5');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(resendMock).toHaveBeenCalledTimes(2);
  });
});

describe('the per-IP window', () => {
  it('blocks the 4th request within a minute with 429 rate_limited', async () => {
    await post('a@example.com', '198.51.100.7');
    await post('b@example.com', '198.51.100.7');
    await post('c@example.com', '198.51.100.7');
    const blocked = await post('d@example.com', '198.51.100.7');

    expect(blocked.status).toBe(429);
    await expect(bodyOf(blocked)).resolves.toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(resendMock).toHaveBeenCalledTimes(3);
  });
});

describe('GoTrue failure classification', () => {
  it('maps the resend throttle to 429 resend_cooldown', async () => {
    resendMock.mockResolvedValue({
      data: null,
      error: { message: 'For security purposes, you can only request this once every 60 seconds' },
    });
    const response = await post('creator@example.com');
    expect(response.status).toBe(429);
    await expect(bodyOf(response)).resolves.toMatchObject({ ok: false, reason: 'resend_cooldown' });
  });

  it('maps a generic GoTrue failure to the fail-closed 503 without echoing the upstream message', async () => {
    resendMock.mockResolvedValue({
      data: null,
      error: { message: 'smtp connect timeout internal-relay-7' },
    });
    const response = await post('creator@example.com');
    expect(response.status).toBe(503);
    const body = await bodyOf(response);
    expect(body).toMatchObject({ ok: false, reason: 'email_send_failed' });
    const text = JSON.stringify(body);
    expect(text).not.toContain('smtp');
    expect(text).not.toContain('internal-relay-7');
  });

  it('maps a rejected resend call to the same fail-closed 503', async () => {
    resendMock.mockRejectedValue(new Error('fetch failed'));
    const response = await post('creator@example.com');
    expect(response.status).toBe(503);
    await expect(bodyOf(response)).resolves.toMatchObject({ ok: false, reason: 'email_send_failed' });
  });
});

describe('fail-closed configuration', () => {
  it('returns 503 supabase_not_configured before any Supabase call', async () => {
    envHolder.env = null;
    const response = await post('creator@example.com');
    expect(response.status).toBe(503);
    await expect(bodyOf(response)).resolves.toMatchObject({
      ok: false,
      reason: 'supabase_not_configured',
    });
    expect(resendMock).not.toHaveBeenCalled();
  });
});
