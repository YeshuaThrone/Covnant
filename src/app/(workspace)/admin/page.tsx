/**
 * /admin — Revenue & Royalty operations console.
 *
 * Strict-execution directive deliverable: a read-only, ledger-scoped admin
 * surface over the same verified store functions that power /ledger — no
 * dummy data, no stubs. Data access is server-side only under the v1 RLS
 * contract (deny-all-to-anon policies; service-role reads from the server,
 * credential never exposed). Authentication ships in v2; until then this
 * route is deliberately read-only and exposes nothing the public /ledger
 * page does not already render.
 */

import { listAssets } from '@/lib/sdk';
import { listLedger, totalsFrom, holderStatsFrom } from '@/lib/ledger/store';
import { AuditRunner } from '@/components/vault/AuditRunner';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const rows = await listLedger();
  const assets = await listAssets();
  const totals = totalsFrom(rows);
  const holders = holderStatsFrom(rows);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">
        Revenue &amp; Royalty Operations
      </p>
      <h1 className="mt-2 text-3xl font-semibold text-white">Admin Console</h1>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        Read-only operations view over the Universal Royalty Ledger: settlement
        totals, per-holder year-to-date compliance, and the embedded audit
        runner. Server-side reads enforce the v1 RLS contract — the anon role
        is denied at the database, service-role reads stay on the server, and
        the credential is never exposed. Authentication arrives with v2.
      </p>

      <section aria-label="Ledger totals" className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
          <p className="font-mono text-xs uppercase tracking-wider text-white/40">Settlements</p>
          <p className="mt-1 text-2xl font-semibold text-white">{totals.count}</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
          <p className="font-mono text-xs uppercase tracking-wider text-white/40">Gross settled</p>
          <p className="mt-1 text-2xl font-semibold text-white">{totals.gross.toFixed(2)}</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
          <p className="font-mono text-xs uppercase tracking-wider text-white/40">Platform fees</p>
          <p className="mt-1 text-2xl font-semibold text-white">{totals.fees.toFixed(2)}</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
          <p className="font-mono text-xs uppercase tracking-wider text-white/40">Corner dust</p>
          <p className="mt-1 text-2xl font-semibold text-white">{totals.cornerDust.toFixed(2)}</p>
        </div>
      </section>

      <section aria-label="Holder year-to-date compliance" className="mt-10">
        <h2 className="text-xl font-semibold text-white">Holder YTD &amp; tax forms</h2>
        {holders.size === 0 ? (
          <p className="mt-4 text-sm text-white/50">
            No settlements recorded yet — holder statistics appear after the
            first settlement posts to the ledger.
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
                {[...holders.values()].map((h) => (
                  <tr key={h.id}>
                    <td className="px-4 py-3 text-white">{h.name}</td>
                    <td className="px-4 py-3 text-white/60">{h.role}</td>
                    <td className="px-4 py-3 text-white/60">{h.settlementCount}</td>
                    <td className="px-4 py-3 text-white/60">{h.latestTaxForm}</td>
                    <td className="px-4 py-3 text-white/60">
                      {Object.entries(h.grossYtd)
                        .map(([currency, value]) => `${value.toFixed(2)} ${currency}`)
                        .join(', ') || '—'}
                    </td>
                    <td className="px-4 py-3 text-white/60">
                      {Object.entries(h.withheldYtd)
                        .map(([currency, value]) => `${value.toFixed(2)} ${currency}`)
                        .join(', ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 font-mono text-xs text-white/30">
          {assets.length} registered asset{assets.length === 1 ? '' : 's'} ·
          YTD amounts are per-currency (the ledger stores no FX).
        </p>
      </section>

      <section aria-label="Verification" className="mt-10">
        <h2 className="text-xl font-semibold text-white">System audit</h2>
        <p className="mt-2 text-sm text-white/50">
          Runs the vendored engine&apos;s auditor over every asset and ledger
          row — split sums, tax-profile verification, and over-disbursement
          checks.
        </p>
        <div className="mt-4">
          <AuditRunner />
        </div>
      </section>
    </main>
  );
}
