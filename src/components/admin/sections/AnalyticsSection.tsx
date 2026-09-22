/**
 * Analytics — the console's royalty-flow views (generation-4 spec,
 * 2026-09-22): the ONE clearing ledger read three ways — by industry (the
 * bound atomic entity class of the underlying asset), by source (the
 * split run's source of record), and by transaction type (the journal
 * kind of record). Store-read only, integer-cent math, descending rows.
 *
 * Every cut renders an honest state — rows, an honest empty, or the
 * unavailable copy — never a blank block, never a placeholder value. The
 * demo-data badge discloses the seeded multi-industry demo ledger; no
 * fabricated totals outside the store.
 */

import { formatCentsBigint } from '@/lib/money/format';
import type { AnalyticsCut, PlatformAnalyticsFlows } from '@/lib/admin/analyticsFlows';
import { SectionEyebrow, SectionUnavailable } from '../shared';
import type { SectionData } from '../types';

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

function CutEmptyLine({ cutId }: { cutId: string }) {
  return (
    <p data-testid={`analytics-cut-${cutId}-empty`} className="mt-3 text-sm leading-relaxed text-white/50">
      No royalty postings yet — rows appear with the first royalty ingest that lands in this cut.
    </p>
  );
}

function CutUnavailableLine({ cutId }: { cutId: string }) {
  return (
    <p data-testid={`analytics-cut-${cutId}-unavailable`} className="mt-3 text-sm leading-relaxed text-amber-300/80">
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
  return (
    <section aria-label={title} className="glass-card p-6">
      <h3 className="font-mono text-xs uppercase tracking-[0.25em] text-white/60">{title}</h3>
      <p className="mt-1 text-sm text-white/40">{description}</p>
      {cut.state === 'ready' ? (
        cut.rows.length > 0 ? (
          <ul className="mt-3 divide-y divide-white/5">
            {cut.rows.map((row) => (
              <li
                key={row.label}
                data-testid={`analytics-cut-${cutId}-row`}
                className="flex items-center justify-between gap-4 py-2.5 text-sm"
              >
                <span className="font-mono text-xs tracking-wider text-white/70">{row.label}</span>
                <span className="font-mono text-sm text-white">{formatCentsBigint(row.totalCents)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <CutEmptyLine cutId={cutId} />
        )
      ) : cut.state === 'empty' ? (
        <CutEmptyLine cutId={cutId} />
      ) : (
        <CutUnavailableLine cutId={cutId} />
      )}
    </section>
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
        <div className="mt-8 grid gap-4">
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
