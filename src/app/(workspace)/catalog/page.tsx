import Link from 'next/link';
import type { UniversalAssetIdentifier } from '@/engine/covenant-master-sdk';
import { listAssets } from '@/lib/sdk';
import { MEDIUM_LABELS } from '@/lib/splits/shared';
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
  title: 'Covenant Block Catalog — Covnant',
  description:
    'The master catalog of Covenant Block agreements across the seven entertainment verticals.',
};

export const dynamic = 'force-dynamic';

/**
 * Pill set for a catalog card — rendered ONLY for identifiers of record.
 * An unmapped identifier renders nothing (no empty pill placeholder, no
 * dash): a pill that renders a dash would claim a code the registry never
 * mapped.
 */
function registryPills(cbtCode: string, identifiers: UniversalAssetIdentifier) {
  const entries: Array<[string, string | undefined]> = [
    ['CBT', cbtCode],
    ['ISRC', identifiers.isrc],
    ['ISWC', identifiers.iswc],
    ['EIDR', identifiers.eidrCanonical],
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {entries
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
        .map(([label, value]) => (
          <IdentifierBadge key={label} label={label} value={value} />
        ))}
    </div>
  );
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const { category } = await searchParams;
  const active = masterCategoryFromParam(category);

  // The master data seam — the seven-vertical sovereign ledger above the
  // registry grid; demo library in preview (under the HeaderActions badge),
  // real settled rows otherwise.
  const { demo, records } = await resolveMasterLedger();
  const scoped = active
    ? records.filter((record) => record.category === active)
    : records;
  const summary = summarizeSovereignLedger(scoped);

  const assets = await listAssets();

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <div className="flex items-center justify-between gap-2.5">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">Catalog</p>
        <HeaderActions demo={demo} />
      </div>
      <h1 className="mt-2 text-3xl font-semibold text-white md:text-4xl">
        Covenant Block Catalog
      </h1>
      <p className="mt-3 max-w-2xl text-sm text-white/60">
        Every registered Covenant Block asset with its universal registry
        identifiers. Open a card for pools, rights holders, and the asset of
        record used by the contract vault.
      </p>
      <div className="gold-rule my-8" />

      <section aria-label="Master ledger for this vertical" className="space-y-4">
        <MasterCategoryTabs active={active} basePath="/catalog" />
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
          <div className="glass-card mt-4 p-8 text-center" data-testid="catalog-empty">
            <p className="text-sm text-white/60">
              The catalog is empty — no assets are registered yet.
            </p>
            <Link
              href="/assets/new"
              className="mt-4 inline-block rounded-lg border border-gold/40 px-4 py-2 text-sm text-gold transition hover:bg-gold/10"
            >
              Register the first asset →
            </Link>
          </div>
        ) : (
          <ul className="mt-4 grid gap-4 sm:grid-cols-2" data-testid="catalog-grid">
            {assets.map((asset) => (
              <li key={asset.cbtCode}>
                <Link
                  href={`/assets/${asset.cbtCode}`}
                  className="glass-card block p-5 transition hover:border-gold/50"
                  data-testid="catalog-card"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-lg font-semibold text-white">{asset.title}</h3>
                    <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">
                      {MEDIUM_LABELS[asset.medium] ?? asset.medium}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-white/50">
                    {asset.rightsHolders.length} rights holder
                    {asset.rightsHolders.length === 1 ? '' : 's'} · registered{' '}
                    {new Date(asset.createdTimestamp).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </p>
                  <div className="mt-4">{registryPills(asset.cbtCode, asset.mappedIdentifiers)}</div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
