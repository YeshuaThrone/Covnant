'use client';

/**
 * /settings — workspace preferences (directive §5).
 *
 * Client-side only: preferences live in this browser's localStorage
 * (key `covnant.settings.v1`) — no auth changes, no server writes, no API
 * calls. The surface restores after hydration to avoid a server/client
 * mismatch, and surfaces an honest error if storage is unavailable
 * (private mode, quota) instead of swallowing it.
 */

import { useEffect, useState } from 'react';
import { CURRENCY_DECIMALS } from '@/lib/ledger/currency-precision';

const STORAGE_KEY = 'covnant.settings.v1';

type CodeDisplay = 'FULL' | 'MASKED';

interface WorkspacePreferences {
  displayCurrency: string;
  codeDisplay: CodeDisplay;
}

const DEFAULTS: WorkspacePreferences = {
  displayCurrency: 'USD',
  codeDisplay: 'FULL',
};

const CURRENCIES = Object.keys(CURRENCY_DECIMALS).sort();

function loadPreferences(): WorkspacePreferences | { error: string } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULTS;
    const record = parsed as Record<string, unknown>;
    return {
      displayCurrency:
        typeof record.displayCurrency === 'string' && CURRENCIES.includes(record.displayCurrency)
          ? record.displayCurrency
          : DEFAULTS.displayCurrency,
      codeDisplay: record.codeDisplay === 'MASKED' ? 'MASKED' : 'FULL',
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Preferences could not be read.',
    };
  }
}

function savePreferences(prefs: WorkspacePreferences): string | null {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'Preferences could not be saved in this browser.';
  }
}

function maskCode(code: string): string {
  if (code.length <= 8) return code;
  return `${code.slice(0, 4)}····${code.slice(-4)}`;
}

export default function SettingsPage() {
  const [hydrated, setHydrated] = useState(false);
  const [prefs, setPrefs] = useState<WorkspacePreferences>(DEFAULTS);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    const result = loadPreferences();
    if ('error' in result) {
      setStorageError(result.error);
    } else {
      setPrefs(result);
    }
    setHydrated(true);
  }, []);

  const update = (next: WorkspacePreferences) => {
    setPrefs(next);
    const error = savePreferences(next);
    setStorageError(error);
    if (!error) setSavedAt(Date.now());
  };

  const sampleCode = 'CBT-TRK-4A3F2879BD05';

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">Settings</p>
      <h1 className="mt-2 text-3xl font-semibold text-white md:text-4xl">Workspace Settings</h1>
      <p className="mt-3 max-w-2xl text-sm text-white/60">
        Display preferences for this browser. They are stored locally on your device —
        no account is touched and nothing is written to the server.
      </p>
      <div className="gold-rule my-8" />

      {storageError && (
        <p
          role="alert"
          className="mb-6 rounded-lg border border-red-400/40 bg-red-400/10 p-3 text-sm text-red-300"
        >
          Preferences are unavailable in this session: {storageError}
        </p>
      )}

      <div className="glass-card p-6">
        <h2 className="text-lg font-semibold text-white">Display</h2>

        <div className="mt-5 grid gap-5">
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">
              Display currency
            </span>
            <select
              value={prefs.displayCurrency}
              onChange={(e) => update({ ...prefs, displayCurrency: e.target.value })}
              disabled={!hydrated}
              className="mt-2 block w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white focus:border-gold/60 focus:outline-none"
              data-testid="display-currency"
            >
              {CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-white/40">
              Used wherever a single display currency is offered; the ledger always reports
              per settlement currency.
            </span>
          </label>

          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">
              Code display format
            </span>
            <select
              value={prefs.codeDisplay}
              onChange={(e) =>
                update({ ...prefs, codeDisplay: e.target.value as CodeDisplay })
              }
              disabled={!hydrated}
              className="mt-2 block w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white focus:border-gold/60 focus:outline-none"
              data-testid="code-display"
            >
              <option value="FULL">Full — CBT-TRK-4A3F2879BD05</option>
              <option value="MASKED">Masked — CBT-····BD05</option>
            </select>
            <span className="mt-1 block text-xs text-white/40">
              Sample: <code className="font-mono text-gold">{sampleCode}</code> →{' '}
              <code className="font-mono text-gold-champagne">
                {prefs.codeDisplay === 'MASKED' ? maskCode(sampleCode) : sampleCode}
              </code>
            </span>
          </label>
        </div>

        <p className="mt-6 text-xs text-white/40" role="status" aria-live="polite">
          {!hydrated
            ? 'Restoring your preferences…'
            : storageError
              ? 'Changes are not being saved — see the error above.'
              : savedAt
                ? 'Saved in this browser just now.'
                : 'Stored locally in this browser only.'}
        </p>
      </div>

      <button
        type="button"
        onClick={() => update(DEFAULTS)}
        disabled={!hydrated}
        className="mt-6 rounded-lg border border-white/15 px-4 py-2 text-sm text-white/60 transition hover:border-gold/50 hover:text-gold disabled:opacity-50"
      >
        Reset to defaults
      </button>
    </main>
  );
}
