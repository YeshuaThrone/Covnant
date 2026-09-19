/**
 * SyncLicenseForm — the Sync License registration form (C-directive +
 * F-refinement). Wired to the session-bound POST /api/sync-license/register:
 * the server consumes the CBT tag, mints the listing PENDING PRE-CLEARANCE,
 * and hard-locks splits at 50/35/15 — the form accepts no split input at
 * all, mirroring the route's exact-key rejection.
 *
 * Dollar fee floor (F-directive): the fee is entered in whole dollars and
 * converted to integer cents for the wire — no cent fractions, minimum $1.
 * Server errors surface with their real codes; a successful submission
 * reports the honest PENDING state (only a gated administrator clears).
 */

'use client';

import { useState } from 'react';

export interface SyncLicenseFormAsset {
  cbtCode: string;
  title: string;
}

export interface SyncLicenseFormProps {
  /** The creator's SDK-registered assets that are not yet in the catalog. */
  assets: SyncLicenseFormAsset[];
  /** Set after a successful registration — the honest pending summary. */
  onSuccessNote?: string;
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; message: string; splits: { t1: number; t2: number; t3: number } }
  | { kind: 'error'; message: string };

/** Whole-dollar input → integer cents; null when the input is not valid. */
export function parseDollarFeeToCents(input: string): number | null {
  const trimmed = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+$/.test(trimmed)) return null;
  const dollars = Number(trimmed);
  if (!Number.isSafeInteger(dollars) || dollars < 1) return null;
  return dollars * 100;
}

function friendlyError(code: string, message: string): string {
  if (code.startsWith('unknown_key:')) return message;
  switch (code) {
    case 'rate_limited':
      return 'Too many submissions — wait a moment and try again.';
    case 'unauthorized':
      return 'Sign in to register a work for sync licensing.';
    case 'asset_not_found':
      return 'That asset tag could not be found in the registry.';
    case 'not_rights_holder':
      return 'Only a rights holder of the asset can register it for sync licensing.';
    case 'already_cleared':
      return 'That work is already in the catalog and cleared — administration owns the cleared state.';
    case 'invalid_sync_fee_cents':
      return 'The fee must be a positive whole-dollar amount.';
    default:
      return message.length > 0 ? message : 'The registration could not be completed.';
  }
}

export function SyncLicenseForm({ assets, onSuccessNote }: SyncLicenseFormProps) {
  const [assetTag, setAssetTag] = useState(assets[0]?.cbtCode ?? '');
  const [feeDollars, setFeeDollars] = useState('');
  const [genre, setGenre] = useState('');
  const [bpm, setBpm] = useState('');
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });

  const feeCents = parseDollarFeeToCents(feeDollars);
  const feeInvalid = feeDollars.trim().length > 0 && feeCents === null;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (assets.length === 0) return;

    if (feeCents === null) {
      setState({ kind: 'error', message: 'Enter the sync fee in whole dollars — minimum $1.' });
      return;
    }

    setState({ kind: 'submitting' });
    try {
      const response = await fetch('/api/sync-license/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cvtAssetTag: assetTag,
          syncFeeCents: feeCents,
          ...(genre.trim().length > 0 ? { genre: genre.trim() } : {}),
          ...(bpm.trim().length > 0 ? { bpm: Number(bpm) } : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string; message?: string; splits?: { tier1OwnershipBps: number; tier2CreativeBps: number; tier3ProductionBps: number } }
        | null;

      if (!response.ok) {
        const code = body?.error ?? `http_${response.status}`;
        const message = body?.message ?? '';
        setState({ kind: 'error', message: friendlyError(code, message) });
        return;
      }

      const splits = body?.splits ?? { tier1OwnershipBps: 5000, tier2CreativeBps: 3500, tier3ProductionBps: 1500 };
      setState({
        kind: 'success',
        message:
          onSuccessNote ??
          'Registered — the listing is pending pre-clearance. Administration reviews and clears sync listings; a submission cannot clear itself.',
        splits: {
          t1: splits.tier1OwnershipBps,
          t2: splits.tier2CreativeBps,
          t3: splits.tier3ProductionBps,
        },
      });
    } catch {
      setState({ kind: 'error', message: 'The registration request could not be sent — check your connection and try again.' });
    }
  }

  if (assets.length === 0) {
    return (
      <section data-testid="sync-form-empty" className="glass-card p-6" aria-label="Registration">
        <h2 className="font-display text-xl font-semibold text-slate-100">Register a work</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Every work in your library is already registered or pre-cleared. New works
          appear here once they are registered in the asset registry.
        </p>
      </section>
    );
  }

  return (
    <section data-testid="sync-license-form" className="glass-card p-6" aria-label="Registration">
      <h2 className="font-display text-xl font-semibold text-slate-100">Register a work</h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">
        Submit one of your registered works for sync licensing. Splits are
        hard-locked at 50/35/15 and are not editable here — the structure is set
        by the settlement engine.
      </p>

      <form onSubmit={handleSubmit} className="mt-5 space-y-4">
        <div>
          <label htmlFor="sync-asset" className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
            Work
          </label>
          <select
            id="sync-asset"
            data-testid="sync-asset-select"
            value={assetTag}
            onChange={(event) => setAssetTag(event.target.value)}
            className="mt-1.5 w-full rounded-lg border border-slate-600/60 bg-obsidian-900/60 px-3 py-2 text-sm text-slate-100 focus:border-gold/60 focus:outline-none"
          >
            {assets.map((asset) => (
              <option key={asset.cbtCode} value={asset.cbtCode}>
                {asset.title} — {asset.cbtCode}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="sync-fee" className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
              Sync fee (whole dollars)
            </label>
            <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-slate-600/60 bg-obsidian-900/60 px-3 focus-within:border-gold/60">
              <span className="font-mono text-sm text-slate-400">$</span>
              <input
                id="sync-fee"
                data-testid="sync-fee-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="4950"
                value={feeDollars}
                onChange={(event) => setFeeDollars(event.target.value)}
                className="w-full bg-transparent py-2 font-mono text-sm text-slate-100 focus:outline-none"
                aria-invalid={feeInvalid}
              />
            </div>
            {feeInvalid && (
              <p data-testid="sync-fee-error" className="mt-1 text-xs text-red-400">
                Enter a whole-dollar amount — minimum $1.
              </p>
            )}
          </div>
          <div>
            <label htmlFor="sync-genre" className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
              Genre <span className="text-slate-600">(optional)</span>
            </label>
            <input
              id="sync-genre"
              data-testid="sync-genre-input"
              type="text"
              maxLength={128}
              value={genre}
              onChange={(event) => setGenre(event.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-600/60 bg-obsidian-900/60 px-3 py-2 text-sm text-slate-100 focus:border-gold/60 focus:outline-none"
            />
          </div>
        </div>

        <div className="sm:w-1/2">
          <label htmlFor="sync-bpm" className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
            BPM <span className="text-slate-600">(optional)</span>
          </label>
          <input
            id="sync-bpm"
            data-testid="sync-bpm-input"
            type="text"
            inputMode="numeric"
            value={bpm}
            onChange={(event) => setBpm(event.target.value.replace(/[^\d]/g, ''))}
            className="mt-1.5 w-full rounded-lg border border-slate-600/60 bg-obsidian-900/60 px-3 py-2 font-mono text-sm text-slate-100 focus:border-gold/60 focus:outline-none"
          />
        </div>

        <button
          type="submit"
          data-testid="sync-submit"
          disabled={state.kind === 'submitting' || assetTag.length === 0}
          className="inline-flex items-center rounded-full border border-gold/40 bg-gold/10 px-5 py-2 text-sm font-semibold text-gold-champagne transition-colors hover:bg-gold/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state.kind === 'submitting' ? 'Registering…' : 'Register for sync licensing'}
        </button>
      </form>

      {state.kind === 'success' && (
        <div
          data-testid="sync-success"
          role="status"
          className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4"
        >
          <p className="text-sm font-medium text-emerald-300">{state.message}</p>
          <p className="mt-1.5 font-mono text-xs text-slate-400" data-testid="sync-success-splits">
            Locked splits — ownership {state.splits.t1 / 100}% · creative {state.splits.t2 / 100}% · production {state.splits.t3 / 100}%
          </p>
        </div>
      )}
      {state.kind === 'error' && (
        <div data-testid="sync-error" role="alert" className="mt-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4">
          <p className="text-sm text-red-300">{state.message}</p>
        </div>
      )}
    </section>
  );
}
