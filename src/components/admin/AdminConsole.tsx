'use client';

/**
 * AdminConsole — the gated operator console shell. Renders the six
 * sections as tabs (Overview, Creators, Registry, Ledger, Contracts,
 * Allowlists) in the established obsidian/deep-gold language.
 *
 * Mutation results are lifted here (updated creator profile / allowlist
 * row from the mutation response) so a section stays consistent when the
 * operator switches tabs and back — the server snapshot on the page only
 * refreshes on reload.
 */

import { useState } from 'react';
import type { AdminConsoleData } from './types';
import { OverviewSection } from './sections/OverviewSection';
import { CreatorsSection } from './sections/CreatorsSection';
import { RegistrySection } from './sections/RegistrySection';
import { LedgerSection } from './sections/LedgerSection';
import { ContractsSection } from './sections/ContractsSection';
import { AllowlistsSection } from './sections/AllowlistsSection';

export type AdminTab =
  | 'overview'
  | 'creators'
  | 'registry'
  | 'ledger'
  | 'contracts'
  | 'allowlists';

const TABS: readonly { id: AdminTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'creators', label: 'Creators' },
  { id: 'registry', label: 'UCT Registry' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'contracts', label: 'Contracts' },
  { id: 'allowlists', label: 'Allowlists' },
];

function replaceById<T extends { id: string }>(rows: T[], next: T): T[] {
  return rows.map((row) => (row.id === next.id ? next : row));
}

export function AdminConsole({ data }: { data: AdminConsoleData }) {
  const [tab, setTab] = useState<AdminTab>('overview');
  const [profiles, setProfiles] = useState(data.creators);
  const [allowlists, setAllowlists] = useState(data.allowlists);

  const tabClasses = (active: boolean) =>
    `rounded-lg px-4 py-2 text-sm transition-colors ${
      active
        ? 'border border-gold/50 bg-gold/10 text-gold-champagne'
        : 'border border-transparent text-white/50 hover:text-white'
    }`;

  return (
    <div aria-label="Admin console" data-admin="console" className="min-h-screen bg-obsidian-900 text-white">
      <header className="border-b border-white/10">
        <div className="mx-auto max-w-6xl px-6 py-10">
          <p className="font-mono text-xs uppercase tracking-[0.35em] text-gold-champagne">
            Covnant Operator Console
          </p>
          <h1 className="mt-3 text-3xl font-semibold">
            <span className="bg-gradient-to-r from-gold-champagne to-gold bg-clip-text text-transparent">
              Covenant operations
            </span>
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-white/50">
            Gated by the dashboard secret. Every write made here is recorded in
            the append-only admin action log.
          </p>
          <nav aria-label="Console sections" className="mt-8 flex flex-wrap gap-2">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-current={tab === id ? 'page' : undefined}
                className={tabClasses(tab === id)}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {tab === 'overview' && <OverviewSection data={data} />}
        {tab === 'creators' && (
          <CreatorsSection
            creators={profiles}
            onProfileUpdated={(profile) =>
              setProfiles((current) =>
                current.kind === 'ready'
                  ? { kind: 'ready', value: replaceById(current.value, profile) }
                  : current,
              )
            }
          />
        )}
        {tab === 'registry' && <RegistrySection registry={data.registry} />}
        {tab === 'ledger' && <LedgerSection ledger={data.ledger} />}
        {tab === 'contracts' && <ContractsSection contracts={data.contracts} />}
        {tab === 'allowlists' && (
          <AllowlistsSection
            allowlists={allowlists}
            onAllowlistUpdated={(row) =>
              setAllowlists((current) =>
                current.kind === 'ready'
                  ? { kind: 'ready', value: replaceById(current.value, row) }
                  : current,
              )
            }
          />
        )}
      </main>
    </div>
  );
}
