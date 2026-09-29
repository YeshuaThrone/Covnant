'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import {
  buildSignupPayload,
  mapSignupResponse,
  networkFailureState,
  type SealRequestState,
  type SealEntryValues,
} from '@/components/landing/signupRequest';

/*
 * Entry composition — the six mirrored entry zones and the Universal
 * Consent & Submit zone, rendered as direct children of the landing section.
 * This is a client island: the submission flow needs state over all six
 * inputs (captured values), which only a client component can own. The
 * rendered markup of every pre-existing zone is byte-identical to the
 * server-rendered version it replaces. A display:contents <form> wraps the
 * zones so native submit semantics (Enter key, submit button) reach the
 * standard onSubmit handler without changing the flex layout — the form's
 * box vanishes and its children remain flex items of the section exactly
 * as before.
 */

/* Field class string — byte-identical to the approved chromeless input
 * across every mirrored zone, and the ONLY input state: fields stay
 * editable before, during, and after a submit attempt. */
const INPUT_CLASS =
  'h-10 w-64 cursor-text bg-transparent text-center text-lg text-emerald-300 caret-amber-400/70 outline-none';

const BUTTON_BASE_CLASS =
  'h-10 w-64 bg-transparent font-mono text-sm uppercase tracking-[0.3em] transition-colors duration-200';

/* The signup response-state lines — the statement voice of the composition,
 * in the same slot. No boxes, no error chrome: the design language of the
 * composition is the rendering for every contract branch. */
const RESPONSE_LINE_CLASS =
  'mt-2 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne';

export function EntryZones() {
  const router = useRouter();
  // The signup request state — one renderable contract branch at a time.
  // The submitting phase doubles as the button's isSubmitting state: the
  // primary button shows a visible loading state and is disabled while the
  // request is in flight, so duplicate submits are impossible.
  const [request, setRequest] = useState<SealRequestState>({ phase: 'idle' });
  const submittingRef = useRef(false);
  const stageNameRef = useRef<HTMLInputElement>(null);
  const legalNameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const phoneNumberRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const coreIndustryTitleRef = useRef<HTMLInputElement>(null);

  /* Submit the captured values to POST /api/covnant/auth/signup. A
   * successful signup response (201 created / 200 claim-or-repeat) advances
   * immediately to /agent per the founder's auto-advance directive; every
   * failure branch renders its contract state. The submit guard ref stays
   * latched on success (the navigation is one-way — nothing may re-fire)
   * and resets only on a failure the visitor can retry. */
  const submitSignup = async (values: SealEntryValues) => {
    setRequest({ phase: 'submitting' });
    try {
      const response = await fetch('/api/covnant/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildSignupPayload(values)),
        cache: 'no-store',
      });
      if (response.status === 200 || response.status === 201) {
        router.push('/agent');
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      setRequest(mapSignupResponse(response.status, body));
    } catch (error) {
      // Transport failure (offline, connection reset) — render the recovery
      // line. Surfaced as state, never swallowed.
      console.warn('Covnant: the signup could not reach the signup API.', error);
      setRequest(networkFailureState());
    }
    submittingRef.current = false;
  };

  /* Standard form submit — preventDefault, capture the six entries, fire
   * the request. The consent checkbox persists nothing and gates nothing
   * (the contract's udr_terms_accepted is the submit act itself). The
   * ref guard rejects events that slip past the disabled button (Enter in
   * a field during the same tick). */
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;
    const values: SealEntryValues = {
      stageName: stageNameRef.current?.value ?? '',
      legalName: legalNameRef.current?.value ?? '',
      email: emailRef.current?.value ?? '',
      phoneNumber: phoneNumberRef.current?.value ?? '',
      password: passwordRef.current?.value ?? '',
      coreIndustryTitle: coreIndustryTitleRef.current?.value ?? '',
    };
    submittingRef.current = true;
    void submitSignup(values);
  };

  const isSubmitting = request.phase === 'submitting';

  const buttonClass = [
    BUTTON_BASE_CLASS,
    isSubmitting
      ? 'cursor-wait text-gold-champagne/50'
      : 'cursor-pointer text-gold-champagne/90 hover:text-gold-champagne focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold-champagne',
  ].join(' ');

  return (
    <form className="contents" onSubmit={handleSubmit} noValidate>
      {/* Stage Name entry in open black space below the URD zone — NOT a new
          zone. The statement keeps the established 32px top gap; the invisible
          input occupies the EXISTING 40px slot between statement and bottom
          ruler (h-10, zero margins — zero net added height), so the band
          interior stays EXACTLY 92px (32 + 20 + 40) and the bottom ruler sits
          at the approved y. The ruler doubles as the entry area's bottom
          line; nothing follows it. The input is fully chromeless — no
          border, no focus glow, no placeholder; only the typed name
          (hero-subtitle treatment: text-lg text-emerald-300, displayed
          exactly as the artist types it) and the gold caret ever appear.
          cursor-text keeps the invisible field discoverable; accessible via
          aria-label. */}
      <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Stage Name</p>
      <input
        ref={stageNameRef}
        type="text"
        aria-label="Stage Name"
        className={INPUT_CLASS}
      />
      <div className="gold-rule w-64" />

      {/* Legal Name entry zone — a straight mirror of the Stage Name zone.
          The ruler above doubles as this zone's SHARED TOP RULE (untouched,
          same y as approved). The statement repeats the exact champagne mono
          treatment and the same 32px top gap below the shared rule; the
          invisible input repeats the Stage Name field byte-for-byte
          (chromeless h-10 w-64, jade typed text, gold caret, aria-label
          only); a new bottom golden ruler closes the zone HUGGING the input —
          zero margin above it, a true pixel mirror of the Stage Name zone.
          NOTHING follows the ruler — the region below stays empty black
          space. */}
      <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Legal Name</p>
      <input
        ref={legalNameRef}
        type="text"
        aria-label="Legal Name"
        className={INPUT_CLASS}
      />
      <div className="gold-rule w-64" />

      {/* Email entry zone — a straight mirror of the Legal Name zone.
          The ruler above doubles as this zone's SHARED TOP RULE (untouched,
          same y as approved). The statement repeats the exact champagne mono
          treatment and the same 32px top gap below the shared rule; the
          invisible input repeats the Legal Name field byte-for-byte
          (chromeless h-10 w-64, jade typed text, gold caret, aria-label
          only); a new bottom golden ruler closes the zone HUGGING the input —
          zero margin above it, a true pixel mirror of the Legal Name zone.
          NOTHING follows the ruler — the region below stays empty black
          space. */}
      <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Email</p>
      <input
        ref={emailRef}
        type="text"
        aria-label="Email"
        className={INPUT_CLASS}
      />
      <div className="gold-rule w-64" />

      {/* Phone Number entry zone — a straight mirror of the Email zone,
          inserted UNDER the Email zone (amendment 11.2). The ruler above
          doubles as this zone's SHARED TOP RULE (untouched, same y as
          approved). The statement repeats the exact champagne mono treatment
          and the same 32px top gap below the shared rule; the invisible
          input repeats the Email field byte-for-byte (chromeless h-10 w-64,
          jade typed text, gold caret, aria-label only) with NO prefill — it
          opens empty like the other collected fields. Type tel: semantically
          correct for a phone entry, zero styling change. A new bottom golden
          ruler closes the zone HUGGING the input — zero margin above it, a
          true pixel mirror of the Email zone. The Core Industry & Title zone
          follows below this ruler. */}
      <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Phone Number</p>
      <input
        ref={phoneNumberRef}
        type="tel"
        aria-label="Phone Number"
        className={INPUT_CLASS}
      />
      <div className="gold-rule w-64" />

      {/* Core Industry & Title entry zone — a straight mirror of the Email
          zone. The ruler above doubles as this zone's SHARED TOP RULE
          (untouched, same y as approved). The statement repeats the exact
          champagne mono treatment and the same 32px top gap below the
          shared rule; the invisible input repeats the Email field
          byte-for-byte (chromeless h-10 w-64, jade typed text, gold caret,
          aria-label only); a new bottom golden ruler closes the zone HUGGING
          the input — zero margin above it, a true pixel mirror of the Email
          zone. The Password zone follows below this ruler (micro-edit 11
          reorder). */}
      <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Core Industry &amp; Title</p>
      <input
        ref={coreIndustryTitleRef}
        type="text"
        aria-label="Core Industry & Title"
        className={INPUT_CLASS}
      />
      <div className="gold-rule w-64" />

      {/* Password entry zone — a straight mirror of the Email zone, MOVED
          here (micro-edit 11) to close the entry column: the visual flow
          collects user data first (Stage Name → Legal Name → Email → Core
          Industry & Title) and closes with security/consent (Password →
          consent → Continue). The ruler above doubles as this zone's SHARED
          TOP RULE (untouched, same y as approved). The statement repeats the
          exact champagne mono treatment and the same 32px top gap below the
          shared rule; the invisible input repeats the Email field
          byte-for-byte and arrives PRE-FILLED with 'Covenant' (exactly 8
          letters) as the delegated starting value — type text so the jade
          letters show; a new bottom golden ruler closes the zone HUGGING the
          input — zero margin above it, a true pixel mirror of the Email
          zone. The consent composition follows below this ruler. */}
      <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Password</p>
      <input
        ref={passwordRef}
        type="text"
        aria-label="Password"
        defaultValue="Covenant"
        className={INPUT_CLASS}
      />
      <div className="gold-rule w-64" />

      {/* Universal Consent & Submit — the final mirrored zone. The ruler
          above doubles as this zone's SHARED TOP RULE (untouched, same y as
          approved). The wide agreement statement was replaced (micro-edit
          11) by a native consent checkbox + 'Accept UDR Terms' label: the
          label carries the EXACT statement treatment (mt-8 font-mono
          text-sm uppercase tracking-[0.3em] text-gold-champagne), keeping
          the 32px gap and mono voice of the statements it joins; the
          checkbox is the native box — champagne accent-color, focus-visible
          gold outline matching the Continue pattern, no added chrome —
          unchecked by default, persisting nothing, NOT part of the payload,
          and the submit flow is NOT gated on it. In the input slot: the
          'Continue' button, a BORDERLESS pressable label — no box, no
          hairline (the label brightens on hover so it reads as pressable;
          focus-visible gold outline for keyboard access). A standard
          single-click submit: pressing it fires the form's onSubmit with
          everything the visitor wrote; while the request is in flight the
          button shows its loading state, dims, and is disabled — duplicate
          submits are impossible. A new bottom golden ruler closes the zone
          HUGGING the button — zero margin above it. NOTHING follows the
          ruler — the region below stays empty black space. */}
      <div className="flex items-center justify-center gap-3">
        <input
          type="checkbox"
          id="udr-terms"
          className="mt-8 h-4 w-4 shrink-0 cursor-pointer accent-gold-champagne focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold-champagne"
        />
        <label
          htmlFor="udr-terms"
          className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne"
        >
          Accept UDR Terms
        </label>
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className={buttonClass}
      >
        {isSubmitting ? 'Submitting…' : 'Continue'}
      </button>

      {/* The signup response state — one contract branch at a time, rendered
          in the statement voice INSIDE the closing composition above the
          final ruler. No boxes, no error chrome: the composition's design
          language renders every branch. Success never renders here — a
          successful signup response navigates to /agent immediately; the
          failure branches (duplicate, coded validation, rate limit,
          fail-closed recovery) are what a visitor can still be looking
          at. */}
      {request.phase === 'duplicate' && (
        <p className={RESPONSE_LINE_CLASS}>
          An account with this email already exists — try signing in
        </p>
      )}
      {request.phase === 'invalid' && <p className={RESPONSE_LINE_CLASS}>{request.message}</p>}
      {request.phase === 'rate_limited' && (
        <p className={RESPONSE_LINE_CLASS}>Too many attempts — wait a minute and try again</p>
      )}
      {request.phase === 'failed' && <p className={RESPONSE_LINE_CLASS}>{request.message}</p>}
      <div className="gold-rule w-64" />
    </form>
  );
}
