'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { registerAssetAction } from '@/app/assets/actions';
import {
  MEDIA_MEDIUMS,
  MEDIUM_LABELS,
  poolStateForUnits,
  sumPoolUnits,
  type PoolDraft,
} from '@/lib/splits/shared';
import { freshPools, PoolSplitEditor } from './PoolSplitEditor';

const FIELD =
  'w-full rounded-lg border border-white/10 bg-onyx-800 px-3 py-2 text-sm text-[#F2F4F8] placeholder:text-white/30 focus:border-[#00C8FF] focus:outline-none';
const LABEL = 'block text-xs uppercase tracking-wider text-white/40 mb-1';

export function AssetRegistrationForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [medium, setMedium] = useState('MUSIC_TRACK');
  const [identifiers, setIdentifiers] = useState({ isrc: '', iswc: '', eidrCanonical: '' });
  const [pools, setPools] = useState<PoolDraft[]>(freshPools());
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();

  const allPoolsExact =
    title.trim().length > 0 &&
    pools.every(
      (p) =>
        poolStateForUnits(sumPoolUnits(p.holders.map((h) => h.splitPercentage))) === 'EXACT',
    );

  const submit = () => {
    setError(undefined);
    startTransition(async () => {
      const result = await registerAssetAction({ title, medium, identifiers, pools });
      if (result.ok && result.cbtCode) {
        router.push(`/assets/${result.cbtCode}`);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <div className="space-y-8">
      <section className="glass-card p-6">
        <h2 className="font-mono text-sm uppercase tracking-widest text-[#00C8FF]">Identity</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={LABEL}>Asset title</label>
            <input
              className={FIELD}
              value={title}
              placeholder="Song, film, episode, book…"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <label className={LABEL}>Medium</label>
            <select className={FIELD} value={medium} onChange={(e) => setMedium(e.target.value)}>
              {MEDIA_MEDIUMS.map((m) => (
                <option key={m} value={m} className="bg-onyx-800">
                  {MEDIUM_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <label className={LABEL}>ISRC</label>
            <input
              className={FIELD}
              value={identifiers.isrc}
              placeholder="US-XXX-26-00001"
              onChange={(e) => setIdentifiers({ ...identifiers, isrc: e.target.value })}
            />
          </div>
          <div>
            <label className={LABEL}>ISWC</label>
            <input
              className={FIELD}
              value={identifiers.iswc}
              placeholder="T-000.000.000-0"
              onChange={(e) => setIdentifiers({ ...identifiers, iswc: e.target.value })}
            />
          </div>
          <div>
            <label className={LABEL}>EIDR</label>
            <input
              className={FIELD}
              value={identifiers.eidrCanonical}
              placeholder="10.5240/…"
              onChange={(e) => setIdentifiers({ ...identifiers, eidrCanonical: e.target.value })}
            />
          </div>
        </div>
      </section>

      <PoolSplitEditor pools={pools} onChange={setPools} />

      {error && (
        <p className="rounded-lg border border-red-400/40 bg-red-400/10 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-white/40">
          Each pool must read exactly 100.0000% before registration. The gate is re-validated
          server-side.
        </p>
        <button
          type="button"
          disabled={!allPoolsExact || pending}
          onClick={submit}
          className="rounded-lg border border-[#FFD700]/60 bg-[#D4AF37]/10 px-6 py-3 text-sm font-medium text-[#FFD700] hover:bg-[#D4AF37]/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? 'Registering…' : 'Register asset'}
        </button>
      </div>
    </div>
  );
}
