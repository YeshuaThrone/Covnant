'use client';

/**
 * The registration agent's creator-facing state machine:
 *
 *   describe → (POST /api/covnant/agent/register) → review → confirm via
 *   the EXISTING registerAssetAction → confirmed.
 *
 * The only network calls are the draft request (registered-session-only,
 * enforced server-side by the route) and the confirm, which is the same
 * guarded server action the manual registration form uses. The agent never
 * writes: this shell just hands the creator-edited payload to the write path
 * that already existed.
 */

import { useState } from 'react';
import Link from 'next/link';
import { DraftReview } from '@/components/agent/DraftReview';
import { registerAssetAction } from '@/lib/assets/actions';
import type { AgentRegistrationDraft } from '@/lib/agent/registrationDraft';

const FIELD =
  'w-full rounded-lg border border-white/10 bg-onyx-800 px-3 py-2 text-sm text-[#F2F4F8] placeholder:text-white/30 focus:border-gold focus:outline-none';

type Phase =
  | { kind: 'describe' }
  | { kind: 'loading' }
  | { kind: 'review'; draft: AgentRegistrationDraft; warnings: string[] }
  | { kind: 'confirmed'; cbtCode: string };

export function AgentRegistrationStudio() {
  const [phase, setPhase] = useState<Phase>({ kind: 'describe' });
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | undefined>();

  const requestDraft = async () => {
    if (!description.trim() || phase.kind === 'loading') return;
    setPhase({ kind: 'loading' });
    setError(undefined);
    try {
      const response = await fetch('/api/covnant/agent/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      const body = (await response.json()) as {
        draft?: AgentRegistrationDraft;
        warnings?: string[];
        error?: string;
      };
      if (response.ok && body.draft) {
        setPhase({ kind: 'review', draft: body.draft, warnings: body.warnings ?? [] });
        return;
      }
      setError(body.error ?? 'The agent could not draft this work — try the registration form.');
      setPhase({ kind: 'describe' });
    } catch {
      setError('The agent is unreachable right now — try again, or use the registration form.');
      setPhase({ kind: 'describe' });
    }
  };

  if (phase.kind === 'confirmed') {
    return (
      <div className="glass-card p-8 text-center" data-testid="agent-confirmed">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">Registered</p>
        <h2 className="mt-3 text-2xl font-semibold text-[#F2F4F8]">
          Covenant Block {phase.cbtCode} is open.
        </h2>
        <p className="mt-2 text-sm text-white/50">
          The asset is on the ledger with the splits you confirmed.
        </p>
        <div className="mt-6 flex items-center justify-center gap-4">
          <a
            href={`/assets/${phase.cbtCode}`}
            className="rounded-lg border border-[#FFD700]/60 bg-[#D4AF37]/10 px-6 py-3 text-sm font-medium text-[#FFD700] hover:bg-[#D4AF37]/20"
          >
            View the asset
          </a>
          <button
            type="button"
            onClick={() => {
              setDescription('');
              setPhase({ kind: 'describe' });
            }}
            className="text-sm text-white/50 underline underline-offset-4 hover:text-white/80"
          >
            Register another work
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === 'review') {
    return (
      <DraftReview
        draft={phase.draft}
        warnings={phase.warnings}
        onConfirm={registerAssetAction}
        onRegistered={(cbtCode) => setPhase({ kind: 'confirmed', cbtCode })}
        onStartOver={() => setPhase({ kind: 'describe' })}
      />
    );
  }

  return (
    <div className="space-y-6" data-testid="agent-describe">
      <section className="glass-card p-6">
        <h2 className="font-mono text-sm uppercase tracking-widest text-gold">Describe the work</h2>
        <p className="mt-2 text-sm text-white/50">
          Plain words are enough — what you made, who owns what, and how it splits. The agent
          proposes a structured Covenant Block draft; you review, edit, and confirm it. The agent
          never writes to the registry — your confirmation does.
        </p>
        <textarea
          className={`${FIELD} mt-4 min-h-40`}
          value={description}
          placeholder="e.g. I produced a track called Midnight Clear with my collaborator Second Writer — I own the master, we split the composition 60/40, and their publisher administers the publishing pool…"
          onChange={(event) => setDescription(event.target.value)}
          data-testid="agent-description"
        />
        {error && (
          <p className="mt-3 rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-3 text-sm text-red-300">
            {error}
          </p>
        )}
        <div className="mt-4 flex items-center justify-between gap-4">
          <p className="text-xs text-white/40">
            Drafting costs one model request — rate limited per creator.
          </p>
          <button
            type="button"
            disabled={!description.trim() || phase.kind === 'loading'}
            onClick={requestDraft}
            data-testid="agent-draft-submit"
            className="rounded-lg border border-[#FFD700]/60 bg-[#D4AF37]/10 px-6 py-3 text-sm font-medium text-[#FFD700] hover:bg-[#D4AF37]/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {phase.kind === 'loading' ? 'Composing your draft…' : 'Draft my registration'}
          </button>
        </div>
      </section>
      <p className="text-xs text-white/40">
        Prefer the form? The manual{' '}
        <Link href="/assets/new" className="text-gold underline underline-offset-4">
          asset registration
        </Link>{' '}
        is always available.
      </p>
    </div>
  );
}
