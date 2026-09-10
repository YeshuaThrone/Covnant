/**
 * /dashboard — THE DON, the money-first home (the BANKAPPDT&MOBILE bank
 * reference, element-for-element): left sidebar (the shell), greeting row
 * with avatar chip, the Accounts label with three cards, right-aligned
 * balances + sublabels, carousel dots / View all, compact square action
 * tiles, dense transactions card with See more, quiet readiness panel,
 * thin footer (the shell's).
 *
 * Data comes ENTIRELY through the DashboardDataProvider seam
 * (src/lib/don/dashboardFixtures.ts) — fixtures today, the live Don
 * engine in the follow-up PR. The three account cards ARE the holder's
 * three vault buckets (SovereignVaultRecord, integer cents); the
 * transactions card IS the GL ledger (GlEntryRecord debit/credit legs);
 * the payout tiles carry the sandbox rail (RTP instant, ACH +3 business
 * days) over PayoutHoldRecord-shaped data.
 *
 * Brand: THE DON wordmark on the page header and the browser title; the
 * Covnant brand tokens and the gold CV mark are unchanged — no blue.
 * Every action is a real destination or an honest state display — no
 * invented routes, no fabricated identity (no UCT here; that disclosure
 * belongs to the signup contract).
 */

import type { Metadata } from 'next';
import Link from 'next/link';

import { CvRibbonMonogram } from '@/components/brand/CvRibbonMonogram';
import {
  PayoutRailTiles,
  QuickActions,
  VaultBucketCards,
} from '@/components/dashboard/AccountsRow';
import { CarouselDots } from '@/components/dashboard/CarouselDots';
import { ReadinessChecklist, TransactionsPanel } from '@/components/dashboard/HomePanels';
import {
  displayTransactions,
  fixturesDashboardDataProvider,
  payoutTiles,
} from '@/lib/don/dashboardFixtures';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'The Don — Covnant',
  description:
    'The Don — your money home: vault buckets, GL transactions, and payouts on the sandbox rail.',
};

/**
 * The small-caps section label — the bank reference's "Accounts" row.
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
 * greeting plus the avatar chip (initials circle), exactly the
 * reference's hero. The stage name leads.
 */
function GreetingRow({
  stageName,
  initials,
}: {
  stageName: string;
  initials: string;
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
        data-testid="avatar-chip"
        aria-hidden="true"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-gold/30 bg-gradient-to-br from-gold-champagne/90 via-gold/70 to-gold-deep/90 text-sm font-bold text-obsidian"
      >
        {initials}
      </div>
    </div>
  );
}

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const data = await fixturesDashboardDataProvider.getDashboardData();
  const transactions = displayTransactions(data.ledger, data.vault.payee_id);
  const payouts = payoutTiles(data.payouts);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6 md:py-10">
      {/* Page header wordmark — THE DON, the reference's brand row. */}
      <div data-testid="don-wordmark" className="flex items-center gap-2.5">
        <CvRibbonMonogram size={22} />
        <span className="font-mono text-xs tracking-[0.35em] text-gold-champagne">
          THE DON
        </span>
      </div>

      <div className="mt-6">
        <GreetingRow stageName={data.user.stage_name} initials={data.user.initials} />
      </div>

      <div className="gold-rule my-6 md:my-8" />

      {/* Accounts — the three vault buckets as wide calm balance cards;
          one-card carousel on mobile. "View all" wires to the Ownership
          Ledger, the full-financial-picture surface (real route). */}
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
          <VaultBucketCards vault={data.vault} />
        </div>
        <CarouselDots containerId="accounts-row" count={3} />
      </section>

      {/* Payouts — the sandbox rail's in-flight payouts (RTP instant,
          ACH +3 business days). State displays, not links. */}
      <section aria-label="Payouts" className="mt-8 md:mt-10">
        <SectionLabel>Payouts</SectionLabel>
        <div className="mt-3">
          <PayoutRailTiles tiles={payouts} />
        </div>
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
            <TransactionsPanel rows={transactions} />
          </div>
        </section>
        <ReadinessChecklist readiness={data.readiness} />
      </div>
    </main>
  );
}
