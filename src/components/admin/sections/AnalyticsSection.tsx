/**
 * Analytics — the console's royalty-flow views (generation-4 spec,
 * 2026-09-22): the ONE clearing ledger read three ways — by industry (the
 * bound atomic entity class of the underlying asset), by source (the
 * split run's source of record), and by transaction type (the journal
 * kind of record). Store-read only, integer-cent math, descending rows.
 *
 * Presentation follows the platform's established language — the gold-rule
 * divider and eyebrow titles of the Overview's Revenue Streams block, with
 * each row carrying the RevenueStreamsStrip bar treatment (slate track,
 * gold gradient fill, width proportional to the row's share of the cut).
 * Every cut renders an honest state — rows, an honest empty, or the
 * unavailable copy — never a blank block, never a placeholder value. The
 * demo-data badge discloses the seeded multi-industry demo ledger; no
 * fabricated totals outside the store.
 */

import { formatCentsBigint } from '@/lib/money/format';
import type { AnalyticsCut, PlatformAnalyticsFlows } from '@/lib/admin/analyticsFlows';
import { SectionEyebrow, SectionUnavailable } from '../shared';
import type { SectionData } from '../types';

/**
 * Bar width — the row's share of the cut's gross, integer percent derived
 * from the same store figures the row renders (bigint numerator over
 * bigint denominator — never a float, never a literal). A nonzero row
 * shows at least a 1% sliver so descending order stays visible.
 */
export function shareOfCutTotal(rowCents: bigint, totalCents: bigint): number {
  if (totalCents <= 0n || rowCents <= 0n) return 0;
  return Math.max(1, Number((rowCents * 100n) / totalCents));
}

function DemoBadge() {
  return (
    <span
      data-testid="demo-data-badge"
      className="inline-flex shrink-0 items-center rounded-full border border-amber-300/40 bg-amber-300/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-amber-300"
    >
      Demo data
    </span>
  );
}

/** The three cuts, in the spec's order — id is the stable testid stem. */
const CUTS: readonly { id: string; title: string; description: string; pick: (flows: PlatformAnalyticsFlows) => AnalyticsCut }[] = [
  {
    id: 'industry',
    title: 'By industry',
    description: 'Gross royalty inflow by the bound entity class of the underlying asset.',
    pick: (flows) => flows.byIndustry,
  },
  {
    id: 'source',
    title: 'By source',
    description: "Gross royalty inflow by the split run's source of record.",
    pick: (flows) => flows.bySource,
  },
  {
    id: 'transaction-type',
    title: 'By transaction type',
    description: 'Gross royalty inflow by the journal kind of record.',
    pick: (flows) => flows.byTransactionType,
  },
];

/** The Revenue Streams strip's honest-state card treatment. */
const STATE_CARD =
  'rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5 text-sm leading-relaxed';

function CutEmptyLine({ cutId }: { cutId: string }) {
  return (
    <p data-testid={`analytics-cut-${cutId}-empty`} className={`${STATE_CARD} text-white/40`}>
      No royalty postings yet — rows appear with the first royalty ingest that lands in this cut.
    </p>
  );
}

function CutUnavailableLine({ cutId }: { cutId: string }) {
  return (
    <p data-testid={`analytics-cut-${cutId}-unavailable`} className={`${STATE_CARD} text-amber-300/80`}>
      The ledger read for this cut failed — showing nothing rather than a wrong number.
    </p>
  );
}

function CutBlock({
  cutId,
  title,
  description,
  cut,
}: {
  cutId: string;
  title: string;
  description: string;
  cut: AnalyticsCut;
}) {
  const readyRows = cut.state === 'ready' ? cut.rows : [];
  const cutTotal = readyRows.reduce((sum, row) => sum + row.totalCents, 0n);

  return (
    <div className="mt-10" data-testid={`analytics-cut-${cutId}`}>
      <div className="gold-rule w-64" />
      <div className="mt-8 max-w-2xl">
        <SectionEyebrow>{title}</SectionEyebrow>
        <p className="mt-2 text-[13px] leading-relaxed text-white/40">{description}</p>
        <div className="mt-3">
          {readyRows.length > 0 ? (
            <ul
              className="rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] shadow-[0_12px_40px_-16px_rgba(0,0,0,0.55)] p-5 md:p-6"
              aria-label={title}
            >
              {readyRows.map((row) => (
                <li
                  key={row.label}
                  data-testid={`analytics-cut-${cutId}-row`}
                  className="flex items-center justify-between gap-4 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-slate-200">{row.label}</span>
                    <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-slate-700/50">
                      <span
                        data-testid={`analytics-cut-${cutId}-bar`}
                        className="block h-full rounded-full bg-gradient-to-r from-gold-champagne/80 to-gold/60"
                        style={{ width: `${shareOfCutTotal(row.totalCents, cutTotal)}%` }}
                      />
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-sm text-slate-100">
                    {formatCentsBigint(row.totalCents)}
                  </span>
                </li>
              ))}
            </ul>
          ) : cut.state === 'unavailable' ? (
            <CutUnavailableLine cutId={cutId} />
          ) : (
            <CutEmptyLine cutId={cutId} />
          )}
        </div>
      </div>
    </div>
  );
}

export function AnalyticsSection({
  analytics,
  demo,
}: {
  analytics: SectionData<PlatformAnalyticsFlows>;
  demo: boolean;
}) {
  return (
    <div aria-label="Analytics">
      <div className="flex items-center justify-between gap-3">
        <SectionEyebrow>Analytics</SectionEyebrow>
        {demo ? <DemoBadge /> : null}
      </div>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/50">
        The one clearing ledger read three ways — by industry, by source, and by
        transaction type. Every figure is derived from the store at render time;
        a cut with nothing behind it says so.
      </p>
      {analytics.kind === 'unavailable' ? (
        <div className="mt-8" data-testid="analytics-unavailable">
          <SectionUnavailable code={analytics.code} message={analytics.message} />
        </div>
      ) : (
        <div>
          {CUTS.map((cut) => (
            <CutBlock
              key={cut.id}
              cutId={cut.id}
              title={cut.title}
              description={cut.description}
              cut={cut.pick(analytics.value)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
