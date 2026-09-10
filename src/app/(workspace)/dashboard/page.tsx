/**
 * /dashboard — the creator's money-first home (the bank-app layout, user
 * design directive 2026-09-09). One session-scoped aggregate
 * (resolveCovnantMe) feeds every region, so the dashboard can never disagree
 * with the API surface:
 *
 *   greeting hero   "Hi, {stage_name}" + the props-first CreatorIdCard
 *   accounts row    Virtual Account (escrow + status chip) · Settlements
 *                   (per-currency exact) · Rights workspace (real counts)
 *   quick actions   wired destinations only — /assets, /contracts, /templates
 *   transactions    creator-scoped recent royalty rows, READ-ONLY, honest
 *                   empty state
 *   readiness       KYC / tax / bank-linked / provisioning, text-labeled
 *   mobile          single column: swipeable accounts carousel (one card +
 *                   dots) at ~390px — first-class, not a shrunken desktop
 *
 * Brand system unchanged: obsidian/slate surfaces, champagne/deep-gold
 * accents, jade/emerald states, glass cards, gold rules, gradient
 * typography. No white banking chrome, no blue, and never account or
 * routing numbers — provisioning is status-only text.
 *
 * Honest failure states: a 401 (no/invalid session) or 404
 * holder_not_found renders the unregistered identity state with a sign-in
 * path — no fabricated rows, no empty zeros pretending to be data.
 * Server-side read failures (502/503) render the degraded state with the
 * named reason surfaced.
 */

import Link from 'next/link';

import { CreatorIdCard, type CreatorIdCardState } from '@/components/brand/CreatorIdCard';
import {
  QuickActions,
  SettlementsCard,
  VirtualAccountCard,
  WorkspaceCard,
} from '@/components/dashboard/AccountsRow';
import { CarouselDots } from '@/components/dashboard/CarouselDots';
import { ReadinessChecklist, TransactionsPanel } from '@/components/dashboard/HomePanels';
import { creatorIdCardStateFromMe } from '@/lib/covnant/identityFromMe';
import { resolveCovnantMe } from '@/lib/server/covnantMe';

export const dynamic = 'force-dynamic';

/** The hero greeting — the bank reference's "Good morning,…" moment. */
function Greeting({ stageName }: { stageName: string }): React.JSX.Element {
  return (
    <div className="order-2 flex flex-col justify-center md:order-1">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">Workspace</p>
      <h1 data-testid="greeting" className="mt-2 text-4xl font-bold tracking-tight text-slate-100 md:text-5xl">
        Hi,{' '}
        <span className="bg-gradient-to-r from-gold-champagne via-emerald-200 to-gold bg-clip-text text-transparent">
          {stageName}
        </span>
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-slate-400">
        Your money at a glance — settlements, escrow, and your rights workspace,
        exactly as they stand on the ledger.
      </p>
    </div>
  );
}

/** The degraded/visitor state — honest, no fabricated data. */
function NotSignedIn({ cardState, reason }: { cardState: CreatorIdCardState; reason: string }): React.JSX.Element {
  return (
    <main className="mx-auto max-w-5xl px-4 py-12 md:px-6">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">Workspace</p>
      <h1 className="mt-2 text-3xl font-semibold text-slate-100 md:text-4xl">Your creator home</h1>
      <div className="gold-rule my-8" />
      <div className="max-w-md">
        <CreatorIdCard state={cardState} />
      </div>
      <p className="mt-6 max-w-md text-sm leading-relaxed text-slate-400">
        Sign in to see your accounts, settlements, and readiness checklist.
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Link
          href="/signin"
          data-testid="dashboard-signin-cta"
          className="inline-flex items-center gap-2 rounded-md border border-gold/40 bg-gold/10 px-4 py-2 text-sm font-semibold text-gold-champagne transition-colors hover:bg-gold/20"
        >
          Sign in
        </Link>
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-md border border-slate-600/50 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:border-gold/40"
        >
          Back to home
        </Link>
      </div>
      <p data-testid="dashboard-state-reason" className="mt-8 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-600">
        {reason}
      </p>
    </main>
  );
}

export default async function DashboardPage() {
  const me = await resolveCovnantMe();
  if (!me.ok) {
    // 401/404 → the honest visitor state; read/config failures degrade with
    // the named reason (the code family is sanitized — no internals leak).
    return <NotSignedIn cardState={{ kind: 'unregistered' }} reason={me.reason} />;
  }

  const cardState = creatorIdCardStateFromMe(me.data);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6 md:py-10">
      <section
        aria-label="Greeting and identity"
        className="flex flex-col gap-6 md:flex-row md:items-stretch md:gap-10"
      >
        <Greeting stageName={me.data.profile.stage_name} />
        <div className="order-1 md:order-2 md:w-[400px] md:shrink-0">
          <CreatorIdCard state={cardState} />
        </div>
      </section>

      <div className="gold-rule my-8" />

      {/* Accounts row — swipeable one-card carousel on mobile, 3-up on desktop. */}
      <section aria-label="Accounts">
        <div
          id="accounts-row"
          data-testid="accounts-row"
          className="flex gap-4 overflow-x-auto pb-1 [scrollbar-width:none] snap-x snap-mandatory md:grid md:grid-cols-3 md:gap-6 md:overflow-visible"
        >
          <VirtualAccountCard me={me.data} />
          <SettlementsCard me={me.data} />
          <WorkspaceCard me={me.data} />
        </div>
        <CarouselDots containerId="accounts-row" count={3} />
      </section>

      <section aria-label="Quick actions" className="mt-8">
        <h2 className="font-mono text-xs uppercase tracking-[0.3em] text-slate-500">
          Quick actions
        </h2>
        <div className="mt-3">
          <QuickActions />
        </div>
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_320px]">
        <TransactionsPanel me={me.data} />
        <ReadinessChecklist me={me.data} />
      </div>
    </main>
  );
}
