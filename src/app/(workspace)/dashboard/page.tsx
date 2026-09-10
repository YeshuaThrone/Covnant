/**
 * /dashboard — the creator's money-first home (the bank-app layout, user
 * design directive; rebuilt 2026-09-10 after the first preview was
 * rejected for not reading like a bank). One session-scoped aggregate
 * (resolveCovnantMe) feeds every region, so the dashboard can never
 * disagree with the API surface:
 *
 *   greeting row    large "Hi, {stage_name}" + a SMALL identity chip
 *                   (initials avatar + compact UCT). Nothing else in the
 *                   hero — the Creator ID card is explicitly out of scope
 *                   here ("dont build no id", user directive 2026-09-10).
 *   accounts        wide calm cards: title, LARGE right-aligned balance
 *                   (or honest status line), small sublabel — no badge
 *                   stacks, no legal copy. One-card carousel + dots on
 *                   mobile.
 *   quick actions   compact icon tiles — square icon, tiny label beneath.
 *   transactions    dense read-only royalty list; "See more" to the full
 *                   ledger when the bounded slice truncates.
 *   readiness       one small quiet checklist panel (desktop right column,
 *                   stacks beneath transactions on mobile).
 *
 * Brand system unchanged: obsidian/slate surfaces, champagne/deep-gold
 * accents, jade/emerald states, glass, gold rules, gradient typography.
 * Density, spacing, and hierarchy read like a bank app: money first, big
 * balances, calm whitespace, minimal chrome. Never account or routing
 * numbers — provisioning is status-only text.
 *
 * Honest failure states: a 401 (no/invalid session) or 404
 * holder_not_found renders the unregistered identity state with a sign-in
 * path — no fabricated rows, no empty zeros pretending to be data.
 * Server-side read failures (502/503) render the degraded state with the
 * named reason surfaced.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  QuickActions,
  SettlementsCard,
  VirtualAccountCard,
  WorkspaceCard,
} from '@/components/dashboard/AccountsRow';
import { CarouselDots } from '@/components/dashboard/CarouselDots';
import { ReadinessChecklist, TransactionsPanel } from '@/components/dashboard/HomePanels';
import { identityChipFromMe } from '@/lib/covnant/identityFromMe';
import { resolveCovnantMe } from '@/lib/server/covnantMe';
import {
  isPreviewDemoAccessEnabled,
  PREVIEW_DEMO_LOGIN_PATH,
} from '@/lib/server/previewDemoAccess';

export const dynamic = 'force-dynamic';

/**
 * The small-caps section label — the bank reference's "ACCOUNTS" row.
 * The `!` modifiers matter: globals.css carries an UNLAYERED
 * `h1, h2 { font-family: var(--font-display); letter-spacing: -0.02em }`
 * brand rule, and unlayered styles beat @layer utilities — without the
 * flags the label silently renders in the display font with tight
 * tracking instead of the tracked mono voice.
 */
function SectionLabel({ children }: { children: string }): React.JSX.Element {
  return (
    <h2 className="font-mono! text-[11px] uppercase tracking-[0.3em]! text-slate-500">{children}</h2>
  );
}

/**
 * The greeting row — the ONLY identity on the page: large friendly
 * greeting plus a small chip (initials avatar + compact UCT reference).
 */
function GreetingRow({
  stageName,
  chip,
}: {
  stageName: string;
  chip: { initials: string; uct: string };
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <h1 data-testid="greeting" className="text-4xl font-bold tracking-tight text-slate-100 md:text-5xl">
        Hi,{' '}
        <span className="bg-gradient-to-r from-gold-champagne via-emerald-200 to-gold bg-clip-text text-transparent">
          {stageName}
        </span>
      </h1>
      <div
        data-testid="identity-chip"
        className="flex shrink-0 items-center gap-2.5 rounded-full border border-slate-700/50 bg-white/[0.02] py-1.5 pl-1.5 pr-3.5"
      >
        <span
          aria-hidden="true"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-gold-champagne/90 via-gold/70 to-gold-deep/90 text-[11px] font-bold text-obsidian"
        >
          {chip.initials}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-slate-500">
          {chip.uct}
        </span>
      </div>
    </div>
  );
}

/** The degraded/visitor state — honest, no fabricated data, no card. */
function NotSignedIn({ reason }: { reason: string }): React.JSX.Element {
  return (
    <main className="mx-auto max-w-5xl px-4 py-12 md:px-6">
      <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-gold">Workspace</p>
      <h1 className="mt-2 text-3xl font-semibold text-slate-100 md:text-4xl">Your creator home</h1>
      <div className="gold-rule my-8" />
      <p className="max-w-md text-sm leading-relaxed text-slate-400">
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
      <p
        data-testid="dashboard-state-reason"
        className="mt-8 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-600"
      >
        {reason}
      </p>
    </main>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ demo_login_failed?: string }>;
}) {
  const me = await resolveCovnantMe();
  if (!me.ok) {
    // PREVIEW-ONLY direct access: an unauthenticated visit on a preview
    // deployment routes through the demo-login door and comes back as the
    // signed-in bank dashboard — zero steps (user directive: "NOT no sign
    // in page a DASHBOARD"). Gated on the 401 family ONLY — a signed-in
    // but unregistered/degraded state (404/502/503) keeps the honest
    // reason surfaces, and the failed param breaks any possible loop.
    // Production (VERCEL_ENV production/unset) never takes this branch.
    const failed = (await searchParams)?.demo_login_failed;
    if (
      !failed &&
      isPreviewDemoAccessEnabled() &&
      (me.reason === 'no_session' || me.reason === 'session_invalid')
    ) {
      redirect(PREVIEW_DEMO_LOGIN_PATH);
    }
    // 401/404 → the honest visitor state; read/config failures degrade with
    // the named reason (the code family is sanitized — no internals leak).
    return <NotSignedIn reason={me.reason} />;
  }

  const chip = identityChipFromMe(me.data);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6 md:py-10">
      <GreetingRow stageName={me.data.profile.stage_name} chip={chip} />

      <div className="gold-rule my-6 md:my-8" />

      {/* Accounts — wide calm balance cards; one-card carousel on mobile.
          The header carries the reference's "View all" affordance; the wired
          destination is the Ownership Ledger, the only full-financial-picture
          surface (no invented routes). */}
      <section aria-label="Accounts">
        <div className="flex items-center justify-between gap-4">
          <SectionLabel>Accounts</SectionLabel>
          <Link
            href="/ledger"
            data-testid="accounts-view-all"
            className="inline-flex items-center rounded-full border border-gold/40 bg-gold/10 px-3.5 py-1.5 text-[11px] font-semibold text-gold-champagne transition-colors hover:bg-gold/20"
          >
            View all
          </Link>
        </div>
        <div
          id="accounts-row"
          data-testid="accounts-row"
          className="mt-3 flex gap-4 overflow-x-auto pb-1 [scrollbar-width:none] snap-x snap-mandatory md:grid md:grid-cols-3 md:gap-6 md:overflow-visible"
        >
          <VirtualAccountCard me={me.data} />
          <SettlementsCard me={me.data} />
          <WorkspaceCard me={me.data} />
        </div>
        <CarouselDots containerId="accounts-row" count={3} />
      </section>

      <section aria-label="Quick actions" className="mt-8 md:mt-10">
        <SectionLabel>Quick actions</SectionLabel>
        <div className="mt-2">
          <QuickActions />
        </div>
      </section>

      <div className="mt-8 grid gap-6 md:mt-10 lg:grid-cols-[1fr_320px]">
        <section aria-label="Transactions">
          <SectionLabel>Transactions</SectionLabel>
          <div className="mt-3">
            <TransactionsPanel me={me.data} />
          </div>
        </section>
        <ReadinessChecklist me={me.data} />
      </div>
    </main>
  );
}
