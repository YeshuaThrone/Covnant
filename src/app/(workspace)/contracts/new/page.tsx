import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTemplate } from '@/lib/contracts/templates';
import { generateAgreement, hydrateContext } from '@/lib/contracts/generator';
import { getSdk, listAssets } from '@/lib/sdk';
import { listLedger } from '@/lib/ledger/store';
import { payoutFlowsFor } from '@/lib/contracts/payouts';
import { reconciliationSnapshotForAsset } from '@/lib/splits/reconciliation-server';
import { ContractEditor } from '@/components/vault/ContractEditor';

export const dynamic = 'force-dynamic';

export default async function NewContractPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string; cbt?: string }>;
}) {
  const { template: templateId, cbt } = await searchParams;
  const template = templateId ? getTemplate(templateId) : undefined;
  if (!template) redirect('/contracts');

  if (!cbt) {
    const assets = await listAssets();
    return (
      <div className="mx-auto w-full max-w-4xl px-6 py-12">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href="/contracts" className="text-sm text-white/50 transition hover:text-white">
            ← Contract Vault
          </Link>
          <Link href="/templates" className="text-sm text-white/50 transition hover:text-white">
            Template library →
          </Link>
        </div>
        <h1 className="mt-4 text-2xl font-semibold text-white">{template.name}</h1>
        <p className="mt-2 text-sm text-white/50">
          Choose the registered asset of record. The agreement hydrates from its stored pools,
          parties, and identifiers.
        </p>
        {assets.length === 0 ? (
          <p className="mt-8 rounded-xl border border-white/10 bg-white/5 p-6 text-sm text-white/60">
            No assets registered yet.{' '}
            <Link href="/assets" className="text-gold hover:underline">
              Register an asset in the Asset Studio
            </Link>{' '}
            first.
          </p>
        ) : (
          <ul className="mt-6 space-y-3">
            {assets.map((asset) => (
              <li key={asset.cbtCode}>
                <Link
                  href={`/contracts/new?template=${template.id}&cbt=${encodeURIComponent(asset.cbtCode)}`}
                  className="glass-card flex items-center justify-between p-4 transition hover:border-gold/40"
                >
                  <span className="text-sm text-white">{asset.title}</span>
                  <span className="font-mono text-xs text-white/40">{asset.cbtCode}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  let asset;
  try {
    asset = await getSdk().getOrHydrateAsset(cbt);
  } catch {
    asset = undefined;
  }
  if (!asset) notFound();

  const context = hydrateContext(asset);
  const agreement = generateAgreement(template, context);
  // Payout views read the existing ledger READ API — display shaping only.
  const payouts = payoutFlowsFor(asset.cbtCode, context, await listLedger());
  const snapshot = reconciliationSnapshotForAsset(asset);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-12">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/contracts" className="text-sm text-white/50 transition hover:text-white">
          ← Contract Vault
        </Link>
        <Link href="/templates" className="text-sm text-white/50 transition hover:text-white">
          Template library →
        </Link>
      </div>
      <div className="mt-4">
        <ContractEditor
          templateId={template.id}
          industry={template.industry}
          cbtCode={asset.cbtCode}
          assetTitle={asset.title}
          initialContext={agreement.fields}
          payouts={payouts}
          poolUnits={snapshot.poolUnits}
          reconciliationBlocker={snapshot.blocker}
        />
      </div>
    </div>
  );
}
