/**
 * /covnant-id — the identity card surface (Creator UI Layout Contract §3).
 *
 * Renders the session creator's Universal Covnant Tag through the existing
 * IdentityBadge (Gen 10), fed by the kernel's getCreatorUct store read —
 * the same projection /api/covnant/me exposes. Every rendered fact comes
 * from the store or the session resolution: the UCT, the ISNI (null when
 * absent — "Not linked"), and the creator's own KYC/provisioning states.
 * Nothing is invented; no issuance date is fabricated (the store carries
 * none). The demo door renders the seeded identity with the DEMO DATA
 * marker, per the honesty-marker law.
 */

import type { Metadata } from 'next';
import Link from 'next/link';

import { IdentityBadge } from '@/components/brand/IdentityBadge';
import { HeaderActions } from '@/components/workspace/HeaderActions';
import {
  identityStateFor,
  loadCreatorPageContext,
  storeForContext,
} from '@/lib/server/creatorPages';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Covnant ID — Covnant',
  description:
    'Your Universal Covnant Tag — the root identity of your ownership on The Don.',
};

function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-sm text-slate-300">{label}</span>
      <span className="text-right font-mono text-sm text-slate-100">{children}</span>
    </div>
  );
}

export default async function CovnantIdPage() {
  const context = await loadCreatorPageContext();

  if (context === null) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6 md:py-10">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold-champagne">Covnant ID</p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-100 md:text-4xl">
          Sign in to view your Covnant ID
        </h1>
        <p className="mt-3 text-sm text-slate-400">
          Your Universal Covnant Tag lives behind your sign-in.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex items-center rounded-full border border-gold/40 bg-gold/10 px-4 py-2 text-sm font-semibold text-gold-champagne transition-colors hover:bg-gold/20"
        >
          Go to the Gold Board
        </Link>
      </main>
    );
  }

  const { creator, demo } = context;
  const store = await storeForContext(context);
  const uct = await store.getCreatorUct(creator.payee_id);
  const identity = identityStateFor(creator, uct);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6 md:py-10">
      <div
        data-testid="covnant-id-header"
        className="flex items-center justify-between gap-2.5"
      >
        <span className="font-mono text-xs tracking-[0.35em] text-gold-champagne">
          COVNANT ID
        </span>
        <HeaderActions demo={demo} />
      </div>

      <h1
        data-testid="covnant-id-title"
        className="mt-6 text-4xl font-bold tracking-tight text-slate-100 md:text-5xl"
      >
        <span className="bg-gradient-to-r from-gold-champagne via-emerald-200 to-gold bg-clip-text text-transparent">
          {creator.stage_name}
        </span>
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-400">
        The root identity of your ownership on The Don — one tag, bound to you,
        carried by every asset and settlement you hold.
      </p>

      <div className="gold-rule my-6 md:my-8" />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <section
          data-testid="identity-panel"
          aria-label="Identity"
          className="glass-card p-6 md:p-8"
        >
          <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-slate-500">
            Universal Covnant Tag
          </p>
          <div className="mt-4">
            <IdentityBadge state={identity} />
          </div>

          <div className="gold-rule my-6" />

          <div data-testid="identity-facts" className="divide-y divide-slate-700/40">
            <FactRow label="Creator">{creator.stage_name}</FactRow>
            <FactRow label="Root UCT">
              <span data-testid="identity-uct" className="text-gold-champagne">
                {identity.kind === 'anchored' ? identity.uct : '—'}
              </span>
            </FactRow>
            <FactRow label="ISNI">
              <span data-testid="identity-isni">{uct?.isni ?? 'Not linked'}</span>
            </FactRow>
            <FactRow label="Identity verification">{creator.kyc_status}</FactRow>
            <FactRow label="Provisioning">{creator.provisioning_status}</FactRow>
          </div>

          <p className="mt-6 text-xs leading-relaxed text-slate-500">
            Your UCT is issued by the identity registry and verified against your
            session on every read — it is never minted by a client. If your
            verification state changes, the tag reflects it on the next render.
          </p>
        </section>

        <aside
          data-testid="identity-notes"
          className="h-fit rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] shadow-[0_12px_40px_-16px_rgba(0,0,0,0.55)] p-5"
          aria-label="About the Covnant ID"
        >
          <h2 className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
            What this is
          </h2>
          <p className="mt-3 text-xs leading-relaxed text-slate-400">
            The Universal Covnant Tag is the root of your creator identity: one
            immutable handle that links your catalog, your settlements, and your
            vault. It is issued once and never rotated.
          </p>
          <p className="mt-3 text-xs leading-relaxed text-slate-400">
            ISNI linkage is optional and renders here only when a verified ISNI
            exists on your profile.
          </p>
          {demo && (
            <p className="mt-4 rounded-lg border border-amber-300/30 bg-amber-300/10 p-3 text-xs leading-relaxed text-amber-200">
              This is the demo persona — the seeded identity used by the public
              preview. Nothing here is a real holder&apos;s.
            </p>
          )}
        </aside>
      </div>
    </main>
  );
}
