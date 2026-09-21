/**
 * Contracts — the CONTRACT REGISTRY (founder directive, 2026-09-20: the
 * Contracts tab is NOT the money view — that is the Ledger tab's job).
 *
 * Three registry layers, all read-only:
 *  1. Execution stamps — CBT-stamped contract executions from the master
 *     clearing ledger (the Universal Execution Lane's CBT/CVT lineage).
 *  2. Template bindings — the master template library's binding state:
 *     sector, execution status, entity class telemetry, lane execution state.
 *  3. The vault index — stored agreements with their signature state and
 *     CVT display lineage.
 *
 * No settlement math renders here — gross, fees, withholding, corner dust,
 * and net live exclusively on the Ledger finances surface.
 */

import { cvtDisplayCode } from '@/lib/splits/codes';
import type { ContractRegistrySection, ContractRow, SectionData } from '../types';
import { SectionEmpty, SectionEyebrow, SectionUnavailable, StatusPill, type PillTone } from '../shared';

/** Signature state of record — the vault's own DRAFT/FINAL state machine, worded for the registry. */
function signatureState(status: ContractRow['status']): { label: string; tone: PillTone } {
  return status === 'FINAL'
    ? { label: 'Signature state: EXECUTED', tone: 'jade' }
    : { label: 'Signature state: AWAITING SIGNATURE', tone: 'amber' };
}

export function ContractsSection({
  registry,
  contracts,
}: {
  registry: ContractRegistrySection;
  contracts: SectionData<ContractRow[]>;
}) {
  if (contracts.kind === 'unavailable') {
    return (
      <div aria-label="Contracts">
        <SectionEyebrow>Contract registry</SectionEyebrow>
        <div className="mt-4">
          <SectionUnavailable code={contracts.code} message={contracts.message} />
        </div>
      </div>
    );
  }

  const rows = contracts.value;

  return (
    <div aria-label="Contracts">
      <div className="flex items-center justify-between gap-3">
        <SectionEyebrow>Contract registry</SectionEyebrow>
        {registry.demo ? (
          <span
            data-testid="demo-data-badge"
            className="inline-flex shrink-0 items-center rounded-full border border-amber-300/40 bg-amber-300/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-amber-300"
          >
            Demo data
          </span>
        ) : null}
      </div>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        CBT-stamped contract executions, template bindings with entity telemetry,
        signature state, and CBT/CVT lineage — the registry layer, every vertical of
        entertainment. Money and settlement math live on the Ledger tab.
      </p>

      {/* Layer 1 — CBT-stamped executions from the master clearing ledger. */}
      <section aria-label="Contract execution stamps" className="mt-6">
        <h3 className="text-lg font-semibold text-white">Contract executions</h3>
        <p className="mt-2 max-w-2xl text-sm text-white/50">
          Every lane execution the clearing ledger stamped — CBT bound to its derived
          CVT display badge, with the template and sector of record.
        </p>
        {registry.executions.length === 0 ? (
          <SectionEmpty>
            No contract executions stamped yet — executions land here when a lane
            binding executes through the clearinghouse.
          </SectionEmpty>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border border-white/10" data-testid="contract-execution-registry">
            <table className="status-table">
              <thead>
                <tr>
                  <th className="px-4 py-3 font-medium">Execution stamp</th>
                  <th className="px-4 py-3 font-medium">Asset</th>
                  <th className="px-4 py-3 font-medium">CBT</th>
                  <th className="px-4 py-3 font-medium">CVT</th>
                  <th className="px-4 py-3 font-medium">Template</th>
                  <th className="px-4 py-3 font-medium">Sector</th>
                  <th className="px-4 py-3 font-medium">Stamped</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {registry.executions.map((execution) => (
                  <tr key={execution.executionId}>
                    <td className="px-4 py-3 font-mono text-xs text-gold-champagne/90">{execution.executionId}</td>
                    <td className="px-4 py-3 text-white/80">{execution.assetTitle}</td>
                    <td className="px-4 py-3 font-mono text-xs text-white/60">{execution.cbt ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-white/60">{execution.cvt ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-white/60">{execution.templateId ?? '—'}</td>
                    <td className="px-4 py-3 text-white/60">{execution.sector ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-white/50">
                      {execution.stampedAt.slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Layer 2 — template bindings with entity telemetry and lane execution state. */}
      <section aria-label="Template binding registry" className="mt-8">
        <h3 className="text-lg font-semibold text-white">Template bindings</h3>
        <p className="mt-2 max-w-2xl text-sm text-white/50">
          The master template library&apos;s registry state — sector, execution status,
          bound entity class, and lane execution telemetry per template key.
        </p>
        <div className="mt-4 overflow-x-auto rounded-lg border border-white/10" data-testid="template-binding-registry">
          <table className="status-table">
            <thead>
              <tr>
                <th className="px-4 py-3 font-medium">Template key</th>
                <th className="px-4 py-3 font-medium">Template</th>
                <th className="px-4 py-3 font-medium">Sector</th>
                <th className="px-4 py-3 font-medium">Execution status</th>
                <th className="px-4 py-3 font-medium">Entity class</th>
                <th className="px-4 py-3 font-medium">Lane state</th>
                <th className="px-4 py-3 font-medium text-right">Executed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {registry.templates.map((template) => (
                <tr key={template.templateId}>
                  <td className="px-4 py-3 font-mono text-xs text-gold-champagne/90">{template.templateId}</td>
                  <td className="px-4 py-3 text-white/80">{template.templateName}</td>
                  <td className="px-4 py-3 text-white/60">{template.sector}</td>
                  <td className="px-4 py-3">
                    <StatusPill
                      label={template.executionStatus}
                      tone={template.executionStatus === 'LEGAL_VAULT_LOCKED' ? 'neutral' : 'jade'}
                    />
                  </td>
                  <td className="px-4 py-3">
                    {template.entityClassTag ? (
                      <span className="inline-flex items-center rounded-full border border-gold/40 bg-gold/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-gold-champagne">
                        {template.entityClassTag}
                      </span>
                    ) : (
                      <span className="font-mono text-xs text-white/40">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-white/60">
                    {template.executionState ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-white/60">{template.timesExecuted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Layer 3 — the vault index with signature state and lineage. */}
      <section aria-label="Vault contract records" className="mt-8">
        <h3 className="text-lg font-semibold text-white">Vault records</h3>
        <p className="mt-2 max-w-2xl text-sm text-white/50">
          Read-only index of stored agreements with signature state and CVT lineage.
          Open, edit, and finalize happen in the vault — this list mirrors their state
          for the operator.
        </p>
        {rows.length === 0 ? (
          <SectionEmpty>
            No contracts stored yet — agreements appear here after the first one is
            saved in the vault.
          </SectionEmpty>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-lg border border-white/10" data-testid="contract-vault-index">
            <table className="status-table">
              <thead>
                <tr>
                  <th className="px-4 py-3 font-medium">Contract</th>
                  <th className="px-4 py-3 font-medium">CVT</th>
                  <th className="px-4 py-3 font-medium">Template</th>
                  <th className="px-4 py-3 font-medium">Industry</th>
                  <th className="px-4 py-3 font-medium">Signature state</th>
                  <th className="px-4 py-3 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {rows.map((contract) => {
                  const signature = signatureState(contract.status);
                  return (
                    <tr key={contract.id}>
                      <td className="px-4 py-3 font-mono text-xs text-gold-champagne/90">{contract.cbtCode}</td>
                      <td className="px-4 py-3 font-mono text-xs text-white/60">{cvtDisplayCode(contract.cbtCode)}</td>
                      <td className="px-4 py-3 font-mono text-xs text-white/60">{contract.templateId}</td>
                      <td className="px-4 py-3 text-white/60">{contract.industry}</td>
                      <td className="px-4 py-3">
                        <StatusPill label={signature.label} tone={signature.tone} />
                      </td>
                      <td className="px-4 py-3 text-white/60">
                        {new Date(contract.updatedAt).toISOString().slice(0, 10)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
