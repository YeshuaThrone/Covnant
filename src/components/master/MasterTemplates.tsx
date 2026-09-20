/**
 * MasterTemplates — the Sovereign Contract Factory's presentational layer
 * (founder canon, CovnantTemplatesSDK): the execution-status chip, the
 * 50/35/15 split pills, and the factory card grid rendered on /templates.
 * PURE PRESENTATION — every field arrives as a `ContractTemplateRecord`
 * from the master template store (src/lib/master/masterStore); nothing is
 * inlined here, and the pills render from the record's splitStructure
 * fields, never from a display constant.
 *
 * Shells stay frozen: the glass cards, gold pills, and mono chips reuse the
 * established classes of the master data surfaces (MasterData.tsx).
 */

import type {
  ContractTemplateRecord,
  TemplateExecutionStatus,
  AtomicContractRecord,
} from '@/lib/master/masterStore';

/** Execution status chip — the two canon states, distinct voices. */
export function ExecutionStatusChip({ status }: { status: TemplateExecutionStatus }): React.JSX.Element {
  const classes: Record<TemplateExecutionStatus, string> = {
    PRODUCTION_READY: 'border-emerald-400/40 text-emerald-300',
    LEGAL_VAULT_LOCKED: 'border-gold/50 text-gold',
  };
  return (
    <span
      data-testid="factory-execution-status"
      className={`inline-block rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.15em] ${classes[status]}`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

/** The 50/35/15 pills — each weight read from the record's own structure. */
export function FactorySplitPills({
  splitStructure,
}: {
  splitStructure: ContractTemplateRecord['splitStructure'];
}): React.JSX.Element {
  const pills: Array<[string, number]> = [
    ['Ownership reserve', splitStructure.ownershipReserve],
    ['Creative payout', splitStructure.creativePayout],
    ['Operations yield', splitStructure.operationsYield],
  ];
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="factory-split-pills">
      {pills.map(([label, weight]) => (
        <span
          key={label}
          className="inline-flex items-center gap-1 rounded-full border border-gold/25 bg-gold/5 px-2.5 py-0.5 font-mono text-[10px] text-gold-champagne"
        >
          {label} {weight}%
        </span>
      ))}
    </div>
  );
}

/** Deterministic integer formatting — hydration-safe, fixed locale. */
function executionsLabel(count: number): string {
  return count.toLocaleString('en-US');
}

/** One factory card — every canon field of the master template record. */
export function FactoryTemplateCard({ record }: { record: ContractTemplateRecord }): React.JSX.Element {
  return (
    <article
      className="glass-card flex h-full flex-col p-5"
      data-testid="factory-template-card"
      data-template-id={record.templateId}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">
          {record.templateId}
        </span>
        <ExecutionStatusChip status={record.executionStatus} />
      </div>
      <h3 className="mt-2 font-medium text-white">{record.templateName}</h3>
      <p className="mt-1 text-sm text-white/50">
        {record.subCategory} · {record.governingJurisdiction}
      </p>
      <div className="mt-3">
        <FactorySplitPills splitStructure={record.splitStructure} />
      </div>
      <ul className="mt-3 flex-1 space-y-1" data-testid="factory-key-clauses">
        {record.keyClauses.map((clause) => (
          <li key={clause} className="flex gap-2 text-xs text-white/60">
            <span className="text-gold" aria-hidden>
              ·
            </span>
            <span>{clause}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 font-mono text-xs text-white/40">
        {record.keyClauses.length} key clauses · {executionsLabel(record.timesExecuted)} executions
      </p>
    </article>
  );
}

/** The factory grid — same card-grid language as the master surfaces. */
export function FactoryTemplateGrid({
  records,
}: {
  records: readonly ContractTemplateRecord[];
}): React.JSX.Element {
  return (
    <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="factory-template-grid">
      {records.map((record) => (
        <li key={record.templateId}>
          <FactoryTemplateCard record={record} />
        </li>
      ))}
    </ul>
  );
}

/** Sector chip — the atomic record's granular sector of the 26-sector canon. */
function AtomicSectorChip({ sector }: { sector: string }): React.JSX.Element {
  return (
    <span
      data-testid="atomic-sector-chip"
      className="inline-block rounded-full border border-gold/40 bg-gold/10 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-gold-champagne"
    >
      {sector.replace(/_/g, ' ')}
    </span>
  );
}

/** One atomic card — every canon field of the Sovereign Clearing Framework record. */
export function AtomicTemplateCard({ record }: { record: AtomicContractRecord }): React.JSX.Element {
  return (
    <article
      className="glass-card flex h-full flex-col p-5"
      data-testid="atomic-template-card"
      data-atomic-sector={record.atomicSector}
      data-template-id={record.templateId}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">
          {record.templateId}
        </span>
        <ExecutionStatusChip status={record.executionStatus} />
      </div>
      <h3 className="mt-2 font-medium text-white">{record.templateName}</h3>
      <div className="mt-2">
        <AtomicSectorChip sector={record.atomicSector} />
      </div>
      <p className="mt-2 text-sm text-white/50">
        {record.entityType}
        <br />
        {record.telemetryMetric}
      </p>
      <div className="mt-3">
        <FactorySplitPills splitStructure={record.splitStructure} />
      </div>
      <ul className="mt-3 flex-1 space-y-1" data-testid="atomic-key-clauses">
        {record.keyClauses.map((clause) => (
          <li key={clause} className="flex gap-2 text-xs text-white/60">
            <span className="text-gold" aria-hidden>
              ·
            </span>
            <span>{clause}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 font-mono text-xs text-white/40">
        {record.keyClauses.length} key clauses · {executionsLabel(record.timesExecuted)} executions
      </p>
    </article>
  );
}

/** The atomic grid — the registry rendered beneath its master vertical tab. */
export function AtomicTemplateGrid({
  records,
}: {
  records: readonly AtomicContractRecord[];
}): React.JSX.Element {
  return (
    <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="atomic-template-grid">
      {records.map((record) => (
        <li key={record.templateId}>
          <AtomicTemplateCard record={record} />
        </li>
      ))}
    </ul>
  );
}
