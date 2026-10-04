import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resendConfirmationEmail } from './confirmationResend';

/* The confirmation-email step's request layer — every response branch maps
 * onto a renderable state, and no branch surfaces anything but the generic
 * outcome. These tests pin the same fail-soft shape as the phone OTP
 * helper: cooldown is a STATE, transport failure is a retry, and the
 * 200 body is the generic no-enumeration success either way. */

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

describe('resendConfirmationEmail', () => {
  it('POSTs only the email to the confirmation resend route', async () => {
    FETCH.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await resendConfirmationEmail('creator@example.com');
    expect(FETCH).toHaveBeenCalledWith(
      '/api/covnant/auth/confirmation/resend',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'creator@example.com' }),
        cache: 'no-store',
      }),
    );
  });

  it('maps a 200 to the sent state', async () => {
    FETCH.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    expect(await resendConfirmationEmail('creator@example.com')).toEqual({
      phase: 'sent',
    });
  });

  it('maps a 429 to the cooldown state with the route message', async () => {
    FETCH.mockResolvedValueOnce(
      jsonResponse(429, { error: 'resend_cooldown', message: 'Wait 60 seconds.' }),
    );
    expect(await resendConfirmationEmail('creator@example.com')).toEqual({
      phase: 'cooldown',
      message: 'Wait 60 seconds.',
    });
  });

  it('maps a 503 email_send_failed to the clean-retry state with the route message', async () => {
    FETCH.mockResolvedValueOnce(
      jsonResponse(503, {
        error: 'email_send_failed',
        message: 'We could not send the confirmation email right now — try again shortly.',
      }),
    );
    const state = await resendConfirmationEmail('creator@example.com');
    expect(state.phase).toBe('failed');
    expect(state.phase === 'failed' && state.message).toContain('try again shortly');
  });

  it('maps an unclassifiable failure to the generic clean-retry message', async () => {
    FETCH.mockResolvedValueOnce(jsonResponse(500, { error: 'internal_error' }));
    const state = await resendConfirmationEmail('creator@example.com');
    expect(state.phase).toBe('failed');
    expect(state.phase === 'failed' && state.message).toContain('could not be sent');
  });

  it('maps a transport failure to the clean-retry state — never thrown', async () => {
    FETCH.mockRejectedValueOnce(new TypeError('network down'));
    const state = await resendConfirmationEmail('creator@example.com');
    expect(state.phase).toBe('failed');
    expect(state.phase === 'failed' && state.message).toContain('could not reach');
  });

  it('renders nothing from a garbage body — the generic line stands in', async () => {
    FETCH.mockResolvedValueOnce(new Response('<html>', { status: 502 }));
    const state = await resendConfirmationEmail('creator@example.com');
    expect(state.phase).toBe('failed');
    expect(state.phase === 'failed' && state.message).not.toContain('<html>');
  });
});
