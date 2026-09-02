import { notFound } from 'next/navigation';
import type { CovenantBlockAsset } from '@/engine/covenant-master-sdk';
import { poolsFromSheet } from '@/lib/splits/multi-pool';
import type { HolderDraft, PoolDraft } from '@/lib/splits/shared';
import { getSdk } from '@/lib/sdk';
import { SplitSheetEditor } from '@/components/studio/SplitSheetEditor';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ cbt: string }>;
}

function toDrafts(asset: CovenantBlockAsset): PoolDraft[] {
  return poolsFromSheet(asset).map((pool) => ({
    pool: pool.pool,
    holders: pool.holders.map(
      (h): HolderDraft => ({
        id: h.id,
        name: h.name,
        role: h.role,
        splitPercentage: h.splitPercentage,
        taxFormType: h.taxProfile.taxFormType,
        usTaxResident: h.taxProfile.usTaxResident,
        isVerified: h.taxProfile.isVerified,
        routing: { ...h.payoutRouting },
      }),
    ),
  }));
}

export default async function AssetSplitsPage({ params }: PageProps) {
  const { cbt } = await params;
  let asset: CovenantBlockAsset | undefined;
  try {
    asset = await getSdk().getOrHydrateAsset(cbt);
  } catch {
    asset = undefined;
  }
  if (!asset) notFound();

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-[#00C8FF]">
        Asset Studio · {asset.cbtCode}
      </p>
      <h1 className="mt-2 text-3xl font-semibold text-[#F2F4F8]">{asset.title}</h1>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        Adjust each pool independently. The save gate re-validates every pool server-side before
        anything is written.
      </p>
      <div className="gold-rule my-8" />
      <SplitSheetEditor cbtCode={asset.cbtCode} initialPools={toDrafts(asset)} />
    </main>
  );
}
