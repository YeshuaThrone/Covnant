'use client';

import { useEffect, useState } from 'react';

import { PhoneOtpStep } from '@/components/auth/PhoneOtpStep';
import { readVerifyLaterStatus, type VerifyLaterStatus } from '@/components/auth/phoneOtpRequest';

/*
 * The verify-later prompt — the small /agent surface for creators who skipped
 * phone verification at signup (or whose delivery failed). It is an OFFER,
 * never an interruption: it renders nothing unless the session profile has a
 * phone on file that is still unverified, and dismissing it persists nothing.
 * The code request fires only when the creator opts in — expanding mounts the
 * exact signup step (same component, same routes), per the spec.
 */
export function VerifyPhonePrompt() {
  const [status, setStatus] = useState<VerifyLaterStatus>({ phase: 'unknown' });
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void readVerifyLaterStatus().then(setStatus);
  }, []);

  if (dismissed || status.phase !== 'unverified') {
    return null;
  }

  if (expanded) {
    return (
      <div className="mt-8 border border-gold-champagne/30 p-6">
        <PhoneOtpStep
          email={status.email}
          phone={status.phone}
          onDone={() => setStatus({ phase: 'verified' })}
        />
      </div>
    );
  }

  return (
    <div className="mt-8 border border-gold-champagne/30 p-6">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold-champagne">
        Verify your phone
      </p>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        Your number {status.phone} is still unverified. Verifying it keeps your rights-holder
        profile complete — you can also skip this and continue.
      </p>
      <div className="mt-4 flex gap-6">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="cursor-pointer bg-transparent font-mono text-xs uppercase tracking-[0.3em] text-gold-champagne hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold-champagne"
        >
          Verify now
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="cursor-pointer bg-transparent font-mono text-xs uppercase tracking-[0.3em] text-white/40 hover:text-white/70 focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold-champagne"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
