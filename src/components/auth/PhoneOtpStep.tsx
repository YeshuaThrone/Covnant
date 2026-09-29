'use client';

import { useEffect, useRef, useState } from 'react';

import {
  normalizeCodeInput,
  requestOtpCode,
  submitOtpCode,
  type OtpSendState,
} from '@/components/auth/phoneOtpRequest';

/*
 * The phone verification step — the state machine between the signup 201 and
 * /agent, and the same surface the /agent verify-later prompt reuses. The
 * account ALREADY exists: this step can only enrich it, so every exit path
 * (verified, skip, delivery failure) still reaches /agent with the phone
 * possibly unverified — the spec's fail-open funnel invariant.
 *
 * The rendering follows the entry composition's statement voice: champagne
 * mono statements, chromeless centered input over a golden ruler, no boxes,
 * no error chrome. A wrong code renders the route's plain-language line —
 * never jargon. The Resend control is disabled for the server-enforced 60s
 * cooldown (the client countdown is cosmetic; the route re-rejects early).
 */

/* Mirrors the entry composition's treatment exactly. */
const STATEMENT_CLASS = 'mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne';
const LINE_CLASS = 'mt-2 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne';
const CODE_INPUT_CLASS =
  'h-10 w-64 cursor-text bg-transparent text-center text-lg tracking-[0.5em] text-emerald-300 caret-amber-400/70 outline-none';
const BUTTON_BASE_CLASS =
  'h-10 w-64 bg-transparent font-mono text-sm uppercase tracking-[0.3em] transition-colors duration-200';

const RESEND_COOLDOWN_SECONDS = 60;

export function PhoneOtpStep({
  email,
  phone,
  onDone,
}: {
  email: string;
  phone: string;
  onDone: () => void;
}) {
  // The send lifecycle: the first code fires on mount (the step arrives with
  // the captured email + phone — no second entry needed).
  const [send, setSend] = useState<OtpSendState>({ phase: 'sending' });
  const [code, setCode] = useState('');
  const [verifyLine, setVerifyLine] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  const requestCode = async () => {
    setSend({ phase: 'sending' });
    setVerifyLine(null);
    const state = await requestOtpCode(email, phone);
    setSend(state);
    if (state.phase === 'cooldown' || state.phase === 'sent') {
      setCooldown(RESEND_COOLDOWN_SECONDS);
    }
    if (state.phase === 'sent') {
      codeRef.current?.focus();
    }
  };

  // First code on mount — the step IS the request.
  useEffect(() => {
    void requestCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cosmetic countdown for the Resend control; the server re-rejects early
  // asks regardless of what this renders.
  useEffect(() => {
    if (cooldown === 0) return;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const handleSubmitCode = async () => {
    if (verifying) return;
    const cleaned = normalizeCodeInput(code);
    if (cleaned === null) {
      setVerifyLine('Enter the six digits from the message');
      return;
    }
    setVerifying(true);
    setVerifyLine(null);
    const result = await submitOtpCode(email, cleaned);
    if (result.ok) {
      onDone(); // auto-advance — the funnel never stops here
      return;
    }
    setVerifying(false);
    setVerifyLine(result.state.message);
  };

  const isSending = send.phase === 'sending';
  const resending = cooldown > 0 || isSending;

  return (
    <div>
      <p className={STATEMENT_CLASS}>Verify your phone</p>
      <p className={LINE_CLASS}>We sent a six-digit code to {phone}</p>

      {send.phase === 'sent' && !send.delivered && (
        <p className={LINE_CLASS}>
          We could not reach a phone line just now — you can verify later from your workspace
        </p>
      )}
      {send.phase === 'failed' && <p className={LINE_CLASS}>{send.message}</p>}
      {send.phase === 'cooldown' && (
        <p className={LINE_CLASS}>Hold on — a new code can be requested in a minute</p>
      )}
      {verifyLine !== null && <p className={LINE_CLASS}>{verifyLine}</p>}

      <input
        ref={codeRef}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="Verification code"
        maxLength={6}
        value={code}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
        className={CODE_INPUT_CLASS}
      />
      <div className="gold-rule w-64" />

      <button
        type="button"
        disabled={verifying}
        onClick={() => void handleSubmitCode()}
        className={`${BUTTON_BASE_CLASS} ${
          verifying
            ? 'cursor-wait text-gold-champagne/50'
            : 'cursor-pointer text-gold-champagne/90 hover:text-gold-champagne focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold-champagne'
        }`}
      >
        {verifying ? 'Checking…' : 'Verify'}
      </button>
      <div className="gold-rule w-64" />

      <button
        type="button"
        disabled={resending}
        onClick={() => void requestCode()}
        className={`${BUTTON_BASE_CLASS} ${
          resending
            ? 'cursor-wait text-gold-champagne/50'
            : 'cursor-pointer text-gold-champagne/90 hover:text-gold-champagne focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold-champagne'
        }`}
      >
        {isSending ? 'Sending…' : resending ? `Resend in ${cooldown}s` : 'Resend'}
      </button>

      <button
        type="button"
        onClick={onDone}
        className="mt-8 cursor-pointer bg-transparent font-mono text-sm uppercase tracking-[0.3em] text-white/40 underline-offset-4 hover:text-gold-champagne focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold-champagne"
      >
        Skip for now — verify later
      </button>
      <div className="gold-rule w-64" />
    </div>
  );
}
