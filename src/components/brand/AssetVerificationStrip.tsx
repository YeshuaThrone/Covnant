'use client';

/**
 * Verification strip — derives the three smart-ledger badges client-side from
 * the read-only ledger API (GET /api/ledger) plus the asset's per-pool unit
 * sums (computed server-side from the stored sheet):
 *
 * - Pre-Reconciled — every pool sums to exactly 100.0000%.
 * - Audited — ledger entries exist for this asset's CBT code.
 * - Immutable Ledger Active — reconciled AND bound to live ledger entries.
 *
 * Badges are text-labeled; unverified states render muted, never hidden.
 */

import { useCallback, useEffect, useState } from 'react';
import { VerificationBadge } from '@/components/brand/VerificationBadge';
import { deriveAssetVerification, type AssetVerification } from '@/lib/ledger/verification';

interface LedgerApiResponse {
  ok: boolean;
  settlements?: { cbtCode: string }[];
}

type StripState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; verification: AssetVerification };

export function AssetVerificationStrip({
  cbtCode,
  poolUnits,
}: {
  cbtCode: string;
  /** Exact per-pool unit sums from the stored sheet (1 unit = 0.0001%). */
  poolUnits: number[];
}) {
  const [state, setState] = useState<StripState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    fetch('/api/ledger', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`ledger read failed (HTTP ${res.status})`);
        const data = (await res.json()) as LedgerApiResponse;
        if (!data.ok) throw new Error('ledger read returned an error payload');
        return data.settlements ?? [];
      })
      .then((settlements) => {
        if (!cancelled) {
          setState({
            kind: 'ready',
            verification: deriveAssetVerification(cbtCode, poolUnits, settlements),
          });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : 'ledger read failed',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cbtCode, poolUnits, attempt]);

  return (
    <div aria-busy={state.kind === 'loading'} aria-live="polite">
      <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">
        Smart ledger verification
      </p>
      {state.kind === 'loading' && (
        <div className="mt-2 flex flex-wrap gap-2">
          {['Pre-Reconciled', 'Audited', 'Immutable Ledger Active'].map((label) => (
            <span
              key={label}
              className="inline-flex h-6 w-40 animate-pulse items-center rounded-full border border-white/10 bg-white/5"
            >
              <span className="sr-only">Verifying {label}…</span>
            </span>
          ))}
        </div>
      )}
      {state.kind === 'error' && (
        <p className="mt-2 flex flex-wrap items-center gap-3 text-xs text-red-300">
          Verification unavailable — {state.message}.{' '}
          <button
            type="button"
            onClick={reload}
            className="rounded border border-red-400/40 px-2 py-0.5 text-red-200 hover:bg-red-400/10"
          >
            Retry
          </button>
        </p>
      )}
      {state.kind === 'ready' && (
        <div className="mt-2 flex flex-wrap gap-2">
          <VerificationBadge variant="pre-reconciled" inactive={!state.verification.preReconciled} />
          <VerificationBadge variant="audited" inactive={!state.verification.audited} />
          <VerificationBadge
            variant="immutable-ledger-active"
            inactive={!state.verification.immutableActive}
          />
        </div>
      )}
    </div>
  );
}
