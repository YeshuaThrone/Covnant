import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { CovenantBlockAsset } from '@/engine/covenant-master-sdk';
import { getTemplate } from '@/lib/contracts/templates';
import { getContract } from '@/lib/contracts/store';
import { listLedger } from '@/lib/ledger/store';
import { payoutFlowsFor } from '@/lib/contracts/payouts';
import { getSdk } from '@/lib/sdk';
import { reconciliationSnapshotForAsset } from '@/lib/splits/reconciliation-server';
import { ContractEditor } from '@/components/vault/ContractEditor';

export const dynamic = 'force-dynamic';

export default async function ContractDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const contract = await getContract(id);
  if (!contract) notFound();
  const template = getTemplate(contract.templateId);
  if (!template) notFound();

  // Payout views read the existing ledger READ API — display shaping only.
  const payouts = payoutFlowsFor(contract.cbtCode, contract.fields, await listLedger());

  // The asset of record feeds the verification strip and the pre-posting
  // reconciliation lock; an unreadable asset fails closed to a locked editor.
  let asset: CovenantBlockAsset | undefined;
  try {
    asset = await getSdk().getOrHydrateAsset(contract.cbtCode);
  } catch {
    asset = undefined;
  }
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
          templateId={contract.templateId}
          industry={contract.industry}
          cbtCode={contract.cbtCode}
          assetTitle={contract.fields.asset.title}
          initialContext={contract.fields}
          contractId={contract.id}
          initialStatus={contract.status}
          payouts={payouts}
          poolUnits={snapshot.poolUnits}
          reconciliationBlocker={snapshot.blocker}
        />
      </div>
    </div>
  );
}
