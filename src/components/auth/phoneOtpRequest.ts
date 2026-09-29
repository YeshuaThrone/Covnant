/**
 * The phone OTP step's request layer — pure, node-testable helpers that map
 * the canonical OTP route responses onto renderable states (the
 * signupRequest.ts pattern, for the verification step). The component holds
 * no fetch logic; every branch here is a state the step can render.
 *
 * Fail-open by construction: a delivery that could not happen is a
 * `sent:false` STATE — never an error wall — and every transport failure is
 * a retryable state, because the account already exists (the signup 201
 * preceded this step) and /agent is one Skip away.
 */

/** The request step's renderable states — one at a time. */
export type OtpSendState =
  | { phase: 'sending' }
  | { phase: 'sent'; delivered: boolean; deliveredVia: string | null }
  | { phase: 'cooldown' }
  | { phase: 'failed'; message: string };

/** The verify submit's renderable states. */
export type OtpVerifyState =
  | { phase: 'idle' }
  | { phase: 'verifying' }
  | { phase: 'rejected'; message: string }
  | { phase: 'retry'; message: string };

/** What a failed verify submission renders — never idle/verifying. */
export type OtpRejection = Exclude<OtpVerifyState, { phase: 'idle' | 'verifying' }>;

/** The generic no-enumeration request body either way — { email, phone }. */
export function buildOtpRequestBody(email: string, phone: string): string {
  return JSON.stringify({ email, phone });
}

/**
 * Request (or re-request) a code: POST /api/covnant/auth/phone/otp.
 * A 200 carries delivered/deliveredVia (delivery itself is best-effort);
 * a 429 is the server-enforced cooldown; anything else is a clean-retry
 * state. Transport failures surface as the retry state, never thrown.
 */
export async function requestOtpCode(
  email: string,
  phone: string,
): Promise<OtpSendState> {
  try {
    const response = await fetch('/api/covnant/auth/phone/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: buildOtpRequestBody(email, phone),
      cache: 'no-store',
    });
    if (response.status === 429) {
      return { phase: 'cooldown' };
    }
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { delivered?: unknown; deliveredVia?: unknown }
        | null;
      const delivered = body?.delivered === true;
      const deliveredVia = typeof body?.deliveredVia === 'string' ? body.deliveredVia : null;
      return { phase: 'sent', delivered, deliveredVia };
    }
    return {
      phase: 'failed',
      message: 'Phone verification could not be requested — you can still continue.',
    };
  } catch {
    return {
      phase: 'failed',
      message: 'We could not reach the verification service — you can still continue.',
    };
  }
}

/** The 6-digit shape the verify route accepts (whitespace-tolerant). */
export function normalizeCodeInput(raw: string): string | null {
  const code = raw.trim();
  return /^\d{6}$/.test(code) ? code : null;
}

/**
 * Submit a 6-digit code: POST /api/covnant/auth/phone/verify. Success is
 * { ok: true }; every rejection carries the route's plain-language message
 * (wrong code / used / expired / too many attempts); a 429 is the retry
 * state. The code never leaves this call in any state.
 */
export async function submitOtpCode(
  email: string,
  code: string,
): Promise<{ ok: true } | { ok: false; state: OtpRejection }> {
  try {
    const response = await fetch('/api/covnant/auth/phone/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code }),
      cache: 'no-store',
    });
    if (response.ok) {
      return { ok: true };
    }
    const body = (await response.json().catch(() => null)) as
      | { code?: unknown; message?: unknown }
      | null;
    if (response.status === 429) {
      return {
        ok: false,
        state: { phase: 'retry', message: 'Too many attempts — wait a minute and try again' },
      };
    }
    const message =
      typeof body?.message === 'string' && body.message.trim() !== '' ? body.message : null;
    return {
      ok: false,
      state: message
        ? { phase: 'rejected', message }
        : { phase: 'retry', message: 'That code could not be checked — try again in a moment' },
    };
  } catch {
    return {
      ok: false,
      state: {
        phase: 'retry',
        message: 'We could not reach the verification service — try again in a moment',
      },
    };
  }
}

/** The session's phone-verification status from /api/covnant/me. */
export type VerifyLaterStatus =
  | { phase: 'unknown' }
  | { phase: 'verified' }
  | { phase: 'unverified'; email: string; phone: string };

/**
 * Read /api/covnant/me and decide whether the verify-later prompt applies:
 * a session profile with a phone on file that is still unverified. Any
 * failure (not signed in, /me down, no phone) renders nothing — the prompt
 * is an offer, never an interruption.
 */
export async function readVerifyLaterStatus(): Promise<VerifyLaterStatus> {
  try {
    const response = await fetch('/api/covnant/me', { cache: 'no-store' });
    if (!response.ok) {
      return { phase: 'unknown' };
    }
    const body = (await response.json().catch(() => null)) as
      | { profile?: { email?: unknown; phone?: unknown; phone_verified_at?: unknown } }
      | null;
    const profile = body?.profile;
    if (
      profile === undefined ||
      profile === null ||
      profile.phone_verified_at !== null ||
      typeof profile.email !== 'string' ||
      profile.email.trim() === '' ||
      typeof profile.phone !== 'string' ||
      profile.phone.trim() === ''
    ) {
      return { phase: 'unknown' };
    }
    return { phase: 'unverified', email: profile.email, phone: profile.phone };
  } catch {
    return { phase: 'unknown' };
  }
}
