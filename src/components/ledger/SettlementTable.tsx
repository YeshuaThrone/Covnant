'use client';

/**
 * Settlement table — PR 4.
 *
 * Renders ledger rows with a disbursement drill-down (rate, deduction, form, rail
 * from the engine's DisbursementDetail) plus the corner-dust totals strip, and a
 * direct settlement form on the 0%-fee direct path.
 */

import { useMemo, useState, useTransition } from 'react';
import { CURRENCY_DECIMALS } from '@/lib/ledger/currency-precision';
import type { LedgerRow, LedgerTotals } from '@/lib/ledger/store';
import { settleDirectAction } from '@/lib/ledger/actions';

function fmt(amount: number, currency: string): string {
  const decimals = CURRENCY_DECIMALS[currency] ?? 4;
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function SettlementTable({
  rows,
  totals,
  assets,
}: {
  rows: LedgerRow[];
  totals: LedgerTotals;
  assets: { cbtCode: string; title: string }[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {/* Totals strip */}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Settlements', String(totals.count)],
          ['Gross settled', fmt(totals.gross, rows[0]?.currency ?? 'USD') + (rows.length ? ' mixed' : '')],
          ['Covenant fees', fmt(totals.fees, rows[0]?.currency ?? 'USD') + (rows.length ? ' mixed' : '')],
          ['Corner dust', fmt(totals.cornerDust, rows[0]?.currency ?? 'USD') + (rows.length ? ' mixed' : '')],
        ].map(([label, value]) => (
          <div key={label} className="glass-card p-4">
            <dt className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">{label}</dt>
            <dd className="mt-1 font-mono text-sm text-gold">{value}</dd>
          </div>
        ))}
      </dl>
      {rows.length > 0 && (
        <p className="text-xs text-white/40">
          Totals sum raw ledger units across currencies — per-currency figures live in each row.
        </p>
      )}

      <SettleForm assets={assets} />

      {/* Table */}
      <div className="glass-card overflow-x-auto">
        <table className="status-table min-w-[760px]">
          <thead>
            <tr>
              <th className="px-4 py-3">Transaction</th>
              <th className="px-4 py-3">Asset</th>
              <th className="px-4 py-3">Platform</th>
              <th className="px-4 py-3 text-right">Gross</th>
              <th className="px-4 py-3 text-right">Fee</th>
              <th className="px-4 py-3 text-right">Dust</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-white/50">
                  No settlements recorded yet. Settle a registered asset above, or point a platform
                  claims webhook at <code className="font-mono text-gold">/api/webhooks/claims</code>.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const open = expanded === row.transactionId;
              return (
                <TableRow
                  key={row.transactionId}
                  row={row}
                  open={open}
                  onToggle={() => setExpanded(open ? null : row.transactionId)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TableRow({ row, open, onToggle }: { row: LedgerRow; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr
        className="cursor-pointer border-b border-white/5 transition hover:bg-white/5"
        onClick={onToggle}
        aria-expanded={open}
      >
        <td className="px-4 py-3 font-mono text-xs text-white/80">{row.transactionId}</td>
        <td className="px-4 py-3 font-mono text-xs text-gold">{row.cbtCode}</td>
        <td className="px-4 py-3 text-white/60">{row.platform}</td>
        <td className="px-4 py-3 text-right font-mono text-xs">
          {fmt(row.grossSettled, row.currency)} {row.currency}
        </td>
        <td className="px-4 py-3 text-right font-mono text-xs text-white/60">
          {fmt(row.covenantFee, row.currency)}
        </td>
        <td className="px-4 py-3 text-right font-mono text-xs text-[#FFD700]/80">
          {fmt(row.cornerDustCollected, row.currency)}
        </td>
        <td className="px-4 py-3">
          <span className="rounded-full border border-emerald-400/40 px-2 py-0.5 font-mono text-[10px] uppercase text-emerald-300">
            PASS
          </span>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-white/5 bg-white/[0.03]">
          <td colSpan={7} className="px-4 py-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">
              Disbursement detail — {row.disbursements.length} rights holders
            </p>
            <table className="mt-3 w-full text-left text-xs">
              <thead>
                <tr className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">
                  <th className="py-2 pr-4">Holder</th>
                  <th className="py-2 pr-4">Role</th>
                  <th className="py-2 pr-4 text-right">Gross share</th>
                  <th className="py-2 pr-4 text-right">Rate</th>
                  <th className="py-2 pr-4 text-right">Withheld</th>
                  <th className="py-2 pr-4 text-right">Net</th>
                  <th className="py-2 pr-4">Form</th>
                  <th className="py-2">Rail</th>
                </tr>
              </thead>
              <tbody className="font-mono text-white/70">
                {row.disbursements.map((d) => (
                  <tr key={d.rightsHolderId} className="border-t border-white/5">
                    <td className="py-2 pr-4 text-white/90">{d.rightsHolderName}</td>
                    <td className="py-2 pr-4">{d.role}</td>
                    <td className="py-2 pr-4 text-right">{fmt(d.grossShare, row.currency)}</td>
                    <td className="py-2 pr-4 text-right">{(d.withholdingTaxRateApplied * 100).toFixed(2)}%</td>
                    <td className="py-2 pr-4 text-right">{fmt(d.withholdingTaxDeducted, row.currency)}</td>
                    <td className="py-2 pr-4 text-right text-gold">{fmt(d.netShare, row.currency)}</td>
                    <td className="py-2 pr-4">{d.taxFormRequired}</td>
                    <td className="py-2">
                      {d.routing?.railType ?? '—'} · {d.routing?.countryCode ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

const CURRENCY_CHOICES = ['USD', 'EUR', 'GBP', 'SAT', 'ETH'] as const;

function SettleForm({ assets }: { assets: { cbtCode: string; title: string }[] }) {
  const [cbtCode, setCbtCode] = useState(assets[0]?.cbtCode ?? '');
  const [grossAmount, setGrossAmount] = useState('');
  const [currency, setCurrency] = useState<string>('USD');
  const [territory, setTerritory] = useState('US');
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const amount = useMemo(() => Number(grossAmount), [grossAmount]);
  const ready = Boolean(cbtCode) && amount > 0 && !pending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setReceipt(null);
    startTransition(async () => {
      const outcome = await settleDirectAction({
        cbtCode,
        grossAmount: amount,
        currency,
        territoryCountryCode: territory,
        sourcePlatform: 'DIRECT',
      });
      if (outcome.success) {
        setReceipt(
          `${outcome.result.transactionId} settled: ` +
            outcome.result.disbursements
              .map((d) => `${d.rightsHolderName} net ${fmt(d.netShare, outcome.result.currency)}`)
              .join(', ') +
            (outcome.result.cornerDustCollected > 0
              ? ` · corner dust ${fmt(outcome.result.cornerDustCollected, outcome.result.currency)}`
              : '')
        );
        setGrossAmount('');
      } else {
        setError(outcome.error);
      }
    });
  };

  return (
    <form onSubmit={submit} className="glass-card p-6">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">Record direct settlement</p>
      <p className="mt-2 text-sm text-white/50">
        Settles through the engine on the direct path (0% platform fee). Social claims with the 10%
        fee arrive via the claims webhook.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <label className="sm:col-span-2 block text-xs text-white/50">
          Asset
          <select
            value={cbtCode}
            onChange={(e) => setCbtCode(e.target.value)}
            className="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-gold"
          >
            {assets.length === 0 && <option value="">No assets registered</option>}
            {assets.map((a) => (
              <option key={a.cbtCode} value={a.cbtCode}>
                {a.title} — {a.cbtCode}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-white/50">
          Gross amount
          <input
            type="number"
            step="any"
            min="0"
            value={grossAmount}
            onChange={(e) => setGrossAmount(e.target.value)}
            placeholder="100"
            className="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none focus:border-gold"
          />
        </label>
        <label className="block text-xs text-white/50">
          Currency
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-gold"
          >
            {CURRENCY_CHOICES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-white/50">
          Territory
          <input
            value={territory}
            onChange={(e) => setTerritory(e.target.value.toUpperCase())}
            maxLength={2}
            className="mt-1 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 font-mono text-sm text-white outline-none focus:border-gold"
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={!ready}
        className="mt-4 rounded-full bg-gold px-5 py-2 text-sm font-medium text-obsidian-900 transition enabled:hover:bg-gold-champagne disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? 'Settling…' : 'Settle'}
      </button>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {receipt && (
        <p className="mt-3 font-mono text-xs text-emerald-300" role="status">
          {receipt}
        </p>
      )}
    </form>
  );
}
