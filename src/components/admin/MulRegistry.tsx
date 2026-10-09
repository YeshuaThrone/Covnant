'use client';

/**
 * MulRegistry — the MUL Registry's operator surface: the summary band, the
 * full clearance table, the per-asset history drawer, and the audited
 * state-transition actions.
 *
 * THE MACHINE IS THE LAW: this component invents no clearance rules. The
 * legal edges come from the SDK's CLEARANCE_TRANSITIONS (offering an edge
 * the machine does not name is impossible by construction); every action
 * POSTs to the existing audited route, and REFUSALS ARE SURFACED — a 409
 * or 422 from the machine renders as an error, never a silent no-op. The
 * expired indicator applies the machine's own rule (an expired term is NOT
 * cleared) for display only; the dispatch gate stays the SDK's
 * assertCollectible.
 *
 * Honesty law: an unavailable read renders its message; empty states say
 * so; a corrupt state string renders as itself (never as a fabricated
 * badge) and offers no edges.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useDialogA11y } from '@/components/shell/useDialogA11y';
import type { MulClearanceRecord } from '@/modules/sdk/records';
import {
  CLEARANCE_STATES,
  CLEARANCE_TRANSITIONS,
  type ClearanceState,
} from '../../../covnant-sdk/src/mul/clearance';

/** The machine's vocabulary, derived — the SDK's own list is the law. */
const CLEARANCE_STATE_SET: ReadonlySet<string> = new Set(CLEARANCE_STATES);

function isKnownState(value: string): value is ClearanceState {
  return CLEARANCE_STATE_SET.has(value);
}

/** The page's read result — ready rows, or the honest failure message. */
export type MulRegistryData =
  | { kind: 'ready'; clearances: MulClearanceRecord[] }
  | { kind: 'unavailable'; message: string };

/** Wire shapes of the drawer's GET read (the SDK domain types over JSON). */
interface ClearanceView {
  assetCbtCode: string;
  state: string;
  licensee: string | null;
  territory: string | null;
  termStart: string | null;
  termEnd: string | null;
}

interface TransitionView {
  id: string;
  assetCbtCode: string;
  fromState: string | null;
  toState: string;
  note: string | null;
  createdAt: string;
}

const PAGE_SIZE = 25;

/** The repo's status-chip vocabulary, per machine state. */
const STATE_BADGE_CLASSES: Record<ClearanceState, string> = {
  draft: 'border-white/25 text-white/70',
  requested: 'border-amber-400/40 text-amber-300',
  cleared: 'border-emerald-400/40 text-emerald-300',
  disputed: 'border-red-400/40 text-red-300',
  revoked: 'border-white/15 text-white/40',
};

/**
 * The machine's own rule, for display: an expired term is NOT cleared.
 * Mirrors assertCollectible's expiry comparison exactly — through the term's
 * end instant, not a day after.
 */
export function clearanceTermExpired(termEnd: string | null, nowIso: string): boolean {
  if (termEnd === null) return false;
  const end = Date.parse(termEnd);
  if (Number.isNaN(end)) return false;
  return new Date(nowIso).getTime() > end;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function StateBadge({ state }: { state: string }) {
  const known = isKnownState(state) ? state : null;
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] ${
        known === null ? 'border-white/15 text-white/40' : STATE_BADGE_CLASSES[known]
      }`}
      data-mul="state-badge"
      data-mul-state={state}
    >
      {state}
    </span>
  );
}

function MetricCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">
        {label}
      </p>
      <p className="mt-2 font-mono text-2xl text-white" data-testid={`mul-count-${label}`}>
        {value.toLocaleString('en-US')}
      </p>
    </div>
  );
}

/** A stable empty registry — the unavailable branch never has rows, and a
 * fresh [] per render would defeat the summary useMemo's dependency check. */
const NO_CLEARANCES: MulClearanceRecord[] = [];

/**
 * The mutated asset's row, re-stamped from the machine's own answers: the
 * fresh clearance state and the newest transition's timestamp (the last
 * entry of the oldest-first replay), then re-sorted newest-update-first —
 * the same order a fresh store read returns. Pure; tested through the table.
 */
function patchRegistryRow(
  rows: MulClearanceRecord[],
  asset: string,
  state: ClearanceState,
  updatedAt: string,
): MulClearanceRecord[] {
  return rows
    .map((row) =>
      row.asset_cbt_code === asset ? { ...row, state, updated_at: updatedAt } : row,
    )
    .sort((a, b) => (a.updated_at > b.updated_at ? -1 : a.updated_at < b.updated_at ? 1 : 0));
}

export function MulRegistry({ data, nowIso }: { data: MulRegistryData; nowIso: string }) {
  const [rows, setRows] = useState<MulClearanceRecord[]>(
    data.kind === 'ready' ? data.clearances : NO_CLEARANCES,
  );
  const [stateFilter, setStateFilter] = useState<ClearanceState | 'all'>('all');
  const [pageIndex, setPageIndex] = useState(0);
  const [drawerAsset, setDrawerAsset] = useState<string | null>(null);
  const [history, setHistory] = useState<TransitionView[] | null>(null);
  const [drawerClearance, setDrawerClearance] = useState<ClearanceView | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [pendingTarget, setPendingTarget] = useState<ClearanceState | null>(null);

  const drawerOpen = drawerAsset !== null;
  const drawerRef = useDialogA11y(drawerOpen, () => setDrawerAsset(null));

  const counts = useMemo(() => {
    const tally: Record<ClearanceState, number> = {
      draft: 0,
      requested: 0,
      cleared: 0,
      disputed: 0,
      revoked: 0,
    };
    for (const row of rows) {
      if (isKnownState(row.state)) tally[row.state] += 1;
    }
    return tally;
  }, [rows]);

  const filtered = stateFilter === 'all' ? rows : rows.filter((row) => row.state === stateFilter);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const pageRows = filtered.slice(safePageIndex * PAGE_SIZE, (safePageIndex + 1) * PAGE_SIZE);

  /**
   * The drawer's read — the existing single-asset GET, refetched after
   * actions. Resolves the machine's fresh answers so the caller can patch
   * the table from them, or null when the read failed.
   */
  const loadHistory = useCallback(
    async (asset: string): Promise<{ clearance: ClearanceView; transitions: TransitionView[] } | null> => {
      setDrawerLoading(true);
      setDrawerError(null);
      setActionError(null);
      setHistory(null);
      setDrawerClearance(null);
      try {
        const response = await fetch(
          `/api/admin/mul/clearances?asset_cbt_code=${encodeURIComponent(asset)}`,
          { cache: 'no-store' },
        );
        const body: unknown = await response.json().catch(() => null);
        const envelope = body as { ok?: boolean; found?: boolean; error?: string; reason?: string; clearance?: ClearanceView; transitions?: TransitionView[] } | null;
        if (!response.ok || !envelope?.ok) {
          setDrawerError(
            envelope?.error ??
              `The registry read failed (${response.status}).`,
          );
          return null;
        }
        if (!envelope.found) {
          setDrawerError('No clearance exists for this asset.');
          return null;
        }
        const clearance = envelope.clearance ?? null;
        const transitions = envelope.transitions ?? [];
        setDrawerClearance(clearance);
        setHistory(transitions);
        if (clearance === null) return null;
        return { clearance, transitions };
      } catch {
        setDrawerError('The registry read failed — try again.');
        return null;
      } finally {
        setDrawerLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (drawerAsset !== null) void loadHistory(drawerAsset);
  }, [drawerAsset, loadHistory]);

  const openDrawer = (asset: string) => {
    setNote('');
    setDrawerAsset(asset);
  };

  /** The audited transition — refusals surface, never hide. */
  const runTransition = async (asset: string, to: ClearanceState) => {
    setPendingTarget(to);
    setActionError(null);
    try {
      const response = await fetch('/api/admin/mul/clearances', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          assetCbtCode: asset,
          to,
          note: note.trim() === '' ? undefined : note.trim(),
        }),
        cache: 'no-store',
      });
      const body: unknown = await response.json().catch(() => null);
      const envelope = body as { ok?: boolean; error?: string } | null;
      if (!response.ok || !envelope?.ok) {
        setActionError(
          envelope?.error ?? `The transition failed (${response.status}).`,
        );
        return;
      }
      setNote('');
      const fresh = await loadHistory(asset);
      if (
        fresh !== null &&
        fresh.transitions.length > 0 &&
        isKnownState(fresh.clearance.state)
      ) {
        // The table updates from the machine's own answers — the refetched
        // clearance's state and the newest transition's timestamp — instead
        // of an RSC refresh, whose payload can race the router and never
        // apply. Same discipline as the drawer above: fetch, then set state.
        const newest = fresh.transitions[fresh.transitions.length - 1];
        // A local const: property narrowing doesn't survive into the state
        // updater's closure, but a narrowed primitive does.
        const nextState = fresh.clearance.state;
        setRows((prev) => patchRegistryRow(prev, asset, nextState, newest.createdAt));
      }
    } catch {
      setActionError('The transition request failed — try again.');
    } finally {
      setPendingTarget(null);
    }
  };

  if (data.kind === 'unavailable') {
    return (
      <section className="mx-auto w-full max-w-6xl px-6 py-10" data-testid="mul-unavailable">
        <h1 className="font-mono text-2xl text-white">MUL Registry</h1>
        <p className="mt-4 font-mono text-sm text-white/60">{data.message}</p>
      </section>
    );
  }

  const legalTargets =
    drawerClearance !== null && isKnownState(drawerClearance.state)
      ? CLEARANCE_TRANSITIONS[drawerClearance.state]
      : [];

  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-10" data-testid="mul-registry">
      <h1 className="font-mono text-2xl text-white">MUL Registry</h1>
      <p className="mt-2 max-w-3xl font-mono text-sm text-white/60">
        Every Master Universal License clearance — its term, its history, and the audited
        transitions that move it. The machine stays the law: only legal edges are offered,
        and every action is audit-logged.
      </p>

      {/* Summary band — the pipeline's health at a glance. */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="mul-summary">
        {CLEARANCE_STATES.map((state) => (
          <MetricCell key={state} label={state} value={counts[state]} />
        ))}
      </div>

      {/* State filter. */}
      <div className="mt-6 flex flex-wrap items-center gap-2" data-testid="mul-filters">
        {(['all', ...CLEARANCE_STATES] as const).map((option) => {
          const active = stateFilter === option;
          const label = option === 'all' ? 'All' : option;
          const tally = option === 'all' ? rows.length : counts[option];
          return (
            <button
              key={option}
              type="button"
              onClick={() => {
                setStateFilter(option);
                setPageIndex(0);
              }}
              className={`rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.15em] focus-visible:outline-solid focus-visible:outline-gold-champagne ${
                active ? 'border-gold-champagne/70 bg-gold-champagne/10 text-gold-champagne' : 'border-slate-600/50 text-white/60 hover:text-white'
              }`}
              data-mul={`filter-${option}`}
              aria-pressed={active}
            >
              {label} ({tally.toLocaleString('en-US')})
            </button>
          );
        })}
      </div>

      {/* Registry table. */}
      {filtered.length === 0 ? (
        rows.length === 0 ? (
          <p className="mt-6 font-mono text-sm text-white/50" data-testid="mul-table-empty">
            The registry is empty — no asset has entered the Master Universal License machine
            yet. Clearances appear here the moment a draft is opened through the SDK or the
            collection flow.
          </p>
        ) : (
          <p className="mt-6 font-mono text-sm text-white/50" data-testid="mul-table-empty">
            No clearances in state {stateFilter}.
          </p>
        )
      ) : (
        <div className="mt-6 overflow-x-auto" data-testid="mul-table">
          <table className="w-full border-collapse text-left font-mono text-xs text-white/80">
            <thead>
              <tr className="text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">
                <th className="border-b border-slate-600/50 py-2 pr-4">Asset</th>
                <th className="border-b border-slate-600/50 py-2 pr-4">State</th>
                <th className="border-b border-slate-600/50 py-2 pr-4">Licensee</th>
                <th className="border-b border-slate-600/50 py-2 pr-4">Territory</th>
                <th className="border-b border-slate-600/50 py-2 pr-4">Term</th>
                <th className="border-b border-slate-600/50 py-2 pr-4">Last transition</th>
                <th className="border-b border-slate-600/50 py-2">History</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => {
                const expired = clearanceTermExpired(row.term_end, nowIso);
                return (
                  <tr key={row.asset_cbt_code} data-mul="row" data-mul-state={row.state}>
                    <td className="border-b border-slate-700/40 py-2 pr-4">
                      <Link
                        href={`/assets/${row.asset_cbt_code}`}
                        className="text-gold-champagne underline-offset-4 hover:underline focus-visible:outline-solid focus-visible:outline-gold-champagne"
                      >
                        {row.asset_cbt_code}
                      </Link>
                    </td>
                    <td className="border-b border-slate-700/40 py-2 pr-4">
                      <StateBadge state={row.state} />
                    </td>
                    <td className="border-b border-slate-700/40 py-2 pr-4 text-white/60">
                      {row.licensee ?? '—'}
                    </td>
                    <td className="border-b border-slate-700/40 py-2 pr-4 text-white/60">
                      {row.territory ?? '—'}
                    </td>
                    <td className="border-b border-slate-700/40 py-2 pr-4 text-white/60">
                      {row.term_start === null && row.term_end === null ? (
                        '—'
                      ) : (
                        <>
                          {row.term_start === null ? '—' : formatDate(row.term_start)}
                          {' → '}
                          {row.term_end === null ? '—' : formatDate(row.term_end)}
                          {expired && (
                            <span
                              className="ml-2 rounded-full border border-red-400/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-red-300"
                              data-mul="expired"
                              title="An expired term is NOT cleared — the dispatch gate refuses it."
                            >
                              expired
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="border-b border-slate-700/40 py-2 pr-4 text-white/60">
                      {formatDate(row.updated_at)}
                    </td>
                    <td className="border-b border-slate-700/40 py-2">
                      <button
                        type="button"
                        onClick={() => openDrawer(row.asset_cbt_code)}
                        className="rounded-full border border-slate-600/50 px-3 py-1 text-[11px] uppercase tracking-[0.15em] text-white/70 hover:text-white focus-visible:outline-solid focus-visible:outline-gold-champagne"
                        data-mul="history-button"
                        data-mul-asset={row.asset_cbt_code}
                      >
                        History
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination. */}
      {filtered.length > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-end gap-4 font-mono text-xs text-white/60" data-testid="mul-pagination">
          <button
            type="button"
            onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
            disabled={safePageIndex === 0}
            className="rounded-full border border-slate-600/50 px-3 py-1 uppercase tracking-[0.15em] hover:text-white disabled:opacity-40 focus-visible:outline-solid focus-visible:outline-gold-champagne"
          >
            Previous
          </button>
          <span>
            Page {safePageIndex + 1} of {pageCount.toLocaleString('en-US')}
          </span>
          <button
            type="button"
            onClick={() => setPageIndex((index) => Math.min(pageCount - 1, index + 1))}
            disabled={safePageIndex >= pageCount - 1}
            className="rounded-full border border-slate-600/50 px-3 py-1 uppercase tracking-[0.15em] hover:text-white disabled:opacity-40 focus-visible:outline-solid focus-visible:outline-gold-champagne"
          >
            Next
          </button>
        </div>
      )}

      {/* History drawer — the machine's audit trail, oldest first. */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/70" data-testid="mul-drawer-scrim">
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={`Clearance history for ${drawerAsset}`}
            tabIndex={-1}
            className="h-full w-full max-w-md overflow-y-auto border-l border-slate-600/50 bg-obsidian-900 p-6 focus-visible:outline-solid"
            data-testid="mul-drawer"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">
                  Clearance history
                </p>
                <p className="mt-1 font-mono text-sm text-white">{drawerAsset}</p>
              </div>
              <button
                type="button"
                onClick={() => setDrawerAsset(null)}
                className="rounded-full border border-slate-600/50 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.15em] text-white/70 hover:text-white focus-visible:outline-solid focus-visible:outline-gold-champagne"
                data-mul="drawer-close"
              >
                Close
              </button>
            </div>

            {drawerLoading && (
              <p className="mt-6 font-mono text-sm text-white/50" data-mul="drawer-loading">
                Reading the audit trail…
              </p>
            )}
            {drawerError !== null && (
              <p
                className="mt-6 rounded-xl border border-red-400/40 p-3 font-mono text-xs text-red-300"
                data-mul="drawer-error"
              >
                {drawerError}
              </p>
            )}

            {drawerClearance !== null && (
              <>
                <div className="mt-6 flex items-center gap-3">
                  <StateBadge state={drawerClearance.state} />
                  {clearanceTermExpired(drawerClearance.termEnd, nowIso) && (
                    <span className="rounded-full border border-red-400/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-red-300">
                      expired
                    </span>
                  )}
                </div>
                <dl className="mt-4 space-y-1 font-mono text-xs text-white/60">
                  <div>
                    <dt className="inline text-white/40">Licensee: </dt>
                    <dd className="inline text-white/70">{drawerClearance.licensee ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="inline text-white/40">Territory: </dt>
                    <dd className="inline text-white/70">{drawerClearance.territory ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="inline text-white/40">Term: </dt>
                    <dd className="inline text-white/70">
                      {drawerClearance.termStart === null ? '—' : formatDate(drawerClearance.termStart)}
                      {' → '}
                      {drawerClearance.termEnd === null ? '—' : formatDate(drawerClearance.termEnd)}
                    </dd>
                  </div>
                </dl>
              </>
            )}

            {/* Actions — ONLY the machine's legal edges. */}
            {drawerClearance !== null && legalTargets.length > 0 && (
              <div className="mt-6 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-4" data-testid="mul-actions">
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">
                  Audited transition
                </p>
                <label htmlFor="mul-action-note" className="mt-3 block font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">
                  Note (optional, audit-logged)
                </label>
                <input
                  id="mul-action-note"
                  type="text"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-600/50 bg-black/40 px-3 py-2 font-mono text-xs text-white placeholder:text-white/30 focus-visible:outline-solid focus-visible:outline-gold-champagne"
                  placeholder="Why the machine is being moved"
                  data-mul="action-note"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  {legalTargets.map((target) => (
                    <button
                      key={target}
                      type="button"
                      onClick={() => drawerAsset !== null && void runTransition(drawerAsset, target)}
                      disabled={pendingTarget !== null}
                      className="rounded-full border border-gold-champagne/50 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.15em] text-gold-champagne hover:bg-gold-champagne/10 disabled:opacity-40 focus-visible:outline-solid focus-visible:outline-gold-champagne"
                      data-mul={`action-${target}`}
                    >
                      {pendingTarget === target ? 'Moving…' : `Move to ${target}`}
                    </button>
                  ))}
                </div>
                {actionError !== null && (
                  <p
                    className="mt-3 rounded-xl border border-red-400/40 p-3 font-mono text-xs text-red-300"
                    data-mul="action-error"
                  >
                    {actionError}
                  </p>
                )}
              </div>
            )}

            {/* The append-only replay, oldest first. */}
            {history !== null && (
              <ol className="mt-6 space-y-3" data-testid="mul-history" data-mul-count={history.length}>
                {history.length === 0 && (
                  <li className="font-mono text-xs text-white/50" data-mul="history-empty">
                    No transitions recorded yet.
                  </li>
                )}
                {history.map((entry, index) => (
                  <li
                    key={entry.id}
                    className="rounded-xl border border-slate-700/40 p-3 font-mono text-xs"
                    data-mul="history-entry"
                    data-mul-index={index}
                  >
                    <p className="text-white/70">
                      <span className="text-white/40">{entry.fromState ?? '∅'}</span>
                      {' → '}
                      <span className="text-white">{entry.toState}</span>
                    </p>
                    <p className="mt-1 text-[10px] uppercase tracking-[0.15em] text-white/40">
                      {formatDate(entry.createdAt)}
                    </p>
                    {entry.note !== null && entry.note !== '' && (
                      <p className="mt-1 text-white/60">“{entry.note}”</p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
