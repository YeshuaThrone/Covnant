'use client';

/**
 * The review state of the registration agent — where the creator turns the
 * agent's PROPOSAL into THEIR registration. The draft arrives fully editable:
 * title, medium, identifiers, and the same PoolSplitEditor the manual form
 * uses, so every edit happens inside the studio's exact-100.0000% gate, not
 * around it.
 *
 * Every `assumptions[]` entry renders as a visible flag — a field the agent
 * defaulted is never silent. The confirm button is gated by the same client
 * zod validation the write path applies (registerAssetPayloadSchema) plus the
 * per-pool exact-100.0000% check, so a draft the server would reject never
 * leaves this screen. Confirm calls the EXISTING `registerAssetAction`
 * through the `onConfirm` seam — this component never invents a write path.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { GoldNotificationBanner } from '@/components/brand/GoldNotificationBanner';
import { PoolSplitEditor } from '@/components/studio/PoolSplitEditor';
import {
  MEDIA_MEDIUMS,
  MEDIUM_LABELS,
  poolStateForUnits,
  sumPoolUnits,
  type HolderDraft,
  type PoolDraft,
} from '@/lib/splits/shared';
import { TEMPLATES } from '@/lib/contracts/templates';
import { registerAssetPayloadSchema } from '@/lib/agent/registrationDraft';
import type { AgentRegistrationDraft } from '@/lib/agent/registrationDraft';
import type { ActionResult, RegisterAssetPayload } from '@/lib/assets/actions';

// The keyboard focus ring is the shared :focus-visible token in globals.css
// (UI audit #22) — no per-field suppressor here, it would zero the ring.
const FIELD =
  'w-full rounded-lg border border-white/10 bg-onyx-800 px-3 py-2 text-sm text-pearl placeholder:text-white/30';
const LABEL = 'block text-xs uppercase tracking-wider text-white/40 mb-1';

/** Client-side holder id for the editor keys — the write action re-ids as it normalizes. */
function clientHolderId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `draft-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function draftHolderToEditable(name: string): HolderDraft {
  return {
    id: clientHolderId(),
    name,
    role: 'COMPOSER',
    splitPercentage: 0,
    taxFormType: 'W9_US_PERSON',
    usTaxResident: true,
    isVerified: true,
    routing: {
      accountHolderName: '',
      bankName: '',
      accountNumberOrIBAN: '',
      routingOrBIC: '',
      currency: 'USD',
      countryCode: 'US',
      planetaryJurisdiction: 'EARTH',
      railType: 'ACH',
    },
  };
}

/** The agent's draft pools are id-less proposals — the editor needs keyed holders. */
function draftPoolsToEditable(pools: AgentRegistrationDraft['pools']): PoolDraft[] {
  return pools.map((pool) => ({
    pool: pool.pool,
    holders: pool.holders.map((holder) => ({
      ...draftHolderToEditable(holder.name),
      ...holder,
      id: clientHolderId(),
      routing: { ...draftHolderToEditable(holder.name).routing, ...holder.routing },
    })),
  }));
}

interface DraftReviewProps {
  draft: AgentRegistrationDraft;
  warnings: string[];
  onConfirm: (payload: RegisterAssetPayload) => Promise<ActionResult>;
  onRegistered: (cbtCode: string) => void;
  onStartOver: () => void;
}

export function DraftReview({ draft, warnings, onConfirm, onRegistered, onStartOver }: DraftReviewProps) {
  const [title, setTitle] = useState(draft.title);
  const [medium, setMedium] = useState(draft.medium);
  const [identifiers, setIdentifiers] = useState(draft.identifiers);
  const [pools, setPools] = useState<PoolDraft[]>(() => draftPoolsToEditable(draft.pools));
  const [confirming, setConfirming] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const templateName = useMemo(
    () => TEMPLATES.find((template) => template.id === draft.templateSuggestion?.templateId)?.name,
    [draft.templateSuggestion?.templateId],
  );

  const payload: RegisterAssetPayload = { title, medium, identifiers, pools };
  const payloadValid = registerAssetPayloadSchema.safeParse(payload).success;
  const poolsExact = pools.every(
    (pool) =>
      poolStateForUnits(sumPoolUnits(pool.holders.map((holder) => holder.splitPercentage))) === 'EXACT',
  );
  const canConfirm = payloadValid && poolsExact && !confirming;

  const confirm = async () => {
    if (!canConfirm) return;
    setConfirming(true);
    setError(undefined);
    setDuplicate(false);
    try {
      const result = await onConfirm(payload);
      if (result.ok && result.cbtCode) {
        onRegistered(result.cbtCode);
        return;
      }
      if (result.duplicate) {
        setDuplicate(true);
        return;
      }
      setError(result.error ?? 'Registration failed — try again or use the registration form.');
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="space-y-8" data-testid="agent-draft-review">
      {/* Registration is async — announce the in-flight state (UI audit #25). */}
      <p role="status" className="sr-only">
        {confirming ? 'Registering the asset…' : ''}
      </p>
      {duplicate && (
        <GoldNotificationBanner title="Asset already registered in CBT catalog">
          The identical medium and title are already on the ledger — that catalog entry is the
          asset of record. Adjust the title or medium to register a different work.
        </GoldNotificationBanner>
      )}

      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-300">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}

      <section className="glass-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-mono text-sm uppercase tracking-widest text-gold">
            Review the agent&apos;s draft
          </h2>
          <span
            className={`rounded-full border px-3 py-1 font-mono text-xs ${
              draft.confidence >= 0.7
                ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
                : 'border-amber-400/40 bg-amber-400/10 text-amber-300'
            }`}
          >
            Model confidence: {Math.round(draft.confidence * 100)}%
          </span>
        </div>

        {draft.assumptions.length > 0 && (
          <div
            data-testid="agent-assumptions"
            className="mt-4 rounded-lg border border-gold-bright/30 bg-gold/[0.06] px-4 py-3"
          >
            <p className="text-xs font-medium uppercase tracking-wider text-gold">
              Agent assumptions — fill these in before you confirm
            </p>
            <ul className="mt-2 space-y-1">
              {draft.assumptions.map((assumption) => (
                <li key={assumption} className="flex gap-2 text-sm text-pearl/80">
                  <span aria-hidden className="text-gold">◆</span>
                  <span>{assumption}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="draft-title" className={LABEL}>
              Asset title
            </label>
            <input
              id="draft-title"
              className={FIELD}
              value={title}
              placeholder="Song, film, episode, book…"
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="draft-medium" className={LABEL}>
              Medium
            </label>
            <select
              id="draft-medium"
              className={FIELD}
              value={medium}
              onChange={(event) => setMedium(event.target.value as typeof draft.medium)}
            >
              {MEDIA_MEDIUMS.map((option) => (
                <option key={option} value={option} className="bg-onyx-800">
                  {MEDIUM_LABELS[option]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="draft-identifier-isrc" className={LABEL}>
              ISRC / ISWC / EIDR
            </label>
            <div className="flex gap-2">
              <input
                id="draft-identifier-isrc"
                aria-label="ISRC"
                className={FIELD}
                value={identifiers.isrc ?? ''}
                placeholder="ISRC"
                onChange={(event) =>
                  setIdentifiers((prev) => ({ ...prev, isrc: event.target.value || undefined }))
                }
              />
              <input
                aria-label="ISWC"
                className={FIELD}
                value={identifiers.iswc ?? ''}
                placeholder="ISWC"
                onChange={(event) =>
                  setIdentifiers((prev) => ({ ...prev, iswc: event.target.value || undefined }))
                }
              />
              <input
                aria-label="EIDR"
                className={FIELD}
                value={identifiers.eidrCanonical ?? ''}
                placeholder="EIDR"
                onChange={(event) =>
                  setIdentifiers((prev) => ({ ...prev, eidrCanonical: event.target.value || undefined }))
                }
              />
            </div>
          </div>
        </div>
      </section>

      <PoolSplitEditor pools={pools} onChange={setPools} />

      {draft.templateSuggestion && (
        <section className="glass-card p-6">
          <h2 className="font-mono text-sm uppercase tracking-widest text-gold">Suggested agreement</h2>
          <p className="mt-3 text-sm text-pearl/80">
            {templateName ? `${templateName} — ` : ''}
            {draft.templateSuggestion.rationale}
          </p>
          <Link href="/templates" className="mt-3 inline-block text-sm text-gold underline underline-offset-4">
            Draft this agreement in Contracts →
          </Link>
        </section>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={onStartOver}
          className="text-sm text-white/50 underline underline-offset-4 hover:text-white/80"
        >
          Describe another work
        </button>
        <button
          type="button"
          disabled={!canConfirm}
          onClick={confirm}
          data-testid="agent-confirm"
          className="rounded-lg border border-gold-bright/60 bg-gold/10 px-6 py-3 text-sm font-medium text-gold-bright hover:bg-gold/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {confirming ? 'Registering…' : 'Confirm & register'}
        </button>
      </div>

      <p className="text-xs text-white/40">
        Confirming registers this Covenant Block through the same guarded action as the manual form —
        every pool must read exactly 100.0000%, re-validated server-side. The agent only proposes; you write.
      </p>
    </div>
  );
}
