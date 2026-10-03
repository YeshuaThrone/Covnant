/**
 * The confirmation-email step's request layer — the phoneOtpRequest.ts
 * pattern (pure, node-testable, one renderable state per branch) for the
 * founder's active signup verification path: re-sending the signup
 * confirmation email. The component holds no fetch logic.
 *
 * Anti-enumeration all the way down: the 200 body is `{ ok: true }`
 * regardless of whether the address has an account, and no branch renders
 * anything the response could have leaked.
 */

/** The resend control's renderable states — one at a time. */
export type ConfirmationResendState =
  | { phase: 'sending' }
  | { phase: 'sent' }
  | { phase: 'cooldown'; message: string | null }
  | { phase: 'failed'; message: string };

/**
 * Re-request the confirmation email: POST
 * /api/covnant/auth/confirmation/resend. A 200 is the generic sent state;
 * a 429 is the server-enforced cooldown (route reason: per-IP rate_limited
 * or the per-address resend_cooldown); a 503 email_send_failed is the
 * clean-retry state (built-in SMTP quota — reported, never worked around);
 * transport failures surface as the retry state, never thrown.
 */
export async function resendConfirmationEmail(
  email: string,
): Promise<ConfirmationResendState> {
  try {
    const response = await fetch('/api/covnant/auth/confirmation/resend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
      cache: 'no-store',
    });
    const body = (await response.json().catch(() => null)) as
      | { message?: unknown }
      | null;
    const message =
      typeof body?.message === 'string' && body.message.trim() !== ''
        ? body.message
        : null;
    if (response.status === 429) {
      return { phase: 'cooldown', message };
    }
    if (response.ok) {
      return { phase: 'sent' };
    }
    return {
      phase: 'failed',
      message: message ?? 'The confirmation email could not be sent — try again shortly.',
    };
  } catch {
    return {
      phase: 'failed',
      message: 'We could not reach the verification service — try again shortly.',
    };
  }
}
