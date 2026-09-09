/**
 * Ledger — READ-ONLY, exactly as the pre-gate /admin page rendered it:
 * the same totalsFrom/holderStatsFrom folds over the verified ledger
 * store, moved under the gate. The console has no ledger write path —
 * money stays in the stamped settlement pipeline.
 */

import type { LedgerSummary } from '@/lib/admin/overview';
import { formatChangeValue } from '@/lib/admin/console';
import { SectionEyebrow } from '../shared';

function currenciesOf(record: Record<string, number>): string {
  const rendered = Object.entries(record)
    .map(([currency, value]) => `${value.toFixed(2)} ${currency}`)
    .join(', ');
  return rendered || '—';
}

export function LedgerSection({ ledger }: { ledger: LedgerSummary }) {
  const { totals, holders } = ledger;

  return (
    <div aria-label="Ledger">
      <SectionEyebrow>Universal Royalty Ledger</SectionEyebrow>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        Read-only view over settlement state — the same verified store the public
        /ledger page reads, now behind the operator gate. The console never writes
        the ledger.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="glass-card p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">Settlements</p>
          <p className="mt-1 text-2xl font-semibold text-white">{totals.count}</p>
        </div>
        <div className="glass-card p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">Gross settled</p>
          <p className="mt-1 text-2xl font-semibold text-white">{totals.gross.toFixed(2)}</p>
        </div>
        <div className="glass-card p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">Platform fees</p>
          <p className="mt-1 text-2xl font-semibold text-white">{totals.fees.toFixed(2)}</p>
        </div>
        <div className="glass-card p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">Corner dust</p>
          <p className="mt-1 text-2xl font-semibold text-white">{formatChangeValue(totals.cornerDust)}</p>
        </div>
      </div>

      <h3 className="mt-10 text-lg font-semibold text-white">Holder YTD &amp; tax forms</h3>
      {holders.length === 0 ? (
        <p className="mt-4 text-sm text-white/50">
          No settlements recorded yet — holder statistics appear after the first
          settlement posts to the ledger.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-white/10">
          <table className="status-table">
            <thead>
              <tr>
                <th className="px-4 py-3 font-medium">Holder</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Settlements</th>
                <th className="px-4 py-3 font-medium">Latest form</th>
                <th className="px-4 py-3 font-medium">Gross YTD</th>
                <th className="px-4 py-3 font-medium">Withheld YTD</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {holders.map((holder) => (
                <tr key={holder.id}>
                  <td className="px-4 py-3 text-white">{holder.name}</td>
                  <td className="px-4 py-3 text-white/60">{holder.role}</td>
                  <td className="px-4 py-3 text-white/60">{holder.settlementCount}</td>
                  <td className="px-4 py-3 text-white/60">{holder.latestTaxForm}</td>
                  <td className="px-4 py-3 text-white/60">{currenciesOf(holder.grossYtd)}</td>
                  <td className="px-4 py-3 text-white/60">{currenciesOf(holder.withheldYtd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 font-mono text-xs text-white/30">
        YTD amounts are per-currency — the ledger stores no FX.
      </p>
    </div>
  );
}
