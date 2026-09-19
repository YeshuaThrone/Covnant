/**
 * /sync-license — the Sync Library surface (Creator UI Layout Contract §3 +
 * syncLicenseUiSpec F-refinement).
 *
 * The library crosses the real SDK enumeration (listAssets — the engine's
 * registered CBT asset sheets) with the store's sync catalog
 * (listSyncCatalogItems). A work renders PRE-CLEARED with its real fee
 * floor, genre, and tempo only when a cleared catalog row exists; a
 * registered-but-unlisted work renders the honest PENDING PRE-CLEARANCE
 * state. Registration is the client form wired to the session-bound POST
 * /api/sync-license/register — the server mints the listing and only a
 * gated administrator flips pre-clearance. No dev warning banner (removed
 * by the F-refinement); the demo door carries the DEMO DATA marker in the
 * page header.
 */

import type { Metadata } from 'next';

import { HeaderActions } from '@/components/workspace/HeaderActions';
import { SyncLicenseForm } from '@/components/sync/SyncLicenseForm';
import {
  loadCreatorPageContext,
  storeForContext,
} from '@/lib/server/creatorPages';
import { listAssets } from '@/lib/sdk';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sync License — Covnant',
  description:
    'Your Sync Library — pre-cleared works with real fee floors, and registration for sync licensing.',
};

/** Renders integer cents as a plain dollar string (never a float path). */
function formatCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100);
  const rem = abs % 100;
  const body = `${dollars.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')}`;
  return negative ? `−$${body}` : `$${body}`;
}

interface LibraryEntry {
  cbtCode: string;
  title: string;
  preCleared: boolean;
  floorCents: number | null;
  genre: string | null;
  bpm: number | null;
}

export default async function SyncLicensePage() {
  const context = await loadCreatorPageContext();

  if (context === null) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6 md:py-10">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold-champagne">Sync License</p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-100 md:text-4xl">
          Sign in to view your Sync Library
        </h1>
        <p className="mt-3 text-sm text-slate-400">
          Your sync catalog lives behind your sign-in.
        </p>
      </main>
    );
  }

  const { demo } = context;
  const store = await storeForContext(context);
  const [assets, catalog] = await Promise.all([
    listAssets(),
    store.listSyncCatalogItems(),
  ]);

  const catalogByTag = new Map(catalog.map((row) => [row.cbt_code, row]));
  const library: LibraryEntry[] = assets.map((asset) => {
    const row = catalogByTag.get(asset.cbtCode);
    return {
      cbtCode: asset.cbtCode,
      title: asset.title,
      preCleared: row?.is_pre_cleared === true,
      floorCents: row?.is_pre_cleared === true ? row.sync_fee_cents : null,
      genre: row?.is_pre_cleared === true ? row.genre : null,
      bpm: row?.is_pre_cleared === true ? row.bpm : null,
    };
  });
  const registrable = library
    .filter((entry) => !entry.preCleared)
    .map(({ cbtCode, title }) => ({ cbtCode, title }));

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6 md:py-10">
      <div
        data-testid="sync-license-header"
        className="flex items-center justify-between gap-2.5"
      >
        <span className="font-mono text-xs tracking-[0.35em] text-gold-champagne">
          SYNC LICENSE
        </span>
        <HeaderActions demo={demo} />
      </div>

      <h1
        data-testid="sync-license-title"
        className="mt-6 text-4xl font-bold tracking-tight text-slate-100 md:text-5xl"
      >
        <span className="bg-gradient-to-r from-gold-champagne via-emerald-200 to-gold bg-clip-text text-transparent">
          Sync Library
        </span>
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-400">
        The works positioned for film, television, and advertising licensing.
        Pre-clearance is an administrator action — submitted works stay pending
        until cleared.
      </p>

      <div className="gold-rule my-6 md:my-8" />

      <div className="grid gap-6 lg:grid-cols-[1fr_420px] lg:items-start">
        <section
          data-testid="sync-library"
          aria-label="Sync Library"
          className="space-y-4"
        >
          {library.length === 0 ? (
            <div className="glass-card p-6 text-center" data-testid="sync-library-empty">
              <h2 className="text-lg font-semibold text-slate-100">No registered works yet</h2>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-400">
                Works registered in the asset registry appear here with their
                clearance state.
              </p>
            </div>
          ) : (
            library.map((entry) => (
              <article
                key={entry.cbtCode}
                data-testid="sync-library-row"
                data-state={entry.preCleared ? 'pre-cleared' : 'pending'}
                className="glass-card p-5"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="font-display text-lg font-semibold text-slate-100">
                      {entry.title}
                    </h2>
                    <p className="mt-1 font-mono text-[11px] tracking-wide text-slate-500">
                      {entry.cbtCode}
                    </p>
                  </div>
                  {entry.preCleared ? (
                    <span
                      data-testid="sync-state-pre-cleared"
                      className="shrink-0 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-300"
                    >
                      Pre-cleared
                    </span>
                  ) : (
                    <span
                      data-testid="sync-state-pending"
                      className="shrink-0 rounded-full border border-amber-300/40 bg-amber-300/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-300"
                    >
                      Pending pre-clearance
                    </span>
                  )}
                </div>

                {entry.preCleared ? (
                  <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-slate-700/40 pt-4">
                    <p className="text-sm text-slate-300">
                      <span className="text-slate-500">Fee floor </span>
                      <span
                        data-testid="sync-fee-floor"
                        className="font-mono text-gold-champagne"
                      >
                        {entry.floorCents !== null ? `${formatCents(entry.floorCents)} minimum` : '—'}
                      </span>
                    </p>
                    {entry.genre !== null && entry.genre.length > 0 && (
                      <p className="text-sm text-slate-400">
                        <span className="text-slate-500">Genre </span>
                        <span className="font-mono text-slate-300">{entry.genre}</span>
                      </p>
                    )}
                    {entry.bpm !== null && (
                      <p className="text-sm text-slate-400">
                        <span className="text-slate-500">Tempo </span>
                        <span className="font-mono text-slate-300">{entry.bpm} BPM</span>
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="mt-4 border-t border-slate-700/40 pt-4 text-xs leading-relaxed text-slate-500">
                    Not yet submitted for sync licensing. Register it below — the
                    listing lands pending pre-clearance and administration clears it.
                  </p>
                )}
              </article>
            ))
          )}
        </section>

        <div className="lg:sticky lg:top-24">
          <SyncLicenseForm assets={registrable} />
          <p className="mt-4 text-xs leading-relaxed text-slate-500" data-testid="sync-splits-note">
            Every sync license settles on the locked Universal structure —
            50% ownership, 35% creative, 15% production — calculated by the
            settlement engine and never edited by a submission.
          </p>
          {demo && (
            <p className="mt-4 rounded-lg border border-amber-300/30 bg-amber-300/10 p-3 text-xs leading-relaxed text-amber-200">
              This is the demo persona&apos;s library — the seeded preview state.
              Submissions from the preview register against the seeded registry.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
