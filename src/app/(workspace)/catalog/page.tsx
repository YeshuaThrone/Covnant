/**
 * /catalog — the Covenant Block catalog (directive §5).
 *
 * A grid of every registered asset, each card carrying the universal registry
 * pills (CBT, ISRC, ISWC, EIDR) rendered from existing asset data via the
 * shared IdentifierBadge primitive. Cards link into the asset detail view;
 * the Asset Studio at /assets is untouched — this is a read-only surface over
 * listAssets().
 */

import Link from 'next/link';
import type { UniversalAssetIdentifier } from '@/engine/covenant-master-sdk';
import { listAssets } from '@/lib/sdk';
import { MEDIUM_LABELS } from '@/lib/splits/shared';
import { IdentifierBadge } from '@/components/brand/IdentifierBadge';

export const dynamic = 'force-dynamic';

/** Pill set every catalog card shows — value or an explicit em-dash. */
function registryPills(cbtCode: string, identifiers: UniversalAssetIdentifier) {
  const entries: Array<[string, string | undefined]> = [
    ['CBT', cbtCode],
    ['ISRC', identifiers.isrc],
    ['ISWC', identifiers.iswc],
    ['EIDR', identifiers.eidrCanonical],
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([label, value]) => (
        <IdentifierBadge key={label} label={label} value={value ?? '—'} />
      ))}
    </div>
  );
}

export default async function CatalogPage() {
  const assets = await listAssets();

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">Catalog</p>
      <h1 className="mt-2 text-3xl font-semibold text-white md:text-4xl">
        Covenant Block Catalog
      </h1>
      <p className="mt-3 max-w-2xl text-sm text-white/60">
        Every registered Covenant Block asset with its universal registry
        identifiers. Open a card for pools, rights holders, and the asset of
        record used by the contract vault.
      </p>
      <div className="gold-rule my-8" />

      {assets.length === 0 ? (
        <div className="glass-card p-8 text-center" data-testid="catalog-empty">
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
        <ul className="grid gap-4 sm:grid-cols-2" data-testid="catalog-grid">
          {assets.map((asset) => (
            <li key={asset.cbtCode}>
              <Link
                href={`/assets/${asset.cbtCode}`}
                className="glass-card block p-5 transition hover:border-gold/50"
                data-testid="catalog-card"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-lg font-semibold text-white">{asset.title}</h2>
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
    </main>
  );
}
