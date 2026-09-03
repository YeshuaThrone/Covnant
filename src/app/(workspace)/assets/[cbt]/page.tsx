import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { CovenantBlockAsset, SelfServeRightsHolder } from '@/engine/covenant-master-sdk';
import { cvtDisplayCode } from '@/lib/splits/codes';
import { poolsFromSheet } from '@/lib/splits/multi-pool';
import {
  describePoolGap,
  formatUnitsAsPercent,
  MEDIUM_LABELS,
  POOL_LABELS,
  poolStateForUnits,
  sumPoolUnits,
} from '@/lib/splits/shared';
import { getSdk } from '@/lib/sdk';
import { IdentifierBadge } from '@/components/brand/IdentifierBadge';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ cbt: string }>;
}

function poolChip(holders: SelfServeRightsHolder[]) {
  const units = sumPoolUnits(holders.map((h) => h.splitPercentage));
  const state = poolStateForUnits(units);
  const tone =
    state === 'EXACT'
      ? 'border-emerald-400/40 text-emerald-300'
      : state === 'UNDER'
        ? 'border-amber-400/40 text-amber-300'
        : 'border-red-400/40 text-red-300';
  const gap = describePoolGap(units);
  return (
    <span className={`rounded-full border px-3 py-1 font-mono text-xs ${tone}`}>
      {formatUnitsAsPercent(units)}%{gap ? ` · ${gap}` : ''}
    </span>
  );
}

function holderRole(holder: SelfServeRightsHolder): string {
  return holder.role;
}

export default async function AssetDetailPage({ params }: PageProps) {
  const { cbt } = await params;
  let asset: CovenantBlockAsset | undefined;
  try {
    asset = await getSdk().getOrHydrateAsset(cbt);
  } catch {
    asset = undefined;
  }
  if (!asset) notFound();

  const pools = poolsFromSheet(asset);
  const identifierEntries = Object.entries(asset.mappedIdentifiers).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
  );

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">
        Covenant Block
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold text-[#F2F4F8]">{asset.title}</h1>
        <Link
          href={`/assets/${asset.cbtCode}/splits`}
          className="rounded-lg border border-gold/40 px-4 py-2 text-sm text-gold hover:bg-gold/10"
        >
          Edit split sheet
        </Link>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <IdentifierBadge label="CBT" value={asset.cbtCode} />
        <IdentifierBadge label="CVT" value={cvtDisplayCode(asset.cbtCode)} />
        {identifierEntries.map(([key, value]) => (
          <IdentifierBadge key={key} label={key.toUpperCase()} value={value} />
        ))}
      </div>

      <div className="gold-rule my-8" />

      <p className="text-sm text-white/50">
        {MEDIUM_LABELS[asset.medium]} · Registered{' '}
        {new Date(asset.createdTimestamp).toLocaleDateString('en-US', { dateStyle: 'long' })}
      </p>

      <div className="mt-6 space-y-6">
        {pools.map((pool) => (
          <section key={pool.pool} className="glass-card p-6">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-mono text-sm uppercase tracking-widest text-gold">
                {POOL_LABELS[pool.pool]}
              </h2>
              {poolChip(pool.holders)}
            </div>
            <ul className="mt-4 divide-y divide-white/10">
              {pool.holders.map((holder) => (
                <li key={holder.id} className="flex items-center justify-between gap-4 py-3">
                  <div>
                    <p className="text-sm text-[#F2F4F8]">{holder.name}</p>
                    <p className="text-xs text-white/40">
                      {holderRole(holder)} · {holder.taxProfile.taxFormType} ·{' '}
                      {holder.taxProfile.usTaxResident ? 'US' : 'Non-US'}
                      {holder.taxProfile.isVerified ? ' · Verified' : ' · Unverified'}
                    </p>
                  </div>
                  <span className="font-mono text-sm text-[#FFD700]">
                    {formatUnitsAsPercent(holder.splitPercentage)}%
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
