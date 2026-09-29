import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildOtpRequestBody,
  normalizeCodeInput,
  readVerifyLaterStatus,
  requestOtpCode,
  submitOtpCode,
} from './phoneOtpRequest';

/* The OTP step's request layer — every response branch maps onto a
 * renderable state, and no branch ever surfaces the code. These tests pin
 * the fail-open shape: delivery failure is a STATE, transport failure is a
 * retry, and the verify-later probe renders nothing on any surprise. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const FETCH = vi.fn();

beforeEach(() => {
  FETCH.mockReset();
  vi.stubGlobal('fetch', FETCH);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildOtpRequestBody', () => {
  it('carries exactly the email and the phone — no enumeration surface', () => {
    expect(buildOtpRequestBody('a@b.co', '+18303582306')).toBe(
      JSON.stringify({ email: 'a@b.co', phone: '+18303582306' }),
    );
  });
});

describe('requestOtpCode', () => {
  it('maps a delivered send to sent:true with the channel', async () => {
    FETCH.mockResolvedValueOnce(
      jsonResponse(200, { ok: true, delivered: true, deliveredVia: 'whatsapp' }),
    );
    const state = await requestOtpCode('a@b.co', '+18303582306');
    expect(state).toEqual({ phase: 'sent', delivered: true, deliveredVia: 'whatsapp' });
  });

  it('maps an undelivered send to a sent:false STATE — never an error wall', async () => {
    FETCH.mockResolvedValueOnce(jsonResponse(200, { ok: true, delivered: false }));
    const state = await requestOtpCode('a@b.co', '+18303582306');
    expect(state).toEqual({ phase: 'sent', delivered: false, deliveredVia: null });
  });

  it('maps a 429 to the cooldown state', async () => {
    FETCH.mockResolvedValueOnce(
      jsonResponse(429, { error: 'resend_cooldown', message: 'Wait 60 seconds.' }),
    );
    expect(await requestOtpCode('a@b.co', '+18303582306')).toEqual({ phase: 'cooldown' });
  });

  it('maps a server failure to a still-continue message', async () => {
    FETCH.mockResolvedValueOnce(jsonResponse(500, { error: 'internal_error' }));
    const state = await requestOtpCode('a@b.co', '+18303582306');
    expect(state.phase).toBe('failed');
    expect(state.phase === 'failed' && state.message).toContain('still continue');
  });

  it('maps a transport failure to a still-continue message', async () => {
    FETCH.mockRejectedValueOnce(new TypeError('network down'));
    const state = await requestOtpCode('a@b.co', '+18303582306');
    expect(state.phase).toBe('failed');
    expect(state.phase === 'failed' && state.message).toContain('still continue');
  });
});

describe('normalizeCodeInput', () => {
  it('accepts six digits and trims whitespace', () => {
    expect(normalizeCodeInput(' 012345 ')).toBe('012345');
  });
  it('rejects non-digits and wrong lengths', () => {
    expect(normalizeCodeInput('12345')).toBeNull();
    expect(normalizeCodeInput('1234567')).toBeNull();
    expect(normalizeCodeInput('12a456')).toBeNull();
    expect(normalizeCodeInput('')).toBeNull();
  });
});

describe('submitOtpCode', () => {
  it('maps a 200 to ok — the only success', async () => {
    FETCH.mockResolvedValueOnce(jsonResponse(200, { ok: true, verified: true }));
    expect(await submitOtpCode('a@b.co', '012345')).toEqual({ ok: true });
  });

  it('surfaces the route plain-language message on a wrong code', async () => {
    FETCH.mockResolvedValueOnce(
      jsonResponse(400, { error: 'invalid_code', message: 'That code is incorrect.' }),
    );
    const result = await submitOtpCode('a@b.co', '999999');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.state).toEqual({ phase: 'rejected', message: 'That code is incorrect.' });
    }
  });

  it('falls back to a retry line when a rejection carries no message', async () => {
    FETCH.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_code' }));
    const result = await submitOtpCode('a@b.co', '999999');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.state.phase).toBe('retry');
    }
  });

  it('maps a 429 to the retry state', async () => {
    FETCH.mockResolvedValueOnce(jsonResponse(429, { error: 'rate_limited' }));
    const result = await submitOtpCode('a@b.co', '012345');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.state.phase).toBe('retry');
    }
  });

  it('maps a transport failure to the retry state', async () => {
    FETCH.mockRejectedValueOnce(new TypeError('network down'));
    const result = await submitOtpCode('a@b.co', '012345');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.state.phase).toBe('retry');
    }
  });
});

describe('readVerifyLaterStatus', () => {
  it('offers the prompt for an unverified profile with a phone', async () => {
    FETCH.mockResolvedValueOnce(
      jsonResponse(200, {
        profile: { email: 'a@b.co', phone: '+18303582306', phone_verified_at: null },
      }),
    );
    expect(await readVerifyLaterStatus()).toEqual({
      phase: 'unverified',
      email: 'a@b.co',
      phone: '+18303582306',
    });
  });

  it('stays silent for a verified phone', async () => {
    FETCH.mockResolvedValueOnce(
      jsonResponse(200, {
        profile: {
          email: 'a@b.co',
          phone: '+18303582306',
          phone_verified_at: '2026-09-29T00:00:00Z',
        },
      }),
    );
    expect(await readVerifyLaterStatus()).toEqual({ phase: 'unknown' });
  });

  it('stays silent when the profile has no phone on file', async () => {
    FETCH.mockResolvedValueOnce(
      jsonResponse(200, { profile: { email: 'a@b.co', phone: null, phone_verified_at: null } }),
    );
    expect(await readVerifyLaterStatus()).toEqual({ phase: 'unknown' });
  });

  it('stays silent when /me fails', async () => {
    FETCH.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }));
    expect(await readVerifyLaterStatus()).toEqual({ phase: 'unknown' });
  });

  it('stays silent on a transport failure', async () => {
    FETCH.mockRejectedValueOnce(new TypeError('network down'));
    expect(await readVerifyLaterStatus()).toEqual({ phase: 'unknown' });
  });
});
