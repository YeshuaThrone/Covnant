'use client';

/**
 * TemplatesControlBoard — the client half of the Covnant Control Board
 * (founder directive, 2026-09-20). The server page SSRs the default view
 * and hands the board its entity-bound state; activating a vertical tab
 * fetches the vertical's sectors from the per-sector entity doors
 * (GET /api/v1/entities/[sector]) and hydrates the grids from the response
 * — no client-side filtering of a static grouped array.
 *
 * Integrity of the swap:
 *   - tabs stay real anchors (progressive enhancement, deep links);
 *   - while syncing, the previous boards stay rendered (no empty states);
 *   - on failure, a sync notice offers a retry and the stale boards hold;
 *   - back/forward re-renders the URL's server view (the SSR contract).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  MASTER_CATEGORY_BLURBS,
  MASTER_CATEGORY_LABELS,
  MASTER_CATEGORY_ORDER,
  sectorsForVertical,
  type GlobalEntertainmentCategory,
} from '@/lib/master/taxonomy';
import {
  mergeSectorResponses,
  type ControlBoardState,
  type SectorEntitiesResponse,
  type VerticalBoardData,
} from '@/lib/master/controlBoard';
import { AtomicTemplateGrid, FactoryTemplateGrid } from '@/components/master/MasterTemplates';

/** The atomic registry blurb — shared by every vertical's atomic block. */
const ATOMIC_REGISTRY_BLURB =
  'The atomic entity registry — granular sector clearing records with their bound entity telemetry, execution states, and the same 50/35/15 allocation structure.';

/** The per-sector entity door of one sector. */
function entitiesRoute(sector: string): string {
  return `/api/v1/entities/${sector}`;
}

/** Narrow a URL category param onto the six-vertical canon; null otherwise. */
function categoryFromSearch(search: string): GlobalEntertainmentCategory | null {
  const raw = new URLSearchParams(search).get('category');
  if (raw === null) return null;
  return (MASTER_CATEGORY_ORDER as readonly string[]).includes(raw)
    ? (raw as GlobalEntertainmentCategory)
    : null;
}

/** One vertical section — both grids, the same shell as the server render. */
function VerticalSection({ section }: { section: VerticalBoardData }) {
  const label = MASTER_CATEGORY_LABELS[section.vertical];
  return (
    <section aria-label={label} data-testid="template-vertical-section">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-xl font-semibold text-white">{label}</h2>
        <span className="font-mono text-xs text-white/40">
          {section.factoryTemplates.length} template
          {section.factoryTemplates.length === 1 ? '' : 's'}
        </span>
      </div>
      <p className="mt-1 text-sm text-white/50">{MASTER_CATEGORY_BLURBS[section.vertical]}</p>
      <div className="gold-rule mt-4" />

      <FactoryTemplateGrid records={section.factoryTemplates} />

      <div className="mt-10" data-testid="atomic-registry-block">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="font-mono text-xs uppercase tracking-[0.25em] text-gold">Atomic Registry</h3>
          <span className="font-mono text-xs text-white/40">
            {section.atomicRecords.length} atomic record
            {section.atomicRecords.length === 1 ? '' : 's'}
          </span>
        </div>
        <p className="mt-1 text-sm text-white/50">{ATOMIC_REGISTRY_BLURB}</p>
        <div className="gold-rule mt-4" />

        <AtomicTemplateGrid records={section.atomicRecords} />
      </div>
    </section>
  );
}

export function TemplatesControlBoard({ initial }: { initial: ControlBoardState }) {
  const [view, setView] = useState<ControlBoardState>(initial);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<GlobalEntertainmentCategory | null>(null);

  /**
   * Activate a vertical — fetch every sector door of the vertical and
   * hydrate the board from the responses (the per-tab swap path).
   */
  const activate = useCallback(
    async (vertical: GlobalEntertainmentCategory): Promise<void> => {
      setSyncing(true);
      setSyncError(null);
      try {
        const responses = await Promise.all(
          sectorsForVertical(vertical).map(async (sector) => {
            const response = await fetch(entitiesRoute(sector), { cache: 'no-store' });
            if (!response.ok) {
              throw new Error(`entities route for ${sector} failed with ${response.status}`);
            }
            return (await response.json()) as SectorEntitiesResponse;
          }),
        );
        const hydrated = mergeSectorResponses(vertical, responses);
        window.history.pushState({}, '', `/templates?category=${vertical}`);
        setView({
          demo: responses[0]?.demo ?? false,
          active: vertical,
          verticals: [hydrated],
        });
      } catch {
        // Fail soft on the swap: hold the last cleared boards (never an
        // empty state) and surface the retry.
        setSyncError(vertical);
      } finally {
        setSyncing(false);
      }
    },
    [],
  );

  // Back/forward: re-render the URL's server view. Client-pushed entries
  // cannot restore deeper history state honestly, so the server re-renders.
  useEffect(() => {
    const onPopState = (): void => {
      if (categoryFromSearch(window.location.search) !== view.active) {
        window.location.reload();
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [view.active]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Master categories">
        <Link
          href="/templates"
          role="tab"
          aria-selected={view.active === null}
          className={`rounded-full border px-4 py-1.5 text-sm transition ${
            view.active === null
              ? 'border-gold/60 bg-gold/10 text-gold'
              : 'border-white/10 text-white/60 hover:border-white/25 hover:text-white'
          }`}
        >
          All verticals
        </Link>
        {MASTER_CATEGORY_ORDER.map((category) => (
          <Link
            key={category}
            href={`/templates?category=${category}`}
            role="tab"
            aria-selected={view.active === category}
            data-testid="vertical-tab"
            data-vertical={category}
            onClick={(event) => {
              if (view.active !== category) {
                event.preventDefault();
                void activate(category);
              }
            }}
            className={`rounded-full border px-4 py-1.5 text-sm transition ${
              view.active === category
                ? 'border-gold/60 bg-gold/10 text-gold'
                : 'border-white/10 text-white/60 hover:border-white/25 hover:text-white'
            }`}
          >
            {MASTER_CATEGORY_LABELS[category]}
          </Link>
        ))}
      </div>

      {syncing ? (
        <p
          data-testid="board-syncing"
          className="mt-4 font-mono text-xs uppercase tracking-[0.2em] text-gold-champagne"
          role="status"
        >
          Syncing telemetry matrix…
        </p>
      ) : null}
      {syncError !== null ? (
        <p data-testid="board-sync-error" className="mt-4 text-sm text-white/60" role="alert">
          Telemetry sync failed for {MASTER_CATEGORY_LABELS[syncError]} — the boards below hold
          their last cleared state.{' '}
          <button
            type="button"
            onClick={() => {
              void activate(syncError);
            }}
            className="text-gold hover:underline"
          >
            Retry
          </button>
        </p>
      ) : null}

      <div className="mt-6 space-y-12">
        {view.verticals.map((section) => (
          <VerticalSection key={section.vertical} section={section} />
        ))}
      </div>

      <p className="mt-12 text-sm text-white/50">
        Working drafts, finalization, and export live in{' '}
        <Link href="/contracts" className="text-gold hover:underline">
          the Contract Vault
        </Link>
        .
      </p>
    </div>
  );
}
