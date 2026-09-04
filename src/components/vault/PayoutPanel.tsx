import type { AssetPayouts } from '@/lib/contracts/payouts';

/**
 * Contract payout views — directive §4.
 *
 * Presentational table over the shaped ledger READ rows for this agreement's
 * asset of record: split/licensing-fee flows against incoming revenue. Empty
 * state renders when the asset has no settled revenue yet.
 */

export function PayoutPanel({ payouts }: { payouts: AssetPayouts }) {
  const { flows, totals } = payouts;

  return (
    <section className="glass-card p-6" aria-label="Payout flows">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">
        Payout flows
      </p>
      <p className="mt-2 text-sm text-white/50">
        Split and licensing-fee flows against incoming revenue, read from the royalty ledger —
        display only; every settlement is reconciled by the embedded auditor before it posts.
      </p>

      {flows.length === 0 ? (
        <p className="mt-4 rounded-lg border border-white/10 bg-white/5 p-4 text-sm text-white/50">
          No settled revenue for this asset yet. Flows appear here as settlements land in the
          ledger.
        </p>
      ) : (
        <>
          <table className="mt-4 w-full text-sm" data-testid="payout-flows-table">
            <thead>
              <tr className="text-left font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">
                <th className="pb-2 font-normal">Settlement</th>
                <th className="pb-2 font-normal">Party</th>
                <th className="pb-2 text-right font-normal">Recorded</th>
                <th className="pb-2 text-right font-normal">Gross share</th>
                <th className="pb-2 text-right font-normal">Withheld</th>
                <th className="pb-2 text-right font-normal">Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {flows.flatMap((flow) =>
                flow.lines.map((line, i) => (
                  <tr key={`${flow.transactionId}:${line.holder}:${i}`}>
                    <td className="py-2.5 align-top font-mono text-xs text-white/50">
                      {i === 0 && (
                        <>
                          <span className="block text-white/70">{flow.platform}</span>
                          <span>
                            {flow.currency} {flow.grossSettled.toLocaleString('en-US')} gross
                          </span>
                        </>
                      )}
                    </td>
                    <td className="py-2.5 align-top text-white">
                      {line.holder}
                      <span className="block text-xs text-white/40">{line.role}</span>
                    </td>
                    <td className="py-2.5 text-right align-top font-mono text-xs text-[#FFD700]">
                      {line.recordedPercent ? `${line.recordedPercent}%` : '—'}
                    </td>
                    <td className="py-2.5 text-right align-top font-mono text-xs text-white/70">
                      {line.grossShare.toLocaleString('en-US')}
                    </td>
                    <td className="py-2.5 text-right align-top font-mono text-xs text-white/70">
                      {line.withholdingTaxDeducted.toLocaleString('en-US')}
                    </td>
                    <td className="py-2.5 text-right align-top font-mono text-xs text-white/70">
                      {line.netShare.toLocaleString('en-US')}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>

          <div className="mt-4 flex flex-wrap gap-3 border-t border-white/10 pt-4" aria-label="Payout totals">
            {totals.map((total) => (
              <span key={total.currency} className="rounded-full border border-gold/30 px-3 py-1 font-mono text-xs text-[#FFD700]">
                {total.currency} · gross {total.gross.toLocaleString('en-US')} · fees{' '}
                {total.fees.toLocaleString('en-US')} · net {total.net.toLocaleString('en-US')} ·{' '}
                {total.settlements} settlement{total.settlements === 1 ? '' : 's'}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
