/**
 * /ledger — Universal Royalty Ledger audit view (directive §5).
 *
 * Upgrades the settlement view with an integer-safe reconciliation audit:
 * every row is checked against the engine's own settlement identities in
 * BigInt minor units (src/lib/ledger/reconciliation.ts — the parallel
 * ledger-precision module has not merged, so no float math anywhere here).
 * The settlement table and the embedded Smart Ledger audit runner render
 * below, unchanged.
 */

import { listAssets } from '@/lib/sdk';
import { listLedger, totalsFrom } from '@/lib/ledger/store';
import { withRegistryPills, type RegistryPill } from '@/lib/assets/registry-keys';
import { formatMinor, reconcileLedger } from '@/lib/ledger/reconciliation';
import { SettlementTable } from '@/components/ledger/SettlementTable';
import { AuditRunner } from '@/components/vault/AuditRunner';
import { VerificationBadge } from '@/components/brand/VerificationBadge';

export const dynamic = 'force-dynamic';

type LedgerRowWithRegistry = Awaited<ReturnType<typeof listLedger>>[number] & {
  registry: RegistryPill[];
};

/**
 * Black Box Shield — every ledger-bound row rides with its asset's registry
 * pills (canonical CBT/CVT audit keys plus sector keys), so payout views can
 * always display the identifiers next to the amounts.
 */
function attachRegistryPills(
  rows: Awaited<ReturnType<typeof listLedger>>,
  assets: Awaited<ReturnType<typeof listAssets>>,
): LedgerRowWithRegistry[] {
  const assetByCode = new Map(assets.map((a) => [a.cbtCode, a]));
  return rows.map((row) => withRegistryPills(row, assetByCode.get(row.cbtCode)));
}

export default async function LedgerPage() {
  const rows = await listLedger();
  const assets = await listAssets();
  const totals = totalsFrom(rows);
  const recon = reconcileLedger(rows);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">
        Universal Royalty Ledger
      </p>
      <h1 className="mt-2 text-3xl font-semibold text-white">Ledger &amp; Settlement</h1>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        Every settled transaction — direct or platform claim — reconciles through the engine&apos;s
        BigInt path before it lands here. Expand a row for the per-holder disbursement detail:
        gross share, withholding rate and deduction, net payout, tax form, and routing rail.
      </p>

      <section aria-label="Reconciliation audit" className="glass-card mt-8 p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-semibold text-white">Reconciliation</h2>
          {recon.totalRows === 0 ? (
            <VerificationBadge variant="pre-reconciled" label="No settlements to reconcile" />
          ) : recon.status === 'RECONCILED' ? (
            <VerificationBadge
              variant="audited"
              label={`Reconciled — exact · ${recon.passCount}/${recon.totalRows}`}
            />
          ) : (
            <VerificationBadge
              variant="pre-reconciled"
              label={`Attention — ${recon.driftCount} drifted · ${recon.passCount}/${recon.totalRows} exact`}
            />
          )}
        </div>
        <p className="mt-2 text-sm text-white/50">
          Each settlement is re-derived in integer minor units against the engine&apos;s
          identities: holder distributions sum to gross minus the stored fee (which carries
          the corner dust), net equals gross minus withholding per holder, and every
          disbursement carries the settlement currency. No floating-point arithmetic is
          used anywhere in this audit.
        </p>

        {recon.byCurrency.length > 0 && (
          <div className="mt-4 overflow-x-auto rounded-lg border border-white/10">
            <table className="status-table min-w-[640px]" data-testid="reconciliation-totals">
              <thead>
                <tr>
                  <th className="px-4 py-3">Currency</th>
                  <th className="px-4 py-3 text-right">Settlements</th>
                  <th className="px-4 py-3 text-right">Gross</th>
                  <th className="px-4 py-3 text-right">Fees (incl. dust)</th>
                  <th className="px-4 py-3 text-right">Corner dust</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {recon.byCurrency.map((t) => (
                  <tr key={t.currency}>
                    <td className="px-4 py-3 font-mono text-gold">{t.currency}</td>
                    <td className="px-4 py-3 text-right text-white/60">{t.settlements}</td>
                    <td className="px-4 py-3 text-right font-mono text-white">
                      {formatMinor(t.grossMinor, t.currency)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-white/60">
                      {formatMinor(t.feesMinor, t.currency)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-white/60">
                      {formatMinor(t.dustMinor, t.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {recon.driftCount > 0 && (
          <ul className="mt-4 space-y-2" data-testid="reconciliation-findings">
            {recon.rows
              .filter((r) => r.status === 'DRIFT')
              .map((r) => (
                <li
                  key={r.transactionId}
                  className="rounded-lg border border-red-400/40 bg-red-400/10 p-3 text-sm text-red-300"
                >
                  <span className="font-mono text-xs">{r.transactionId}</span>
                  <ul className="mt-1 list-inside list-disc">
                    {r.findings.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                </li>
              ))}
          </ul>
        )}
      </section>

      <section aria-label="Settlement history" className="mt-8">
        <SettlementTable
          rows={attachRegistryPills(rows, assets)}
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
