/**
 * Ledger — the console's FINANCES surface (founder directive, 2026-09-20:
 * "the ledger page should have the finances correct ... I need that back
 * but catered to finances").
 *
 * Renders the corner-dust settlement view — gross, platform fees including
 * the dust, withholding, net per holder, escrow state, and payout flows —
 * from the SAME engine paths the /ledger page reads: the rows arrive
 * hydrated through src/lib/ledger/finances (one truth, never copied
 * strings), the per-currency math is the /ledger page's own
 * reconciliation module (BigInt minor units), and the escrow state folds
 * the stored disbursements in micro units. The master clearing ledger
 * (50/35/15 records) stays in view below — it is financial. The console
 * has no ledger write path — money stays in the stamped settlement
 * pipeline.
 */

import { useMemo } from 'react';
import { formatMinor, reconcileLedger } from '@/lib/ledger/reconciliation';
import { escrowStateFromRows } from '@/lib/ledger/finances';
import { microToNumber } from '@/lib/fixed-point';
import { formatLedgerAmount } from '@/lib/ledger/micro-adapter';
import type { LedgerFinancesSection, MasterLedgerSection } from '../types';
import { MasterStatCards, SovereignLedgerTable } from '@/components/master/MasterData';
import { SectionEyebrow } from '../shared';
import { SettlementRowsTable } from '@/components/ledger/SettlementRows';

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

export function LedgerSection({
  finances,
  master,
}: {
  finances: LedgerFinancesSection;
  master?: MasterLedgerSection;
}) {
  // One reconciliation pass drives both the per-currency table and the row
  // status badges — the /ledger page's own engine output.
  const reconciliation = useMemo(() => reconcileLedger(finances.rows), [finances.rows]);
  const escrow = useMemo(() => escrowStateFromRows(finances.rows), [finances.rows]);

  return (
    <div aria-label="Ledger">
      <div className="flex items-center justify-between gap-3">
        <SectionEyebrow>Ledger finances</SectionEyebrow>
        {finances.demo ? <DemoBadge /> : null}
      </div>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        The settlement math chain — gross, platform fees, withholding, corner dust,
        and net per holder — with escrow state and payout flows, read from the same
        engine output the /ledger page renders. Every vertical of entertainment;
        the console never writes the ledger.
      </p>

      {finances.rows.length === 0 ? (
        <div className="mt-6 glass-card p-6">
          <p className="text-sm text-white/50">
            No settlements recorded yet — the finances view hydrates after the first
            settlement posts to the ledger store, on the /ledger page or through a
            platform claims webhook.
          </p>
        </div>
      ) : (
        <>
          {/* Per-currency settlement chain — the /ledger page's reconciliation engine output, formatted in exact minor units. */}
          <section aria-label="Corner-dust settlement chain" className="mt-6">
            <h3 className="text-lg font-semibold text-white">
              Settlement chain by currency — corner dust of record
            </h3>
            <p className="mt-2 max-w-2xl text-sm text-white/50">
              The engine&apos;s integer path: gross minus platform fees (fees include the
              swept dust) — corner dust isolated per currency, never a float sum.
            </p>
            <div className="mt-4 overflow-x-auto rounded-lg border border-white/10" data-testid="corner-dust-settlement-table">
              <table className="status-table">
                <thead>
                  <tr>
                    <th className="px-4 py-3 font-medium">Currency</th>
                    <th className="px-4 py-3 font-medium">Settlements</th>
                    <th className="px-4 py-3 font-medium text-right">Gross</th>
                    <th className="px-4 py-3 font-medium text-right">Fees incl. dust</th>
                    <th className="px-4 py-3 font-medium text-right">Corner dust</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {reconciliation.byCurrency.map((totals) => (
                    <tr key={totals.currency}>
                      <td className="px-4 py-3 font-mono text-xs text-white">{totals.currency}</td>
                      <td className="px-4 py-3 text-white/60">{totals.settlements}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/80">
                        {formatMinor(totals.grossMinor, totals.currency)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/60">
                        {formatMinor(totals.feesMinor, totals.currency)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-[#FFD700]/90" data-testid="corner-dust-minor-cell">
                        {formatMinor(totals.dustMinor, totals.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Settlement rows — the shared read-only display, statuses from the reconciliation engine. */}
          <section aria-label="Settlement records" className="mt-8">
            <h3 className="text-lg font-semibold text-white">Settlement records</h3>
            <p className="mt-2 max-w-2xl text-sm text-white/50">
              Every stored settlement with its registry identifiers and disbursement
              drill-down — holder shares, withholding rate and form, payout rail —
              exactly as the /ledger page renders them.
            </p>
            <div className="mt-4">
              <SettlementRowsTable
                rows={finances.rows}
                statusByTransactionId={Object.fromEntries(
                  reconciliation.rows.map((row) => [row.transactionId, row.status]),
                )}
              />
            </div>
          </section>

          {/* Escrow state — net minus payouts per holder, folded from the stored disbursements. */}
          <section aria-label="Escrow state" className="mt-8">
            <h3 className="text-lg font-semibold text-white">Escrow state per holder</h3>
            <p className="mt-2 max-w-2xl text-sm text-white/50">
              Engine-settled gross, withholding, and net folded per rights holder from
              the stored disbursements — payout debits subtracted to the available
              balance. Per-currency, never summed across.
            </p>
            <div className="mt-4 overflow-x-auto rounded-lg border border-white/10" data-testid="escrow-state-table">
              <table className="status-table">
                <thead>
                  <tr>
                    <th className="px-4 py-3 font-medium">Holder</th>
                    <th className="px-4 py-3 font-medium">Currencies</th>
                    <th className="px-4 py-3 font-medium text-right">Gross earned</th>
                    <th className="px-4 py-3 font-medium text-right">Withheld</th>
                    <th className="px-4 py-3 font-medium text-right">Net</th>
                    <th className="px-4 py-3 font-medium text-right">Paid out</th>
                    <th className="px-4 py-3 font-medium text-right">Available</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {escrow.map((holder) => {
                    const reference = holder.currencies[0] ?? 'USD';
                    return (
                      <tr key={holder.rightsHolderId}>
                        <td className="px-4 py-3 text-white">{holder.name}</td>
                        <td className="px-4 py-3 font-mono text-xs text-white/60">
                          {holder.currencies.join(', ')}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-white/80">
                          {formatLedgerAmount(microToNumber(holder.grossUnits), reference)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-white/60">
                          {formatLedgerAmount(microToNumber(holder.withheldUnits), reference)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-white/80">
                          {formatLedgerAmount(microToNumber(holder.netUnits), reference)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-white/60">
                          {formatLedgerAmount(microToNumber(holder.paidOutUnits), reference)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-gold">
                          {formatLedgerAmount(
                            microToNumber(holder.netUnits - holder.paidOutUnits),
                            reference,
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 font-mono text-xs text-white/30">
              Folded in micro units (1e-8) — the escrow module&apos;s integer space. Payout
              debits post when a withdrawal clears the rail.
            </p>
          </section>
        </>
      )}

      {master ? (
        <section aria-label="Master clearing ledger" className="mt-10">
          <h3 className="text-lg font-semibold text-white">
            Master clearing ledger — every vertical of entertainment
          </h3>
          <p className="mt-2 max-w-2xl text-sm text-white/50">
            The clearing records with their 50 / 35 / 15 allocations — financial
            master data, engine-computed in integer cents.
          </p>
          <div className="mt-4 space-y-4">
            <MasterStatCards summary={master.summary} />
            <SovereignLedgerTable records={master.records} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
