'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveAssetSplitsAction } from '@/lib/assets/actions';
import { poolStateForUnits, sumPoolUnits, type PoolDraft } from '@/lib/splits/shared';
import { PoolSplitEditor } from './PoolSplitEditor';

interface SplitSheetEditorProps {
  cbtCode: string;
  initialPools: PoolDraft[];
}

export function SplitSheetEditor({ cbtCode, initialPools }: SplitSheetEditorProps) {
  const router = useRouter();
  const [pools, setPools] = useState<PoolDraft[]>(initialPools);
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const allPoolsExact = pools.every(
    (p) => poolStateForUnits(sumPoolUnits(p.holders.map((h) => h.splitPercentage))) === 'EXACT',
  );

  const save = () => {
    setError(undefined);
    startTransition(async () => {
      const result = await saveAssetSplitsAction(cbtCode, pools);
      if (result.ok) {
        router.push(`/assets/${cbtCode}`);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <div className="space-y-8">
      <PoolSplitEditor pools={pools} onChange={setPools} />

      {error && (
        <p className="rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-white/40">
          Saving replaces the asset&apos;s split sheet. Each pool must read exactly 100.0000%;
          nothing is written while any pool is off.
        </p>
        <button
          type="button"
          disabled={!allPoolsExact || pending}
          onClick={save}
          className="rounded-lg border border-[#FFD700]/60 bg-[#D4AF37]/10 px-6 py-3 text-sm font-medium text-[#FFD700] hover:bg-[#D4AF37]/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? 'Saving…' : 'Save split sheet'}
        </button>
      </div>
    </div>
  );
}
