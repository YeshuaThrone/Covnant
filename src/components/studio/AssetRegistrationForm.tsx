'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { GoldNotificationBanner } from '@/components/brand/GoldNotificationBanner';
import { generateCBTAsset } from '@/lib/splits/generate-cbt-asset';
import {
  MEDIA_MEDIUMS,
  MEDIUM_LABELS,
  poolStateForUnits,
  sumPoolUnits,
  type PoolDraft,
} from '@/lib/splits/shared';
import { freshPools, PoolSplitEditor } from './PoolSplitEditor';

const FIELD =
  'w-full rounded-lg border border-white/10 bg-onyx-800 px-3 py-2 text-sm text-[#F2F4F8] placeholder:text-white/30 focus:border-gold focus:outline-none';
const LABEL = 'block text-xs uppercase tracking-wider text-white/40 mb-1';

export function AssetRegistrationForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [medium, setMedium] = useState('MUSIC_TRACK');
  const [pools, setPools] = useState<PoolDraft[]>(freshPools());
  const [error, setError] = useState<string | undefined>();
  const [duplicate, setDuplicate] = useState(false);
  const [mulOpen, setMulOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const allPoolsExact =
    title.trim().length > 0 &&
    pools.every(
      (p) =>
        poolStateForUnits(sumPoolUnits(p.holders.map((h) => h.splitPercentage))) === 'EXACT',
    );

  const openMulPrompt = () => {
    setError(undefined);
    setDuplicate(false);
    setMulOpen(true);
  };

  const acceptMulAndRegister = () => {
    startTransition(async () => {
      const result = await generateCBTAsset({ title, medium, pools });
      if (!result.ok) {
        // Keep the full UI state (form, splits, navigation) — duplicates render
        // the gold banner; anything else renders the standard error strip.
        setMulOpen(false);
        setDuplicate(result.duplicate);
        setError(result.duplicate ? undefined : result.error);
        return;
      }
      router.push(`/assets/${result.cbtCode}`);
    });
  };

  return (
    <div className="space-y-8">
      {duplicate && (
        <GoldNotificationBanner title="Asset already registered in CBT catalog">
          The identical medium and title are already on the ledger — that catalog entry is the
          asset of record. Adjust the title or medium to register a different work.
        </GoldNotificationBanner>
      )}

      <section className="glass-card p-6">
        <h2 className="font-mono text-sm uppercase tracking-widest text-gold">Identity</h2>
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
        <p className="mt-3 text-xs text-white/40">
          Zero-friction registration: universal tracking identifiers (ISRC, ISWC, EIDR) resolve
          automatically after you accept the MUL — no manual registry entry.
        </p>
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
          onClick={openMulPrompt}
          className="rounded-lg border border-[#FFD700]/60 bg-[#D4AF37]/10 px-6 py-3 text-sm font-medium text-[#FFD700] hover:bg-[#D4AF37]/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Register asset
        </button>
      </div>

      {mulOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Master Recording & Universal Asset License"
            className="glass-card w-full max-w-2xl p-8"
          >
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">
              One-click agreement
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-[#F2F4F8]">
              Master Recording &amp; Universal Asset License
            </h2>
            <p className="mt-4 text-sm text-white/60">
              Accepting the MUL registers <span className="text-white/90">{title}</span> (
              {MEDIUM_LABELS[medium as keyof typeof MEDIUM_LABELS] ?? medium}) under the universal
              license terms: split-locked ownership for every pool, universal tracking across
              platforms, settlement reconciled through the engine, and an immutable ledger record.
            </p>
            <p className="mt-3 text-sm text-white/60">
              Registry identifiers are provisioned automatically — ISRC (Recording) and ISWC
              (Composition) for Music &amp; Audio, EIDR for Film/TV/Video, plus CVT/CBT internal
              audit keys for ledger verification. No external registry code is ever fabricated.
            </p>
            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                disabled={pending}
                onClick={() => setMulOpen(false)}
                className="rounded-lg border border-white/15 px-5 py-3 text-sm text-white/60 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={acceptMulAndRegister}
                className="rounded-full bg-gold px-6 py-3 text-sm font-medium text-obsidian-900 transition enabled:hover:bg-gold-champagne disabled:cursor-not-allowed disabled:opacity-40"
              >
                {pending ? 'Registering…' : 'Accept MUL & Register Asset'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
