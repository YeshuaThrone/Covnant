import Link from 'next/link';
import type { CovenantBlockAsset } from '@/engine/covenant-master-sdk';
import { storedCvtHandle } from '@/lib/covnant/cvt';
import type { PoolTaggedHolder } from '@/lib/splits/multi-pool';
import { MEDIUM_LABELS } from '@/lib/splits/shared';
import { listAssets } from '@/lib/sdk';
import { IdentifierBadge } from '@/components/brand/IdentifierBadge';
import { HeaderActions } from '@/components/workspace/HeaderActions';
import { MASTER_TAB_PANEL_ID, masterCategoryFromParam, masterTabId } from '@/lib/master/taxonomy';
import { resolveMasterLedger } from '@/lib/master/masterStore';
import { summarizeSovereignLedger } from '@/lib/master/sovereignLedger';
import {
  MasterCategoryTabs,
  MasterStatCards,
  SovereignLedgerTable,
} from '@/components/master/MasterData';

export const metadata = {
  title: 'Your Asset Registry — Covnant',
  description:
    'Your registered assets across every vertical — identifiers, pools, and settlement state.',
};

export const dynamic = 'force-dynamic';

function poolCount(asset: CovenantBlockAsset): number {
  return new Set(asset.rightsHolders.map((h) => (h as PoolTaggedHolder).pool)).size;
}

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const { category } = await searchParams;
  const active = masterCategoryFromParam(category);

  // The master data seam — the seven-vertical sovereign ledger above the
  // Asset Studio index; demo library in preview (under the HeaderActions
  // badge), real settled rows otherwise.
  const { demo, records } = await resolveMasterLedger();
  const scoped = active
    ? records.filter((record) => record.category === active)
    : records;
  const summary = summarizeSovereignLedger(scoped);

  const assets = await listAssets();

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">
            Covenant Block Vault
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-pearl md:text-4xl">Assets</h1>
          <p className="mt-2 text-sm text-white/50">
            Every registered Covenant Block asset with its multi-pool split sheet.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <HeaderActions demo={demo} />
          <Link
            href="/agent"
            className="rounded-lg border border-white/10 px-4 py-2 text-sm text-white/70 hover:border-gold/40 hover:text-gold"
          >
            ✦ Agent
          </Link>
          <Link
            href="/assets/new"
            className="rounded-lg border border-[#FFD700]/60 bg-[#D4AF37]/10 px-4 py-2 text-sm font-medium text-[#FFD700] hover:bg-[#D4AF37]/20"
          >
            + Register asset
          </Link>
        </div>
      </div>

      <div className="gold-rule my-8" />

      <section aria-label="Master ledger for this vertical" className="space-y-4">
        <MasterCategoryTabs active={active} basePath="/assets" />
        <div
          role="tabpanel"
          id={MASTER_TAB_PANEL_ID}
          aria-labelledby={masterTabId(active)}
          tabIndex={0}
          className="space-y-4"
        >
          <MasterStatCards summary={summary} />
          <SovereignLedgerTable records={scoped} />
        </div>
      </section>

      <div className="gold-rule my-8" />

      <section aria-label="Registered assets">
        <h2 className="font-mono text-xs uppercase tracking-[0.3em] text-white/40">
          Registered assets — {assets.length}
        </h2>
        {assets.length === 0 ? (
          <div className="glass-card mt-4 p-10 text-center">
            <p className="text-lg text-white/70">No assets registered yet.</p>
            <p className="mt-2 text-sm text-white/40">
              Register your first Covenant Block asset to open its multi-pool split sheet.
            </p>
            <Link
              href="/assets/new"
              className="mt-6 inline-block rounded-lg border border-gold/40 px-4 py-2 text-sm text-gold hover:bg-gold/10"
            >
              Open the Asset Studio
            </Link>
          </div>
        ) : (
          <ul className="mt-4 space-y-4">
            {assets.map((asset) => {
              // The stored column is the ONLY outward CVT — no stored handle,
              // no badge (fail-closed; never derived from the CBT body).
              const cvt = storedCvtHandle(asset.cvtCode);
              return (
                <li key={asset.cbtCode}>
                  <Link
                    href={`/assets/${asset.cbtCode}`}
                    className="glass-card block p-5 hover:border-gold/40"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-lg font-medium text-pearl">{asset.title}</p>
                        <p className="mt-1 text-sm text-white/50">
                          {MEDIUM_LABELS[asset.medium]} · {poolCount(asset)} pools ·{' '}
                          {asset.rightsHolders.length} holders
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-xs text-white/40">{asset.cbtCode}</span>
                        {cvt !== null && <IdentifierBadge label="CVT" value={cvt} />}
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
