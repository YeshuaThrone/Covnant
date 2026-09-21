'use client';

/**
 * Settlement rows — the READ-ONLY settlement display shared by the /ledger
 * page and the gated /admin Ledger section (founder directive, 2026-09-20:
 * the finances view reads the same engine output, and the console renders
 * it without the /ledger page's write path). The per-row status comes from
 * the reconciliation engine (PASS / DRIFT) — never a hardcoded badge.
 *
 * The drill-down renders the full disbursement detail the engine settled:
 * holder, role, gross share, rate, withheld, net, form, and the payout rail.
 */

import { useState } from 'react';
import type { LedgerRow } from '@/lib/ledger/store';
import { formatLedgerAmount } from '@/lib/ledger/micro-adapter';
import { formatFractionAsPercent } from '@/lib/fixed-point';
import type { RegistryPill } from '@/lib/assets/registry-keys';

/** Ledger rows ride with their asset's registry pills (Black Box Shield). */
type LedgerRowWithRegistry = LedgerRow & { registry: RegistryPill[] };

function StatusCell({ status }: { status: string | undefined }) {
  if (status === undefined) {
    return <span className="font-mono text-[10px] uppercase text-white/30">—</span>;
  }
  const pass = status === 'PASS';
  return (
    <span
      className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase ${
        pass
          ? 'border-emerald-400/40 text-emerald-300'
          : 'border-amber-300/40 text-amber-300'
      }`}
    >
      {status}
    </span>
  );
}

export function SettlementRowsTable({
  rows,
  statusByTransactionId,
}: {
  rows: LedgerRowWithRegistry[];
  statusByTransactionId?: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="glass-card overflow-x-auto" data-testid="settlement-rows">
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
                No settlements recorded yet. Settle a registered asset on the ledger page, or point a
                platform claims webhook at <code className="font-mono text-gold">/api/webhooks/claims</code>.
              </td>
            </tr>
          )}
          {rows.map((row) => {
            const open = expanded === row.transactionId;
            return (
              <TableRow
                key={row.transactionId}
                row={row}
                status={statusByTransactionId?.[row.transactionId]}
                open={open}
                onToggle={() => setExpanded(open ? null : row.transactionId)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TableRow({
  row,
  status,
  open,
  onToggle,
}: {
  row: LedgerRowWithRegistry;
  status: string | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-b border-white/5 transition hover:bg-white/5"
        onClick={onToggle}
        aria-expanded={open}
      >
        <td className="px-4 py-3 font-mono text-xs text-white/80">{row.transactionId}</td>
        <td className="px-4 py-3">
          <span className="block font-mono text-xs text-gold">{row.cbtCode}</span>
          <span className="mt-1 flex flex-wrap gap-1">
            {/* Registry identifiers ride on the ledger-bound payload — shown next to the amounts. */}
            {row.registry
              .filter((pill) => pill.key !== 'cbt')
              .map((pill) => (
                <span
                  key={pill.key}
                  title={`${pill.label}: ${pill.value}`}
                  className="rounded-full border border-gold/30 px-2 py-0.5 font-mono text-[10px] text-gold-champagne"
                >
                  {pill.label} · {pill.value}
                </span>
              ))}
          </span>
        </td>
        <td className="px-4 py-3 text-white/60">{row.platform}</td>
        <td className="px-4 py-3 text-right font-mono text-xs">
          {formatLedgerAmount(row.grossSettled, row.currency)} {row.currency}
        </td>
        <td className="px-4 py-3 text-right font-mono text-xs text-white/60">
          {formatLedgerAmount(row.covenantFee, row.currency)}
        </td>
        <td className="px-4 py-3 text-right font-mono text-xs text-[#FFD700]/80" data-testid="corner-dust-cell">
          {formatLedgerAmount(row.cornerDustCollected, row.currency)}
        </td>
        <td className="px-4 py-3">
          <StatusCell status={status} />
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
                    <td className="py-2 pr-4 text-right">{formatLedgerAmount(d.grossShare, row.currency)}</td>
                    <td className="py-2 pr-4 text-right">{formatFractionAsPercent(d.withholdingTaxRateApplied)}%</td>
                    <td className="py-2 pr-4 text-right">{formatLedgerAmount(d.withholdingTaxDeducted, row.currency)}</td>
                    <td className="py-2 pr-4 text-right text-gold">{formatLedgerAmount(d.netShare, row.currency)}</td>
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
