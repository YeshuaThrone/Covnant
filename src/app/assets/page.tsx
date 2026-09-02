import Link from 'next/link';
import type { CovenantBlockAsset } from '@/engine/covenant-master-sdk';
import type { PoolTaggedHolder } from '@/lib/splits/multi-pool';
import { cvtDisplayCode } from '@/lib/splits/codes';
import { MEDIUM_LABELS } from '@/lib/splits/shared';
import { listAssets } from '@/lib/sdk';
import { IdentifierBadge } from '@/components/brand/IdentifierBadge';

export const dynamic = 'force-dynamic';

function poolCount(asset: CovenantBlockAsset): number {
  return new Set(asset.rightsHolders.map((h) => (h as PoolTaggedHolder).pool)).size;
}

export default async function AssetsPage() {
  const assets = await listAssets();

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-[#00C8FF]">
            Covenant Block Vault
          </p>
          <h1 className="mt-2 text-3xl font-semibold text-[#F2F4F8]">Assets</h1>
          <p className="mt-2 text-sm text-white/50">
            Every registered Covenant Block asset with its multi-pool split sheet.
          </p>
        </div>
        <Link
          href="/assets/new"
          className="rounded-lg border border-[#FFD700]/60 bg-[#D4AF37]/10 px-4 py-2 text-sm font-medium text-[#FFD700] hover:bg-[#D4AF37]/20"
        >
          + Register asset
        </Link>
      </div>

      <div className="gold-rule my-8" />

      {assets.length === 0 ? (
        <div className="glass-card p-10 text-center">
          <p className="text-lg text-white/70">No assets registered yet.</p>
          <p className="mt-2 text-sm text-white/40">
            Register your first Covenant Block asset to open its multi-pool split sheet.
          </p>
          <Link
            href="/assets/new"
            className="mt-6 inline-block rounded-lg border border-[#00C8FF]/40 px-4 py-2 text-sm text-[#00C8FF] hover:bg-[#00C8FF]/10"
          >
            Open the Asset Studio
          </Link>
        </div>
      ) : (
        <ul className="space-y-4">
          {assets.map((asset) => (
            <li key={asset.cbtCode}>
              <Link
                href={`/assets/${asset.cbtCode}`}
                className="glass-card block p-5 hover:border-[#00C8FF]/40"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-lg font-medium text-[#F2F4F8]">{asset.title}</p>
                    <p className="mt-1 text-sm text-white/50">
                      {MEDIUM_LABELS[asset.medium]} · {poolCount(asset)} pools ·{' '}
                      {asset.rightsHolders.length} holders
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs text-white/40">{asset.cbtCode}</span>
                    <IdentifierBadge label="CVT" value={cvtDisplayCode(asset.cbtCode)} />
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
