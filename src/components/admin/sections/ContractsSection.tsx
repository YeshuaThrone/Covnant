/**
 * Contracts — the enriched /contracts master-data view plus the read-only
 * index over the contracts store. The master block is the SAME hydration
 * the /contracts page serves (resolveMasterLedger → engine-computed
 * summary + ledger rows, passed down from the page's single seam — no new
 * routes); the vault table below it keeps its structure untouched.
 */

import type { MasterLedgerSection } from '../types';
import type { ContractRow, SectionData } from '../types';
import { MasterStatCards, SovereignLedgerTable } from '@/components/master/MasterData';
import { SectionEmpty, SectionEyebrow, SectionUnavailable, StatusPill, type PillTone } from '../shared';

const CONTRACT_TONE: Record<ContractRow['status'], PillTone> = {
  DRAFT: 'amber',
  FINAL: 'jade',
};

export function ContractsSection({
  contracts,
  master,
}: {
  contracts: SectionData<ContractRow[]>;
  master?: MasterLedgerSection;
}) {
  if (contracts.kind === 'unavailable') {
    return (
      <div aria-label="Contracts">
        <SectionEyebrow>Contract vault records</SectionEyebrow>
        <div className="mt-4">
          <SectionUnavailable code={contracts.code} message={contracts.message} />
        </div>
      </div>
    );
  }

  const rows = contracts.value;

  return (
    <div aria-label="Contracts">
      <SectionEyebrow>Contract vault records</SectionEyebrow>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        Read-only index of stored agreements. Open, edit, and finalize happen in
        the vault — this list mirrors their state for the operator.
      </p>

      {master ? (
        <section aria-label="Master contract data" className="mt-6">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-lg font-semibold text-white">
              Master contract data — six verticals
            </h3>
            {master.demo ? (
              <span
                data-testid="demo-data-badge"
                className="inline-flex shrink-0 items-center rounded-full border border-amber-300/40 bg-amber-300/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-amber-300"
              >
                Demo data
              </span>
            ) : null}
          </div>
          <p className="mt-2 max-w-2xl text-sm text-white/50">
            The same master hydration the /contracts page serves — the six master
            entertainment verticals with their 50 / 35 / 15 allocations, every figure
            computed through the settlement engine&apos;s integer-cent path.
            Per-vertical scoping stays on the /contracts page itself.
          </p>
          <div className="mt-4 space-y-4">
            <MasterStatCards summary={master.summary} />
            <SovereignLedgerTable records={master.records} />
          </div>
        </section>
      ) : null}

      {rows.length === 0 ? (
        <SectionEmpty>
          No contracts stored yet — agreements appear here after the first one is
          saved in the vault.
        </SectionEmpty>
      ) : (
        <div className="mt-8 overflow-x-auto rounded-lg border border-white/10">
          <table className="status-table">
            <thead>
              <tr>
                <th className="px-4 py-3 font-medium">Contract</th>
                <th className="px-4 py-3 font-medium">Template</th>
                <th className="px-4 py-3 font-medium">Industry</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {rows.map((contract) => (
                <tr key={contract.id}>
                  <td className="px-4 py-3 font-mono text-xs text-gold-champagne/90">{contract.cbtCode}</td>
                  <td className="px-4 py-3 font-mono text-xs text-white/60">{contract.templateId}</td>
                  <td className="px-4 py-3 text-white/60">{contract.industry}</td>
                  <td className="px-4 py-3">
                    <StatusPill label={contract.status} tone={CONTRACT_TONE[contract.status]} />
                  </td>
                  <td className="px-4 py-3 text-white/60">
                    {new Date(contract.updatedAt).toISOString().slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
