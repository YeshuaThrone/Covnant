'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import {
  buildSignupPayload,
  extractSignupSession,
  mapSignupResponse,
  networkFailureState,
  type ProvisioningStatus,
  type SealRequestState,
} from '@/components/landing/signupRequest';
import { adoptSignupSession } from '@/lib/auth/sessionCapture';

/*
 * Entry composition — the six mirrored entry zones and the Universal
 * Consent & Seal zone, rendered as direct children of the landing section.
 * This is a client island: the seal interaction needs state over all six
 * inputs (readOnly freezing, value rehydration), which only a client
 * component can own. The rendered markup of every pre-existing zone is
 * byte-identical to the server-rendered version it replaces.
 */

const SEALED_ENTRY_KEY = 'covnant.sealedEntry';

type SealedEntryValues = {
  stageName: string;
  legalName: string;
  email: string;
  phoneNumber: string;
  password: string;
  coreIndustryTitle: string;
};

type SealedEntry = { sealed: true; values: SealedEntryValues };

const isSealedEntry = (value: unknown): value is SealedEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { sealed?: unknown; values?: unknown };
  if (candidate.sealed !== true || typeof candidate.values !== 'object' || candidate.values === null) {
    return false;
  }
  const values = candidate.values as Record<string, unknown>;
  // Every CURRENT value key must be present — a legacy seal missing any of
  // them (e.g. a pre-Phone-Number seal) fails the guard and is treated as
  // absent: the composition starts unsealed rather than half-restoring.
  return (
    typeof values.stageName === 'string' &&
    typeof values.legalName === 'string' &&
    typeof values.email === 'string' &&
    typeof values.phoneNumber === 'string' &&
    typeof values.password === 'string' &&
    typeof values.coreIndustryTitle === 'string'
  );
};

/* Reads the persisted seal state. Corrupt or tampered local storage is
 * treated as unsealed on purpose — the landing page must never break because
 * of local data. */
function readSealedEntry(): SealedEntry | null {
  try {
    const raw = window.localStorage.getItem(SEALED_ENTRY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSealedEntry(parsed) ? parsed : null;
  } catch {
    // Invalid JSON — same policy: show the unsealed composition.
    return null;
  }
}

/* Unsealed field class string — byte-identical to the approved chromeless
 * input across every mirrored zone. The sealed variant swaps ONLY the cursor
 * and the caret: jade styling, geometry, and invisibility are untouched. */
const UNSEALED_INPUT_CLASS =
  'h-10 w-64 cursor-text bg-transparent text-center text-lg text-emerald-300 caret-amber-400/70 outline-none';
const SEALED_INPUT_CLASS =
  'h-10 w-64 cursor-default bg-transparent text-center text-lg text-emerald-300 caret-transparent outline-none';

const BUTTON_BASE_CLASS =
  'h-10 w-64 bg-transparent font-mono text-sm uppercase tracking-[0.3em] transition-colors duration-200';

/* The signup response-state lines — the exact statement voice of the unseal
 * hint, in the same slot. No boxes, no error chrome: the design language of
 * the composition is the rendering for every contract branch. */
const RESPONSE_LINE_CLASS =
  'mt-2 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne';

/* The provisioning status, stated in the composition's fragment voice. */
function provisioningLine(status: ProvisioningStatus): string {
  return status === 'PROVISIONED' ? 'Provisioning complete' : 'Provisioning queued';
}

export function EntryZones() {
  const [sealed, setSealed] = useState(false);
  // The signup request state — one renderable contract branch at a time.
  // sealedRef mirrors `sealed` for the async completion: the unseal escape
  // hatch stays live mid-flight, and a response that outlives its unsealed
  // composition is discarded rather than rendered into it.
  const [request, setRequest] = useState<SealRequestState>({ phase: 'idle' });
  const sealedRef = useRef(false);
  const stageNameRef = useRef<HTMLInputElement>(null);
  const legalNameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const phoneNumberRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const coreIndustryTitleRef = useRef<HTMLInputElement>(null);

  // Rehydrate the sealed composition once on mount — localStorage is only
  // reachable client-side, after hydration.
  useEffect(() => {
    const entry = readSealedEntry();
    if (!entry) return;
    const saved = [
      entry.values.stageName,
      entry.values.legalName,
      entry.values.email,
      entry.values.phoneNumber,
      entry.values.password,
      entry.values.coreIndustryTitle,
    ];
    const refs = [
      stageNameRef,
      legalNameRef,
      emailRef,
      phoneNumberRef,
      passwordRef,
      coreIndustryTitleRef,
    ];
    refs.forEach((ref, index) => {
      if (ref.current) ref.current.value = saved[index];
    });
    setSealed(true);
  }, []);

  /* Submit the sealed values to POST /api/covnant/auth/signup and map the
   * response to a renderable contract state. The local seal record is
   * already written by the time this runs — it stays the offline/fallback
   * record of the seal regardless of the network outcome. A response is
   * rendered only if the composition is still sealed (unsealing mid-flight
   * abandons the attempt's rendering). */
  const submitSignup = async (values: SealedEntryValues) => {
    setRequest({ phase: 'submitting' });
    try {
      const response = await fetch('/api/covnant/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildSignupPayload(values)),
        cache: 'no-store',
      });
      const body: unknown = await response.json().catch(() => null);
      if (!sealedRef.current) return;
      setRequest(mapSignupResponse(response.status, body));
      // The 201 session-capture point: when the creating response carries a
      // Supabase session, adopt it in the browser so the creator reaches
      // /dashboard signed in (the continue affordance renders in the
      // created state). Captured only while the composition stays sealed.
      if (sealedRef.current) {
        const session = extractSignupSession(body);
        if (session) void adoptSignupSession(session);
      }
    } catch (error) {
      // Transport failure (offline, connection reset) — the composition is
      // still sealed; render the recovery line. Surfaced as state, never
      // swallowed.
      console.warn('Covnant: the seal could not reach the signup API.', error);
      if (!sealedRef.current) return;
      setRequest(networkFailureState());
    }
  };

  /* Seal: persist the six entries locally and freeze the fields, then
   * submit the same values to the signup API — the local record is written
   * FIRST, so the offline/fallback record exists even when the network
   * fails. Idempotent — a second click on an already-sealed composition
   * changes nothing (the retry path is the unseal escape hatch, then
   * Submit again). */
  const sealWorld = () => {
    if (sealed) return;
    const entry: SealedEntry = {
      sealed: true,
      values: {
        stageName: stageNameRef.current?.value ?? '',
        legalName: legalNameRef.current?.value ?? '',
        email: emailRef.current?.value ?? '',
        phoneNumber: phoneNumberRef.current?.value ?? '',
        password: passwordRef.current?.value ?? '',
        coreIndustryTitle: coreIndustryTitleRef.current?.value ?? '',
      },
    };
    try {
      window.localStorage.setItem(SEALED_ENTRY_KEY, JSON.stringify(entry));
    } catch (error) {
      // Blocked or full storage: refuse to half-seal (values would not
      // survive a refresh) — surface the reason and stay editable.
      console.warn('Covnant: the entry could not be sealed locally.', error);
      return;
    }
    setSealed(true);
    sealedRef.current = true;
    void submitSignup(entry.values);
  };

  const inputClass = sealed ? SEALED_INPUT_CLASS : UNSEALED_INPUT_CLASS;

  /* Unseal: the escape hatch for a sealed composition — a double-click on
   * the sealed button clears the local seal so the fields become editable
   * again and the button returns to its bright pressable state. Local only;
   * the next single click re-seals as normal. */
  const unsealWorld = () => {
    try {
      window.localStorage.removeItem(SEALED_ENTRY_KEY);
    } catch (error) {
      // Blocked storage never persisted the seal in the first place —
      // clearing the in-memory state still frees the fields; surface why
      // the key may reappear on a future seal.
      console.warn('Covnant: the local seal could not be cleared.', error);
    }
    setSealed(false);
    sealedRef.current = false;
    // The rendered response state described the sealed attempt — clear it
    // with the seal so an unsealed composition starts clean.
    setRequest({ phase: 'idle' });
  };

  const buttonClass = [
    BUTTON_BASE_CLASS,
    sealed
      ? 'cursor-default text-gold-champagne/50'
      : 'cursor-pointer text-gold-champagne/90 hover:text-gold-champagne focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold-champagne',
  ].join(' ');

  return (
    <>
      {/* Stage Name entry in open black space below the URD zone — NOT a new
          zone. The statement keeps the established 32px top gap; the invisible
          input occupies the EXISTING 40px slot between statement and bottom
          ruler (h-10, zero margins — zero net added height), so the band
          interior stays EXACTLY 92px (32 + 20 + 40) and the bottom ruler sits
          at the approved y. The ruler doubles as the entry area's bottom
          line; nothing follows it. The input is fully chromeless at every
          state — no border, no focus glow, no placeholder; only the typed
          name (hero-subtitle treatment: text-lg text-emerald-300, displayed
          exactly as the artist types it) and the gold caret ever appear.
          cursor-text keeps the invisible field discoverable; accessible via
          aria-label. */}
      <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Stage Name</p>
      <input
        ref={stageNameRef}
        type="text"
        aria-label="Stage Name"
        className={inputClass}
        readOnly={sealed}
      />
      <div className="gold-rule w-64" />

      {/* Legal Name entry zone — a straight mirror of the Stage Name zone.
          The ruler above doubles as this zone's SHARED TOP RULE (untouched,
          same y as approved). The statement repeats the exact champagne mono
          treatment and the same 32px top gap below the shared rule; the
          invisible input repeats the Stage Name field byte-for-byte
          (chromeless h-10 w-64, jade typed text, gold caret, aria-label
          only, local-only — no submission wiring); a new bottom golden
          ruler closes the zone HUGGING the input — zero margin above it,
          a true pixel mirror of the Stage Name zone. NOTHING follows the
          ruler — the region below stays empty black space. */}
      <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Legal Name</p>
      <input
        ref={legalNameRef}
        type="text"
        aria-label="Legal Name"
        className={inputClass}
        readOnly={sealed}
      />
      <div className="gold-rule w-64" />

      {/* Email entry zone — a straight mirror of the Legal Name zone.
          The ruler above doubles as this zone's SHARED TOP RULE (untouched,
          same y as approved). The statement repeats the exact champagne mono
          treatment and the same 32px top gap below the shared rule; the
          invisible input repeats the Legal Name field byte-for-byte
          (chromeless h-10 w-64, jade typed text, gold caret, aria-label
          only, local-only — no email validation, no submission wiring); a
          new bottom golden ruler closes the zone HUGGING the input — zero
          margin above it, a true pixel mirror of the Legal Name zone.
          NOTHING follows the ruler — the region below stays empty black
          space. */}
      <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Email</p>
      <input
        ref={emailRef}
        type="text"
        aria-label="Email"
        className={inputClass}
        readOnly={sealed}
      />
      <div className="gold-rule w-64" />

      {/* Phone Number entry zone — a straight mirror of the Email zone,
          inserted UNDER the Email zone (amendment 11.2). The ruler above
          doubles as this zone's SHARED TOP RULE (untouched, same y as
          approved). The statement repeats the exact champagne mono treatment
          and the same 32px top gap below the shared rule; the invisible
          input repeats the Email field byte-for-byte (chromeless h-10 w-64,
          jade typed text, gold caret, aria-label only, local-only — no
          validation, no submission wiring) with NO prefill — it opens empty
          like the other collected fields. Type tel: semantically correct for
          a phone entry, zero styling change. A new bottom golden ruler
          closes the zone HUGGING the input — zero margin above it, a true
          pixel mirror of the Email zone. The Core Industry & Title zone
          follows below this ruler. */}
      <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Phone Number</p>
      <input
        ref={phoneNumberRef}
        type="tel"
        aria-label="Phone Number"
        className={inputClass}
        readOnly={sealed}
      />
      <div className="gold-rule w-64" />

      {/* Core Industry & Title entry zone — a straight mirror of the Email
          zone. The ruler above doubles as this zone's SHARED TOP RULE
          (untouched, same y as approved). The statement repeats the exact
          champagne mono treatment and the same 32px top gap below the
          shared rule; the invisible input repeats the Email field
          byte-for-byte (chromeless h-10 w-64, jade typed text, gold caret,
          aria-label only, local-only — no validation, no submission
          wiring); a new bottom golden ruler closes the zone HUGGING the
          input — zero margin above it, a true pixel mirror of the Email
          zone. The Password zone follows below this ruler (micro-edit 11
          reorder). */}
      <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Core Industry &amp; Title</p>
      <input
        ref={coreIndustryTitleRef}
        type="text"
        aria-label="Core Industry & Title"
        className={inputClass}
        readOnly={sealed}
      />
      <div className="gold-rule w-64" />

      {/* Password entry zone — a straight mirror of the Email zone, MOVED
          here (micro-edit 11) to close the entry column: the visual flow
          collects user data first (Stage Name → Legal Name → Email → Core
          Industry & Title) and closes with security/consent (Password →
          consent → Submit). The ruler above doubles as this zone's SHARED
          TOP RULE (untouched, same y as approved). The statement repeats the
          exact champagne mono treatment and the same 32px top gap below the
          shared rule; the invisible input repeats the Email field
          byte-for-byte and arrives PRE-FILLED with 'Covenant' (exactly 8
          letters) as the delegated starting value — type text so the jade
          letters show, and the field stays fully editable until the seal; a
          new bottom golden ruler closes the zone HUGGING the input — zero
          margin above it, a true pixel mirror of the Email zone. The consent
          composition follows below this ruler. */}
      <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Password</p>
      <input
        ref={passwordRef}
        type="text"
        aria-label="Password"
        defaultValue="Covenant"
        className={inputClass}
        readOnly={sealed}
      />
      <div className="gold-rule w-64" />

      {/* Universal Consent & Seal — the final mirrored zone. The ruler
          above doubles as this zone's SHARED TOP RULE (untouched, same y as
          approved). The wide agreement statement was replaced (micro-edit
          11) by a native consent checkbox + 'Accept UDR Terms' label: the
          label carries the EXACT statement treatment (mt-8 font-mono
          text-sm uppercase tracking-[0.3em] text-gold-champagne), keeping
          the 32px gap and mono voice of the statements it joins; the
          checkbox is the native box — champagne accent-color, focus-visible
          gold outline matching the Submit pattern, no added chrome —
          unchecked by default, persisting nothing, NOT part of the seal
          payload, and the seal flow is NOT gated on it. In the
          input slot: the 'Submit' button, a BORDERLESS pressable label —
          no box, no hairline (the label brightens on hover so it reads as
          pressable; focus-visible gold outline for keyboard access).
          Clicking seals EVERYTHING the visitor
          wrote: all six entries are captured to localStorage and frozen
          readOnly with the jade styling kept and the caret suppressed; the
          button reads SEALED while it dims slightly (with a native
          'Double-click to unseal' tooltip) and ONE hint line — the exact
          statement voice (mono, uppercase, 0.3em tracking, champagne) —
          appears DIRECTLY BENEATH it reading 'Double-click to unseal',
          making the escape discoverable (amendment 11.1: the tooltip alone
          was invisible on touch and hover-only); the hint exists in the DOM
          ONLY while sealed and sits INSIDE the closing composition above the
          final ruler (zone-content-placement rule). A second single click is
          a no-op; DOUBLE-CLICKING the sealed button UNSEALS — the local key
          is cleared, the fields turn editable again, and the button returns
          to its bright pressable state (a refresh then stays unsealed); a
          refresh of a sealed composition rehydrates it sealed. Local only —
          no POST, no signup
          wiring. A new bottom golden ruler closes the zone HUGGING the
          button — zero margin above it. NOTHING follows the ruler — the
          region below stays empty black space. */}
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
        type="button"
        onClick={sealWorld}
        onDoubleClick={sealed ? unsealWorld : undefined}
        title={sealed ? 'Double-click to unseal' : undefined}
        className={buttonClass}
      >
        {sealed ? 'SEALED' : 'Submit'}
      </button>
      {sealed && (
        <p className="mt-2 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">
          Double-click to unseal
        </p>
      )}

      {/* The signup response state — one contract branch at a time, rendered
          in the statement voice INSIDE the closing composition above the
          final ruler (the unseal hint's slot discipline). No boxes, no error
          chrome: the composition's design language renders every branch.
          The created state leads with the primary next step (check-your-
          inbox when session-less, per the contract), discloses the UCT once,
          and states provisioning; the 200 repeat never renders a UCT or a
          retry-the-UCT affordance; the 409 routes to sign-in framing. */}
      {request.phase === 'submitting' && (
        <p className={RESPONSE_LINE_CLASS}>Sealing your entry</p>
      )}
      {request.phase === 'created' && (
        <>
          {request.sessionless && (
            <p className={RESPONSE_LINE_CLASS}>Check your inbox to activate your account</p>
          )}
          {request.uct !== null && (
            <p className={RESPONSE_LINE_CLASS}>Your Covnant Tag {request.uct}</p>
          )}
          <p className={RESPONSE_LINE_CLASS}>{provisioningLine(request.provisioning)}</p>
          {!request.sessionless && (
            <p className={RESPONSE_LINE_CLASS}>Your account is live — you are signed in</p>
          )}
          {!request.sessionless && (
            <Link
              href="/dashboard"
              data-testid="signup-continue"
              className="mt-2 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold-champagne"
            >
              Continue to your world
            </Link>
          )}
        </>
      )}
      {request.phase === 'repeat' && (
        <>
          <p className={RESPONSE_LINE_CLASS}>This email already holds its Covnant Tag</p>
          <p className={RESPONSE_LINE_CLASS}>{provisioningLine(request.provisioning)}</p>
        </>
      )}
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
    </>
  );
}
