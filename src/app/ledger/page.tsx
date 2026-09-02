/**
 * /ledger — Universal Royalty Ledger — PR 4.
 *
 * Settlement table with disbursement drill-down, corner-dust totals, and the
 * embedded Smart Ledger audit runner rendering the engine's SystemAuditReport.
 */

import { listAssets } from '@/lib/sdk';
import { listLedger, totalsFrom } from '@/lib/ledger/store';
import { SettlementTable } from '@/components/ledger/SettlementTable';
import { AuditRunner } from '@/components/vault/AuditRunner';

export const dynamic = 'force-dynamic';

export default async function LedgerPage() {
  const rows = await listLedger();
  const assets = await listAssets();
  const totals = totalsFrom(rows);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-[#00C8FF]">
        Universal Royalty Ledger
      </p>
      <h1 className="mt-2 text-3xl font-semibold text-white">Ledger &amp; Settlement</h1>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        Every settled transaction — direct or platform claim — reconciles through the engine&apos;s
        BigInt path before it lands here. Expand a row for the per-holder disbursement detail:
        gross share, withholding rate and deduction, net payout, tax form, and routing rail.
      </p>

      <section aria-label="Settlement history" className="mt-8">
        <SettlementTable
          rows={rows}
          totals={totals}
          assets={assets.map((a) => ({ cbtCode: a.cbtCode, title: a.title }))}
        />
      </section>

      <section aria-label="Verification" className="mt-10">
        <AuditRunner />
      </section>
    </main>
  );
}
