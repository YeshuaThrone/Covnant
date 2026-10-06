/**
 * RegistryAdminDashboard — canon v20 Section 2: the identifier engine's
 * admin surface. Server-rendered (no client state): the metrics grid and
 * tables read the RegistryDashboardData the page fetched from the 0012
 * tables; search is a GET form and the vertical filter is canon
 * vocabulary (ALL | PRO_SPORTS | FINE_ART | SUPPLY_CHAIN | HARDWARE |
 * CORPORATE). Honesty law: empty tables say so; an unavailable read
 * renders its message — no simulated metrics.
 */

import type {
  RegistryDashboardData,
  RegistryDashboardUnavailable,
} from '@/lib/admin/registryDashboard';
import { REGISTRY_VERTICAL_FILTERS } from '@/lib/admin/registryDashboard';

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">
        {label}
      </p>
      <p className="mt-2 font-mono text-2xl text-white" data-testid="registry-metric-value">
        {value}
      </p>
    </div>
  );
}

function EntityTable({
  rows,
  emptyLabel,
  testId,
}: {
  rows: Array<{
    entityId: string;
    vertical: string;
    codeType: string;
    codeValue: string;
    linkageTier: string;
    createdAt: string;
  }>;
  emptyLabel: string;
  testId: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="font-mono text-sm text-white/50" data-testid={`${testId}-empty`}>
        {emptyLabel}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto" data-testid={testId}>
      <table className="w-full border-collapse text-left font-mono text-xs text-white/80">
        <thead>
          <tr className="text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">
            <th className="border-b border-slate-600/50 py-2 pr-4">Entity</th>
            <th className="border-b border-slate-600/50 py-2 pr-4">Vertical</th>
            <th className="border-b border-slate-600/50 py-2 pr-4">Type</th>
            <th className="border-b border-slate-600/50 py-2 pr-4">Code</th>
            <th className="border-b border-slate-600/50 py-2 pr-4">Tier</th>
            <th className="border-b border-slate-600/50 py-2">Recorded</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.linkageTier}-${row.codeType}-${row.codeValue}-${index}`}>
              <td className="border-b border-slate-700/40 py-2 pr-4 text-white/50">
                {row.entityId.slice(0, 8)}…
              </td>
              <td className="border-b border-slate-700/40 py-2 pr-4">{row.vertical}</td>
              <td className="border-b border-slate-700/40 py-2 pr-4">{row.codeType}</td>
              <td className="border-b border-slate-700/40 py-2 pr-4">{row.codeValue}</td>
              <td className="border-b border-slate-700/40 py-2 pr-4">
                {row.linkageTier === 'PRIMARY' ? 'PRIMARY' : 'CROSS_REFERENCE'}
              </td>
              <td className="border-b border-slate-700/40 py-2 text-white/50">
                {formatDate(row.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RegistryAdminDashboard({
  data,
}: {
  data: RegistryDashboardData | RegistryDashboardUnavailable;
}) {
  if (!data.available) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10" aria-label="Registry admin dashboard">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">
          Covnant · Operator Console · Registry Admin
        </p>
        <div className="mt-6 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
          <p
            data-testid="registry-dashboard-unavailable"
            className="font-mono text-sm text-white/50"
          >
            {data.message}
          </p>
        </div>
      </div>
    );
  }

  const { metrics, verticals, auditLog, entities, redis, searched, verticalFilter } =
    data;

  const filterHref = (filter: string) => {
    const params = new URLSearchParams();
    if (filter !== 'ALL') params.set('vertical', filter);
    if (searched) params.set('q', searched);
    const qs = params.toString();
    return qs ? `/admin/registry?${qs}` : '/admin/registry';
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-10" aria-label="Registry admin dashboard">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">
        Covnant · Operator Console · Registry Admin
      </p>
      <h1 className="mt-2 text-3xl font-semibold text-white md:text-4xl">Registry Admin Dashboard</h1>
      <p className="mt-1 font-mono text-xs text-white/50">
        Universal identifier engine — 0012 tables
        {redis.reachable
          ? ' · Redis cache reachable'
          : ' · Redis cache unreachable (fail-open)'}
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-3">
        <MetricCell label="Identity Map Rows" value={formatCount(metrics.totalIdentities)} />
        <MetricCell
          label="Cross-References"
          value={formatCount(metrics.totalCrossReferences)}
        />
        <MetricCell label="Verticals Present" value={formatCount(metrics.verticalCount)} />
      </div>

      <form action="/admin/registry" method="get" className="mt-8 flex items-center gap-3">
        <input
          type="search"
          name="q"
          defaultValue={searched ?? ''}
          placeholder="Search code type or value…"
          aria-label="Registry code search"
          className="w-full rounded-xl border border-slate-600/50 bg-white/[0.04] px-4 py-2 font-mono text-sm text-white placeholder:text-white/30 focus:border-gold-champagne/60 focus:outline-none"
        />
        {verticalFilter !== 'ALL' ? (
          <input type="hidden" name="vertical" value={verticalFilter} />
        ) : null}
        <button
          type="submit"
          className="rounded-xl border border-gold-champagne/50 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-gold-champagne hover:bg-gold-champagne/10"
        >
          Search
        </button>
      </form>

      <div className="mt-4 flex flex-wrap gap-2" data-testid="registry-vertical-filter">
        {REGISTRY_VERTICAL_FILTERS.map((filter) => (
          <a
            key={filter}
            href={filterHref(filter)}
            className={`rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] ${
              filter === verticalFilter
                ? 'border-gold-champagne/70 bg-gold-champagne/10 text-gold-champagne'
                : 'border-slate-600/50 text-white/60 hover:border-gold-champagne/40'
            }`}
          >
            {filter}
          </a>
        ))}
      </div>

      <section className="mt-8">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">
          Registry Entries{searched ? ` — “${searched}”` : ''}
        </h2>
        <div className="mt-3">
          <EntityTable
            rows={entities}
            testId="registry-entities"
            emptyLabel={
              searched
                ? `No registry entries match “${searched}” under the ${verticalFilter} filter.`
                : 'No registry entries recorded yet — ingest through batch-ingest or telemetry-stream.'
            }
          />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">
          Cross-Registry Linkage Audit Log
        </h2>
        <div className="mt-3">
          <EntityTable
            rows={auditLog}
            testId="registry-audit-log"
            emptyLabel="No cross-registry links recorded yet."
          />
        </div>
      </section>

      {verticals.length > 0 ? (
        <section className="mt-10">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">
            Verticals
          </h2>
          <div className="mt-3" data-testid="registry-verticals">
            {verticals.map((row) => (
              <p
                key={row.vertical}
                className="border-b border-slate-700/40 py-2 font-mono text-xs text-white/80"
              >
                {row.vertical} — {formatCount(row.identities)} identities ·{' '}
                {formatCount(row.crossReferences)} cross-references
              </p>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
