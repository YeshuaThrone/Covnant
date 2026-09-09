/**
 * Contracts — read-only list over the contracts store. The console shows
 * the record's metadata; the documents themselves stay in the vault.
 */

import type { ContractRow, SectionData } from '../types';
import { SectionEmpty, SectionEyebrow, SectionUnavailable, StatusPill, type PillTone } from '../shared';

const CONTRACT_TONE: Record<ContractRow['status'], PillTone> = {
  DRAFT: 'amber',
  FINAL: 'jade',
};

export function ContractsSection({ contracts }: { contracts: SectionData<ContractRow[]> }) {
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

      {rows.length === 0 ? (
        <SectionEmpty>
          No contracts stored yet — agreements appear here after the first one is
          saved in the vault.
        </SectionEmpty>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-white/10">
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
