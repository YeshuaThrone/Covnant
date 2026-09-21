/**
 * Tax — the console's TAX DATA SHEET (founder directive, 2026-09-21:
 * "now we need a tax data sheet so the tax agents job is easier and we are
 * in compliance", plus the addendum that it reflect EVERY creator).
 *
 * Two honest layers on every table: the LEDGER layer — exact minor-unit
 * sums from the Don settlement engine, identical to the Ledger finances
 * tab — and the TAX layer — every payee payout resolved through
 * CovnantTaxEngineSDK (the tax engine of record): withholding, state
 * nexus tax, net clearing payout, effective rate, form triggered, and the
 * tax-escrow lock state with its reason. The ledger net is the PRE-TAX
 * distributable; the engine resolves the final clean yield before the
 * 50/35/15 release. HELD_IN_TAX_ESCROW rows read amber with the lock
 * reason visible; CLEARED rows stay normal. The CSV download hands the
 * tax agent the whole sheet — both layers, every creator of record.
 */

import { formatMinor } from '@/lib/ledger/reconciliation';
import { SectionEyebrow, StatusPill } from '../shared';
import type { TaxSectionData, TaxPayeeRowView } from '../types';

const usdCentsFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Engine-layer USD cents formatted for display. */
function formatEngineCents(cents: bigint): string {
  return usdCentsFormat.format(Number(cents) / 100);
}

/** Combined effective rate as a percent. */
function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

/** USD decimal (the YTD running totals) formatted for display. */
function formatUsd(usd: number): string {
  return usdCentsFormat.format(usd);
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

/** The tax-escrow lock chip — amber with the reason visible (canon: honesty). */
function LockChip({ state, reason }: { state: string; reason: string | null }) {
  if (state !== 'HELD_IN_TAX_ESCROW') return null;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <StatusPill label="Held in tax escrow" tone="amber" />
      {reason ? (
        <span className="font-mono text-[10px] leading-tight text-amber-300/80">{reason}</span>
      ) : null}
    </span>
  );
}

/** The payee's identity line of record — UCT ID over the legal name. */
function payeeCell(payee: TaxPayeeRowView): string {
  return payee.uctId ? `${payee.payeeName} · ${payee.uctId}` : payee.payeeName;
}

export function TaxSection({ tax }: { tax: TaxSectionData }) {
  return (
    <div aria-label="Tax">
      <div className="flex items-center justify-between gap-3">
        <SectionEyebrow>Tax data sheet</SectionEyebrow>
        {tax.demo ? <DemoBadge /> : null}
      </div>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        The withholding register, period summaries, and the CBT-stamped transaction
        register for every creator of record — the ledger layer is the pre-tax
        distributable, and the Covnant tax engine of record resolves the final clean
        clearing yield before the 50 / 35 / 15 release. The CSV export carries both
        layers so the tax agent files from one sheet.
      </p>
      <div className="mt-4">
        <a
          href="/api/v1/admin/tax/export"
          data-testid="tax-export-link"
          className="inline-flex items-center rounded-md border border-gold/40 bg-gold/10 px-4 py-2 text-sm font-medium text-gold transition hover:bg-gold/20"
        >
          Download tax sheet (CSV)
        </a>
      </div>

      {tax.transactions.length === 0 ? (
        <div className="mt-6 glass-card p-6">
          <p className="text-sm text-white/50">
            No cleared settlements recorded yet — the tax sheet hydrates after the
            first settlement posts to the ledger store, on the /ledger page or
            through a platform claims webhook.
          </p>
        </div>
      ) : (
        <>
          {/* Withholding register — EVERY creator of record, both layers, one row per payee. */}
          <section aria-label="Withholding register" className="mt-6">
            <h3 className="text-lg font-semibold text-white">Withholding register — every creator of record</h3>
            <p className="mt-2 max-w-2xl text-sm text-white/50">
              One row per payee identity in the master store: UCT identity with ISNI
              and IPI where on file, jurisdiction, TIN state, the ledger layer of
              record, and the tax engine&apos;s resolution with running YTD gross.
              Held rows sit in tax escrow with the reason stated.
            </p>
            <div className="mt-4 overflow-x-auto rounded-lg border border-white/10" data-testid="tax-withholding-register">
              <table className="status-table">
                <thead>
                  <tr>
                    <th className="px-4 py-3 font-medium">Payee</th>
                    <th className="px-4 py-3 font-medium">ISNI</th>
                    <th className="px-4 py-3 font-medium">IPI</th>
                    <th className="px-4 py-3 font-medium">Jurisdiction</th>
                    <th className="px-4 py-3 font-medium">TIN</th>
                    <th className="px-4 py-3 font-medium">Form</th>
                    <th className="px-4 py-3 font-medium text-right">Txns</th>
                    <th className="px-4 py-3 font-medium text-right">Gross paid</th>
                    <th className="px-4 py-3 font-medium text-right">Withheld</th>
                    <th className="px-4 py-3 font-medium text-right">Net</th>
                    <th className="px-4 py-3 font-medium text-right">YTD gross</th>
                    <th className="px-4 py-3 font-medium text-right">Effective rate</th>
                    <th className="px-4 py-3 font-medium">Tax escrow</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {tax.payees.map((payee) => (
                    <tr key={payee.payeeId}>
                      <td className="px-4 py-3 text-white">{payeeCell(payee)}</td>
                      <td className="px-4 py-3 font-mono text-xs text-white/60">{payee.isni ?? 'Not on file'}</td>
                      <td className="px-4 py-3 font-mono text-xs text-white/60">{payee.ipi ?? 'Not on file'}</td>
                      <td className="px-4 py-3 font-mono text-xs text-white/60">{payee.jurisdiction ?? 'Not on file'}</td>
                      <td className="px-4 py-3">
                        <StatusPill label={payee.tinStatus} tone={payee.tinStatus === 'VERIFIED' ? 'jade' : 'amber'} />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-white/60">{payee.forms.join(' | ')}</td>
                      <td className="px-4 py-3 text-right text-white/60">{payee.transactionCount}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/80">
                        {formatMinor(payee.grossMinor, 'USD')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/60">
                        {formatMinor(payee.withheldMinor, 'USD')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/80">
                        {formatMinor(payee.netMinor, 'USD')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/60">
                        {formatUsd(payee.ytdClearedGrossUsd)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/80">
                        {formatRate(payee.effectiveRate)}
                      </td>
                      <td className="px-4 py-3">
                        <LockChip state={payee.lockState} reason={payee.lockReason} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Period summary — per tax year across every creator. */}
          <section aria-label="Period summary" className="mt-8">
            <h3 className="text-lg font-semibold text-white">Period summary by tax year</h3>
            <p className="mt-2 max-w-2xl text-sm text-white/50">
              The filing year at a glance — ledger totals of record beside the tax
              engine&apos;s resolution for the same settlements.
            </p>
            <div className="mt-4 overflow-x-auto rounded-lg border border-white/10" data-testid="tax-period-summary">
              <table className="status-table">
                <thead>
                  <tr>
                    <th className="px-4 py-3 font-medium">Tax year</th>
                    <th className="px-4 py-3 font-medium text-right">Transactions</th>
                    <th className="px-4 py-3 font-medium text-right">Gross</th>
                    <th className="px-4 py-3 font-medium text-right">Fee</th>
                    <th className="px-4 py-3 font-medium text-right">Withholding</th>
                    <th className="px-4 py-3 font-medium text-right">Corner dust</th>
                    <th className="px-4 py-3 font-medium text-right">Net</th>
                    <th className="px-4 py-3 font-medium text-right">Engine withholding</th>
                    <th className="px-4 py-3 font-medium text-right">Engine state tax</th>
                    <th className="px-4 py-3 font-medium text-right">Engine net payout</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {tax.periods.map((period) => (
                    <tr key={period.year}>
                      <td className="px-4 py-3 font-mono text-xs text-white">{period.year}</td>
                      <td className="px-4 py-3 text-right text-white/60">{period.transactions}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/80">
                        {formatMinor(period.grossMinor, 'USD')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/60">
                        {formatMinor(period.feeMinor, 'USD')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/60">
                        {formatMinor(period.withheldMinor, 'USD')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-[#FFD700]/90">
                        {formatMinor(period.dustMinor, 'USD')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/80">
                        {formatMinor(period.netMinor, 'USD')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/60">
                        {formatEngineCents(period.engine.withheldCents)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/60">
                        {formatEngineCents(period.engine.stateTaxCents)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-gold">
                        {formatEngineCents(period.engine.netCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Per-currency rollup — the tax engine resolves USD; other currencies stay disclosed. */}
          <section aria-label="Per-currency rollup" className="mt-8">
            <h3 className="text-lg font-semibold text-white">Per-currency rollup</h3>
            <p className="mt-2 max-w-2xl text-sm text-white/50">
              Every settled currency at its exact minor units — currencies are never
              summed across each other; the ledger stores no FX.
              {tax.excludedNonUsdSettlements > 0
                ? ` ${tax.excludedNonUsdSettlements} settlement${tax.excludedNonUsdSettlements === 1 ? '' : 's'} outside the USD engine appear here only — the tax engine of record resolves USD settlements.`
                : ''}
            </p>
            <div className="mt-4 overflow-x-auto rounded-lg border border-white/10" data-testid="tax-currency-rollup">
              <table className="status-table">
                <thead>
                  <tr>
                    <th className="px-4 py-3 font-medium">Currency</th>
                    <th className="px-4 py-3 font-medium text-right">Settlements</th>
                    <th className="px-4 py-3 font-medium text-right">Gross</th>
                    <th className="px-4 py-3 font-medium text-right">Fees incl. dust</th>
                    <th className="px-4 py-3 font-medium text-right">Corner dust</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {tax.currencies.map((totals) => (
                    <tr key={totals.currency}>
                      <td className="px-4 py-3 font-mono text-xs text-white">{totals.currency}</td>
                      <td className="px-4 py-3 text-right text-white/60">{totals.settlements}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/80">
                        {formatMinor(totals.grossMinor, totals.currency)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/60">
                        {formatMinor(totals.feeMinor, totals.currency)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-[#FFD700]/90">
                        {formatMinor(totals.dustMinor, totals.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Transaction register — CBT-stamped rows, both layers per settlement. */}
          <section aria-label="Transaction register" className="mt-8">
            <h3 className="text-lg font-semibold text-white">Transaction register — CBT stamped</h3>
            <p className="mt-2 max-w-2xl text-sm text-white/50">
              Every CBT-stamped settlement with its CVT lineage, template binding,
              and both layers of record: the ledger&apos;s gross, fee, corner dust,
              withholding, and net, then the tax engine&apos;s resolution per
              settlement. Reconciliation of record per row: gross equals covenant
              fee plus withholding plus net — the fee carries the swept corner dust.
            </p>
            <div className="mt-4 overflow-x-auto rounded-lg border border-white/10" data-testid="tax-transaction-register">
              <table className="status-table">
                <thead>
                  <tr>
                    <th className="px-4 py-3 font-medium">Date</th>
                    <th className="px-4 py-3 font-medium">Transaction</th>
                    <th className="px-4 py-3 font-medium">CBT</th>
                    <th className="px-4 py-3 font-medium">CVT</th>
                    <th className="px-4 py-3 font-medium">Entity type</th>
                    <th className="px-4 py-3 font-medium">Template</th>
                    <th className="px-4 py-3 font-medium text-right">Payees</th>
                    <th className="px-4 py-3 font-medium text-right">Gross</th>
                    <th className="px-4 py-3 font-medium text-right">Fee</th>
                    <th className="px-4 py-3 font-medium text-right">Corner dust</th>
                    <th className="px-4 py-3 font-medium text-right">Withheld</th>
                    <th className="px-4 py-3 font-medium text-right">Net</th>
                    <th className="px-4 py-3 font-medium text-right">Engine withholding</th>
                    <th className="px-4 py-3 font-medium text-right">Engine state tax</th>
                    <th className="px-4 py-3 font-medium text-right">Engine net payout</th>
                    <th className="px-4 py-3 font-medium text-right">Effective rate</th>
                    <th className="px-4 py-3 font-medium">Form</th>
                    <th className="px-4 py-3 font-medium">Tax escrow</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {tax.transactions.map((row) => (
                    <tr key={row.transactionId}>
                      <td className="px-4 py-3 font-mono text-xs text-white/60">{row.date.slice(0, 10)}</td>
                      <td className="px-4 py-3 font-mono text-xs text-white/80">{row.transactionId}</td>
                      <td className="px-4 py-3 font-mono text-xs text-white/60">{row.cbt}</td>
                      <td className="px-4 py-3 font-mono text-xs text-white/60">{row.cvt}</td>
                      <td className="px-4 py-3 text-white/60">{row.entityType ?? row.cbt.split('-')[1] ?? row.cbt}</td>
                      <td className="px-4 py-3 font-mono text-xs text-white/60">{row.template ?? 'Unbound'}</td>
                      <td className="px-4 py-3 text-right text-white/60">{row.payeeCount}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/80">
                        {formatMinor(row.grossMinor, 'USD')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/60">
                        {formatMinor(row.feeMinor, 'USD')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-[#FFD700]/90">
                        {formatMinor(row.dustMinor, 'USD')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/60">
                        {formatMinor(row.withheldMinor, 'USD')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/80">
                        {formatMinor(row.netMinor, 'USD')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/60">
                        {formatEngineCents(row.engine.withheldCents)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/60">
                        {formatEngineCents(row.engine.stateTaxCents)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-gold">
                        {formatEngineCents(row.engine.netCents)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-white/80">
                        {formatRate(row.effectiveRate)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-white/60">{row.forms.join(' | ')}</td>
                      <td className="px-4 py-3">
                        <LockChip state={row.lockState} reason={row.lockReason} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 font-mono text-xs text-white/30">
              Ledger figures in exact currency minor units; engine figures in integer
              cents. The engine gross input equals the stored disbursement gross share
              per payee — one truth, never copied numbers.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
