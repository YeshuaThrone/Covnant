'use client';

import { useEffect, useState } from 'react';

import {
  resendConfirmationEmail,
  type ConfirmationResendState,
} from '@/components/auth/confirmationResend';

/*
 * The check-your-email step — the state machine between the signup 201 and
 * the confirmation link, the email-verification path's hold screen (the
 * founder's active signup verification, directive 2026-10-02). The account
 * ALREADY exists (born unconfirmed): the creator's only session path is the
 * confirmation link completing at /auth/callback, so every branch here is a
 * hold state — there is nothing to navigate to until the email link is
 * opened.
 *
 * The rendering follows the entry composition's statement voice: champagne
 * mono statements, no boxes, no error chrome. The Resend control is
 * disabled for the server-enforced 60s cooldown (the client countdown is
 * cosmetic; the route re-rejects early asks).
 */

/* Mirrors the entry composition's treatment exactly. */
const STATEMENT_CLASS = 'mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne';
const LINE_CLASS = 'mt-2 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne';
const BUTTON_BASE_CLASS =
  'h-10 w-64 bg-transparent font-mono text-sm uppercase tracking-[0.3em] transition-colors duration-200';

const RESEND_COOLDOWN_SECONDS = 60;

export function CheckYourEmail({ email }: { email: string }) {
  // The resend lifecycle. The first email already went out with the signup
  // itself — the control starts in the sent state.
  const [resend, setResend] = useState<ConfirmationResendState>({ phase: 'sent' });
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    if (cooldown <= 0) {
      return;
    }
    const timer = setTimeout(() => setCooldown((current) => current - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const handleResend = async () => {
    setResend({ phase: 'sending' });
    const state = await resendConfirmationEmail(email);
    setResend(state);
    if (state.phase === 'sent') {
      setCooldown(RESEND_COOLDOWN_SECONDS);
    }
  };

  const isResending = resend.phase === 'sending';
  const isHold = cooldown > 0 || isResending;

  const buttonClass = [
    BUTTON_BASE_CLASS,
    isHold
      ? 'cursor-wait text-gold-champagne/50'
      : 'cursor-pointer text-gold-champagne/90 hover:text-gold-champagne focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-gold-champagne',
  ].join(' ');

  return (
    <div className="flex flex-col items-center" aria-live="polite">
      <p className={STATEMENT_CLASS}>Check your email</p>
      <p className={LINE_CLASS}>A confirmation link is waiting at {email}</p>

      {/* The contract branches, in the statement voice — sent is the resting
          state; cooldown names the wait; the quota/transport failure renders
          the route's clean-retry line (a reported state, never a wall). */}
      {resend.phase === 'sent' && (
        <p className={LINE_CLASS}>Open the link to finish signing in</p>
      )}
      {resend.phase === 'failed' && <p className={LINE_CLASS}>{resend.message}</p>}
      {cooldown > 0 ? (
        <p className={LINE_CLASS}>
          {resend.phase === 'cooldown' && resend.message !== null
            ? resend.message
            : 'Hold on — a new email can be sent in a minute'}
        </p>
      ) : null}

      <button
        type="button"
        disabled={isHold}
        onClick={() => {
          void handleResend();
        }}
        className={buttonClass}
      >
        {isResending ? 'Sending…' : 'Resend Email'}
      </button>
      <div className="gold-rule w-64" />
    </div>
  );
}
