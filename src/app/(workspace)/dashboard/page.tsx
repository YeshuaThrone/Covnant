/**
 * /dashboard — the workspace overview (directive §5).
 *
 * Metric sources — read-only consumption of the existing data layer, the
 * exact reads GET /api/ledger maps 1:1 onto for its totals block
 * (listLedger → totalsFrom; see src/app/api/ledger/route.ts):
 *   - registered assets:  listAssets()          (src/lib/sdk.ts)
 *   - contracts by state: listContracts()       (src/lib/contracts/store.ts)
 *   - ledger totals:      listLedger/totalsFrom (src/lib/ledger/store.ts)
 *
 * Currency amounts are displayed through the integer-safe reconciliation
 * module (BigInt minor units, per-currency) — no float rollups.
 */

import Link from 'next/link';
import { listAssets } from '@/lib/sdk';
import { listContracts, type ContractStatus } from '@/lib/contracts/store';
import { listLedger, totalsFrom } from '@/lib/ledger/store';
import { formatMinor, totalsByCurrency } from '@/lib/ledger/reconciliation';

export const dynamic = 'force-dynamic';

function MetricCard({
  label,
  value,
  detail,
  href,
}: {
  label: string;
  value: string;
  detail: React.ReactNode;
  href: string;
}): React.ReactNode {
  return (
    <Link
      href={href}
      className="glass-card block p-5 transition hover:border-gold/50"
      data-metric={label}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-white">{value}</p>
      <p className="mt-1 text-xs text-white/50">{detail}</p>
    </Link>
  );
}

function QuickAction({
  href,
  label,
  hint,
}: {
  href: string;
  label: string;
  hint: string;
}): React.ReactNode {
  return (
    <Link
      href={href}
      className="glass-card flex flex-col gap-1 px-5 py-4 transition hover:border-gold/50"
    >
      <span className="text-sm font-medium text-gold-champagne">{label}</span>
      <span className="text-xs text-white/50">{hint}</span>
    </Link>
  );
}

export default async function DashboardPage() {
  const [assets, contracts, ledgerRows] = await Promise.all([
    listAssets(),
    listContracts(),
    listLedger(),
  ]);

  const ledgerTotals = totalsFrom(ledgerRows); // the totals GET /api/ledger serves
  const byStatus = contracts.reduce<Record<ContractStatus, number>>(
    (acc, c) => ({ ...acc, [c.status]: acc[c.status] + 1 }),
    { DRAFT: 0, FINAL: 0 },
  );
  const byCurrency = totalsByCurrency(ledgerRows);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">Workspace</p>
      <h1 className="mt-2 text-3xl font-semibold text-white md:text-4xl">Dashboard</h1>
      <p className="mt-3 max-w-2xl text-sm text-white/60">
        The state of your rights workspace: what is registered, what is agreed, and
        what has settled on the Universal Royalty Ledger.
      </p>
      <div className="gold-rule my-8" />

      <section aria-label="Workspace metrics" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Registered assets"
          value={String(assets.length)}
          detail={
            assets.length === 0
              ? 'Nothing registered yet — start with one asset.'
              : 'CBT assets in the registry'
          }
          href="/assets"
        />
        <MetricCard
          label="Contracts"
          value={String(contracts.length)}
          detail={
            contracts.length === 0
              ? 'No drafts or finals yet.'
              : `${byStatus.DRAFT} draft${byStatus.DRAFT === 1 ? '' : 's'} · ${byStatus.FINAL} final${byStatus.FINAL === 1 ? '' : 's'}`
          }
          href="/contracts"
        />
        <MetricCard
          label="Settlements"
          value={String(ledgerTotals.count)}
          detail={
            ledgerTotals.count === 0
              ? 'No settlements on the ledger yet.'
              : 'Settled on the royalty ledger'
          }
          href="/ledger"
        />
        <div className="glass-card p-5" data-metric="Gross settled">
          <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">
            Gross settled
          </p>
          {byCurrency.length === 0 ? (
            <p className="mt-2 text-sm text-white/50">—</p>
          ) : (
            <ul className="mt-2 space-y-0.5">
              {byCurrency.map((t) => (
                <li key={t.currency} className="font-mono text-sm text-gold">
                  {formatMinor(t.grossMinor, t.currency)} {t.currency}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-xs text-white/50">Exact per-currency — no float rollup.</p>
        </div>
      </section>

      <section aria-label="Quick actions" className="mt-10">
        <h2 className="font-mono text-xs uppercase tracking-[0.3em] text-white/40">
          Quick actions
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <QuickAction href="/assets" label="Register Asset" hint="Add an asset to the registry" />
          <QuickAction
            href="/contracts"
            label="New Contract"
            hint="Generate an agreement from the vault"
          />
          <QuickAction
            href="/templates"
            label="Browse Templates"
            hint="The deterministic template library"
          />
        </div>
      </section>
    </main>
  );
}
