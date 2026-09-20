/**
 * /transactions — the creator's FULL transaction history (directive §7).
 *
 * Gold Board's six-row transactions card truncates the holder's GL and its
 * "See more" lands HERE — the complete holder-scoped history, same store
 * reads (liveDashboardDataProvider → displayTransactions), same row voice
 * as the Gold Board panel, no six-row slice. DISTINCT from the administrator
 * ledger: /ledger is the platform-wide settlement audit; this page renders
 * only the signed-in holder's own postings. Unregistered and read-failure
 * states render the honest access panels — no fabricated balances.
 */

import Link from 'next/link';
import { CvRibbonMonogram } from '@/components/brand/CvRibbonMonogram';
import { formatCents, formatCentsSigned } from '@/lib/money/format';
import { displayTransactions } from '@/lib/don/dashboardData';
import { liveDashboardDataProvider } from '@/lib/server/dashboardLive';
import type { DisplayTransaction } from '@/lib/don/dashboardData';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Transaction History — Covnant',
  description: 'Your complete Gold Board transaction history — every posting on your ledger.',
};

/** Deterministic date render — hydration-safe (UTC, fixed locale). */
function settledOn(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** The demo disclosure — same marker voice as the Gold Board's badge. */
function DemoDataBadge(): React.JSX.Element {
  return (
    <span
      data-testid="demo-data-badge"
      className="inline-flex shrink-0 items-center rounded-full border border-amber-300/40 bg-amber-300/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-amber-300"
    >
      Demo data
    </span>
  );
}

/** Honest access panel — unregistered identity or read failure. */
function AccessPanel({ state }: { state: 'unregistered' | 'error' }): React.JSX.Element {
  const copy = {
    unregistered: {
      title: 'Finish setting up your Covnant identity',
      body: 'This account is verified but not yet enrolled as a rights holder, so there is no transaction history to show yet.',
    },
    error: {
      title: "We couldn't load your transaction history",
      body: 'A server error interrupted the read. Nothing is shown rather than something wrong — please try again.',
    },
  }[state];
  return (
    <main data-testid="transactions-access-panel" className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6 md:py-10">
      <div className="flex items-center gap-2.5">
        <CvRibbonMonogram size={22} />
        <span className="font-mono text-xs tracking-[0.35em] text-gold-champagne">GOLD BOARD</span>
      </div>
      <section aria-label="Transaction history access" className="mt-10 rounded-2xl border border-gold/25 bg-obsidian-900/70 p-8">
        <h1 className="text-3xl font-bold tracking-tight text-slate-100 md:text-4xl">{copy.title}</h1>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-slate-400">{copy.body}</p>
        <Link
          href="/dashboard"
          className="mt-6 inline-flex items-center rounded-full border border-gold/40 bg-gold/10 px-3.5 py-1.5 text-[11px] font-semibold text-gold-champagne transition-colors hover:bg-gold/20"
        >
          Back to Gold Board
        </Link>
      </section>
    </main>
  );
}

/** One history row — the Gold Board panel's exact row voice, unbounded. */
function HistoryRow({ row }: { row: DisplayTransaction }): React.JSX.Element {
  return (
    <li
      data-testid="transactions-history-row"
      data-journal={row.id}
      className="flex items-center justify-between gap-4 py-2.5"
    >
      <div className="min-w-0">
        <p className="truncate text-sm text-slate-200">{row.title}</p>
        <p className="truncate text-[11px] text-slate-500">
          {settledOn(row.occurred_at)} · <span className="font-mono">{row.subtitle}</span>
          {' · '}
          <span className="font-mono text-[10px]">
            DR {formatCents(row.debit_cents)} / CR {formatCents(row.credit_cents)}
          </span>
        </p>
      </div>
      <p className="shrink-0 font-mono text-sm text-slate-100">{formatCentsSigned(row.amount_cents)}</p>
    </li>
  );
}

export default async function TransactionsPage(): Promise<React.JSX.Element> {
  let resolution: Awaited<ReturnType<typeof liveDashboardDataProvider.getDashboardResolution>>;
  try {
    resolution = await liveDashboardDataProvider.getDashboardResolution();
  } catch (error) {
    console.error('transaction history resolution failed:', error);
    return <AccessPanel state="error" />;
  }
  if (resolution.kind === 'unregistered') {
    return <AccessPanel state="unregistered" />;
  }

  const isDemoView = resolution.kind === 'demo';
  const data = resolution.data;
  const transactions = displayTransactions(data.ledger, data.vault.payee_id);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6 md:py-10">
      <div data-testid="transactions-history-header" className="flex items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5">
          <CvRibbonMonogram size={22} />
          <span className="font-mono text-xs tracking-[0.35em] text-gold-champagne">
            GOLD BOARD
          </span>
        </div>
        {isDemoView ? <DemoDataBadge /> : null}
      </div>

      <h1 data-testid="transactions-history-title" className="mt-6 text-4xl font-bold tracking-tight text-slate-100 md:text-5xl">
        Transaction <span className="bg-gradient-to-r from-gold-champagne via-emerald-200 to-gold bg-clip-text text-transparent">history</span>
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-400">
        Every posting on your ledger — the complete history behind the Gold Board
        preview. Holder-scoped store reads only; nothing is invented.
      </p>

      <div className="gold-rule my-6 md:my-8" />

      <section
        data-testid="transactions-history-panel"
        className="rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] shadow-[0_12px_40px_-16px_rgba(0,0,0,0.55)] p-5 md:p-6"
        aria-label="Full transaction history"
      >
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-mono! text-[11px] uppercase tracking-[0.3em]! text-slate-500">
            All postings · {transactions.length}
          </h2>
          <Link
            href="/dashboard"
            data-testid="transactions-back-to-goldboard"
            className="inline-flex items-center rounded-full border border-gold/40 bg-gold/10 px-3.5 py-1.5 text-[11px] font-semibold text-gold-champagne transition-colors hover:bg-gold/20"
          >
            Gold Board
          </Link>
        </div>
        {transactions.length === 0 ? (
          <p data-testid="transactions-history-empty" className="mt-4 text-sm leading-relaxed text-slate-400">
            No postings on your ledger yet.
          </p>
        ) : (
          <ul data-testid="transactions-history-rows" className="mt-3 divide-y divide-slate-700/40">
            {transactions.map((row) => (
              <HistoryRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
