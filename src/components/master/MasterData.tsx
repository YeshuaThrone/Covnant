/**
 * MasterData — the shared presentational layer of the admin master data
 * surfaces (founder canon, CovnantMasterDataSDK): the seven-vertical tab bar,
 * the allocation stat cards, and the sovereign ledger table. PURE PRESENTATION
 * — every dollar rendered here arrives as an engine-computed integer-cent
 * figure from the master ledger store; nothing is formatted from a constant.
 *
 * Shells stay frozen: the tab pills, glass cards, and status chips reuse the
 * established gold/obsidian classes already on the foundation pages.
 */

import { formatCents } from '@/lib/money/format';
import type {
  ClearinghouseStatus,
  SovereignLedgerRecord,
  SovereignLedgerSummary,
} from '@/lib/master/sovereignLedger';

/**
 * The seven-vertical tab bar — a client component in its own file (the
 * arrow-key interaction needs 'use client'); re-exported here so every host
 * page's import site is unchanged (UI audit #11).
 */
export { MasterCategoryTabs } from './MasterCategoryTabs';

/** Clearinghouse status chip — the three canon states, distinct voices. */
export function ClearinghouseChip({ status }: { status: ClearinghouseStatus }): React.JSX.Element {
  const classes: Record<ClearinghouseStatus, string> = {
    VERIFIED_IMMUTABLE: 'border-emerald-400/40 text-emerald-300',
    ACTIVE_YIELD: 'border-gold/50 text-gold',
    PENDING_CLEARANCE: 'border-amber-300/40 text-amber-300',
  };
  return (
    <span
      data-testid="clearinghouse-status"
      className={`inline-block rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.15em] ${classes[status]}`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

/**
 * The 50/35/15 split pills — the canon weights LABEL the buckets; the
 * amounts are the engine's allocation output (integer cents, formatted).
 */
export function SplitPills({
  allocations,
}: {
  allocations: SovereignLedgerRecord['allocations'];
}): React.JSX.Element {
  const pills: Array<[string, string, number]> = [
    ['Ownership reserve', '50%', allocations.ownershipReserveCents],
    ['Creative royalty', '35%', allocations.creativeRoyaltyCents],
    ['Production ops', '15%', allocations.productionOperationsCents],
  ];
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="sovereign-split-pills">
      {pills.map(([label, weight, cents]) => (
        <span
          key={label}
          className="inline-flex items-center gap-1 rounded-full border border-gold/25 bg-gold/5 px-2.5 py-0.5 font-mono text-[10px] text-gold-champagne"
        >
          {label} {weight} · {formatCents(cents)}
        </span>
      ))}
    </div>
  );
}

/** Deterministic UTC date render — hydration-safe, fixed locale. */
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

/** The sovereign ledger table — every cell populated, never a dash. */
export function SovereignLedgerTable({
  records,
}: {
  records: readonly SovereignLedgerRecord[];
}): React.JSX.Element {
  return (
    <div className="glass-card overflow-x-auto" data-testid="sovereign-ledger-table">
      <table className="status-table min-w-[900px]">
        <thead>
          <tr>
            <th className="px-4 py-3">Ledger ID</th>
            <th className="px-4 py-3">Asset title</th>
            <th className="px-4 py-3">Subcategory</th>
            <th className="px-4 py-3">Rights holder</th>
            <th className="px-4 py-3 text-right">Gross volume</th>
            <th className="px-4 py-3">50 / 35 / 15 allocation</th>
            <th className="px-4 py-3">Clearinghouse</th>
            <th className="px-4 py-3">Settled</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {records.map((record) => (
            <tr key={record.ledgerId} data-testid="sovereign-ledger-row" data-ledger-id={record.ledgerId}>
              <td className="px-4 py-3 font-mono text-xs text-gold">{record.ledgerId}</td>
              <td className="px-4 py-3 text-white">{record.assetTitle}</td>
              <td className="px-4 py-3 text-white/70">{record.subcategory}</td>
              <td className="px-4 py-3 font-mono text-xs text-white/50">{record.rightsHolderHash}</td>
              <td className="px-4 py-3 text-right font-mono text-white">{formatCents(record.grossVolumeCents)}</td>
              <td className="px-4 py-3">
                <SplitPills allocations={record.allocations} />
              </td>
              <td className="px-4 py-3">
                <ClearinghouseChip status={record.clearinghouseStatus} />
              </td>
              <td className="px-4 py-3 font-mono text-xs text-white/60">
                {settledOn(record.settlementTimestamp)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The allocation stat cards — aggregates computed from the records. */
export function MasterStatCards({
  summary,
}: {
  summary: SovereignLedgerSummary;
}): React.JSX.Element {
  const cards: Array<[string, string, string]> = [
    ['Gross volume', formatCents(summary.grossVolumeCents), `${summary.recordCount} settled records`],
    ['Ownership reserve', formatCents(summary.ownershipReserveCents), '50% of gross'],
    ['Creative royalty', formatCents(summary.creativeRoyaltyCents), '35% of gross'],
    ['Production operations', formatCents(summary.productionOperationsCents), '15% of gross'],
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="master-stat-cards">
      {cards.map(([label, value, note]) => (
        <div key={label} className="glass-card p-4">
          <dt className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">{label}</dt>
          <dd className="mt-1 font-mono text-sm text-gold">{value}</dd>
          <dd className="mt-0.5 text-[11px] text-white/40">{note}</dd>
        </div>
      ))}
    </dl>
  );
}
