'use client';

import { useEffect, useRef, useState } from 'react';

/*
 * Entry composition — the five mirrored entry zones and the Universal
 * Agreement & Seal zone, rendered as direct children of the landing section.
 * This is a client island: the seal interaction needs state over all five
 * inputs (readOnly freezing, value rehydration), which only a client
 * component can own. The rendered markup of every pre-existing zone is
 * byte-identical to the server-rendered version it replaces.
 */

const SEALED_ENTRY_KEY = 'covnant.sealedEntry';

type SealedEntryValues = {
  stageName: string;
  legalName: string;
  email: string;
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
  return (
    typeof values.stageName === 'string' &&
    typeof values.legalName === 'string' &&
    typeof values.email === 'string' &&
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
  'h-10 w-64 border bg-transparent font-mono text-sm uppercase tracking-[0.3em] transition-colors duration-200';

export function EntryZones() {
  const [sealed, setSealed] = useState(false);
  const stageNameRef = useRef<HTMLInputElement>(null);
  const legalNameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
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
      entry.values.password,
      entry.values.coreIndustryTitle,
    ];
    const refs = [stageNameRef, legalNameRef, emailRef, passwordRef, coreIndustryTitleRef];
    refs.forEach((ref, index) => {
      if (ref.current) ref.current.value = saved[index];
    });
    setSealed(true);
  }, []);

  /* Seal: persist the five entries locally and freeze the fields. Idempotent
   * — a second click on an already-sealed composition changes nothing.
   * Local only: no POST, no signup wiring; the backend field-support
   * decision belongs to the Information Gate wave. */
  const sealWorld = () => {
    if (sealed) return;
    const entry: SealedEntry = {
      sealed: true,
      values: {
        stageName: stageNameRef.current?.value ?? '',
        legalName: legalNameRef.current?.value ?? '',
        email: emailRef.current?.value ?? '',
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
  };

  const inputClass = sealed ? SEALED_INPUT_CLASS : UNSEALED_INPUT_CLASS;

  const buttonClass = [
    BUTTON_BASE_CLASS,
    sealed
      ? 'cursor-default border-gold-champagne text-gold-champagne/70'
      : 'cursor-pointer border-gold-champagne/40 text-gold-champagne/90 hover:border-gold-champagne hover:text-gold-champagne focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold-champagne',
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

      {/* Password entry zone — a straight mirror of the Email zone, inserted
          directly beneath it (under the email portion, before the Universal
          agreement). The ruler above doubles as this zone's SHARED TOP RULE
          (untouched, same y as approved). The statement repeats the exact
          champagne mono treatment and the same 32px top gap below the shared
          rule; the invisible input repeats the Email field byte-for-byte and
          arrives PRE-FILLED with 'Covenant' (exactly 8 letters) as the
          delegated starting value — type text so the jade letters show, and
          the field stays fully editable until the seal; a new bottom golden
          ruler closes the zone HUGGING the input — zero margin above it, a
          true pixel mirror of the Email zone. The Core Industry & Title zone
          follows below this ruler. */}
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

      {/* Core Industry & Title entry zone — a straight mirror of the Email
          zone. The ruler above doubles as this zone's SHARED TOP RULE
          (untouched, same y as approved). The statement repeats the exact
          champagne mono treatment and the same 32px top gap below the
          shared rule; the invisible input repeats the Email field
          byte-for-byte (chromeless h-10 w-64, jade typed text, gold caret,
          aria-label only, local-only — no validation, no submission
          wiring); a new bottom golden ruler closes the zone HUGGING the
          input — zero margin above it, a true pixel mirror of the Email
          zone. NOTHING follows the ruler — the region below stays empty
          black space. */}
      <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Core Industry &amp; Title</p>
      <input
        ref={coreIndustryTitleRef}
        type="text"
        aria-label="Core Industry & Title"
        className={inputClass}
        readOnly={sealed}
      />
      <div className="gold-rule w-64" />

      {/* Universal Agreement & Seal — the final mirrored zone. The ruler
          above doubles as this zone's SHARED TOP RULE (untouched, same y as
          approved). The statement repeats the exact champagne mono treatment
          and the same 32px top gap below the shared rule; the longer copy
          wraps naturally — font, tracking, and color are untouched. In the
          input slot: the 'Submit' button, a 1px champagne hairline
          at low opacity (hover brightens to full gold; focus-visible gold
          outline; square corners). Clicking seals EVERYTHING the visitor
          wrote: all five entries are captured to localStorage and frozen
          readOnly with the jade styling kept and the caret suppressed; the
          button keeps its label while its border solidifies to full gold and
          its label dims slightly; a second click is a no-op; a refresh
          rehydrates the sealed composition. Local only — no POST, no signup
          wiring. A new bottom golden ruler closes the zone HUGGING the
          button — zero margin above it. NOTHING follows the ruler — the
          region below stays empty black space. */}
      <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">
        I agree to the Universal Distribution &amp; Royalty Administration Terms
      </p>
      <button type="button" onClick={sealWorld} className={buttonClass}>
        Submit
      </button>
      <div className="gold-rule w-64" />
    </>
  );
}
