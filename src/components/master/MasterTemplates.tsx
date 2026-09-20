/**
 * MasterTemplates — the Covnant Control Board's presentational layer
 * (founder directive, 2026-09-20): the execution-status chip, the 50/35/15
 * split pills, the isolated entity class pills, the entity telemetry
 * blocks, and the factory/atomic card grids rendered on /templates.
 * PURE PRESENTATION — every field arrives typed from the master template
 * store (src/lib/master/masterStore) and the CovnantAtomicDataSDK; nothing
 * is inlined here (the honesty law), and the pills render from the
 * record's splitStructure fields, never from a display constant.
 *
 * Shells stay frozen: the glass cards, gold pills, and mono chips reuse the
 * established classes of the master data surfaces (MasterData.tsx). The
 * dark obsidian theme and gold accent lines are unchanged by the entity
 * layer — telemetry renders inside the existing card shell, and sectors
 * without an SDK entity class keep their telemetryMetric display.
 */

import type {
  ContractTemplateRecord,
  TemplateExecutionStatus,
} from '@/lib/master/masterStore';
import type { EntityBoundAtomicRecord, EntityBoundFactoryTemplate } from '@/lib/master/controlBoard';
import {
  entityClassTag,
  type AtomicExecutionTelemetry,
  type SovereignAtomicEntity,
} from '@/lib/master/CovnantAtomicDataSDK';
import { formatCents, formatUsdAmount } from '@/lib/money/format';

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

/** One isolated entity class pill — one pill per entity class, never bundled. */
export function EntityClassPill({ entity }: { entity: SovereignAtomicEntity }): React.JSX.Element {
  const tag = entityClassTag(entity);
  return (
    <span
      data-testid="entity-class-pill"
      data-entity-class={tag}
      className="inline-flex items-center rounded-full border border-gold/40 bg-gold/10 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em] text-gold-champagne"
    >
      {tag}
    </span>
  );
}

/** Domain telemetry rows of an entity — the canon fields of its own class. */
function entityTelemetryRows(entity: SovereignAtomicEntity): Array<[string, string]> {
  switch (entity.entityType) {
    case 'MASTER_RECORDING':
      return [
        ['ISRC code', entity.isrcCode],
        ['Sub-second micro royalty rate', entity.subSecondMicroRoyaltyRate.toFixed(4)],
        ['PRO telemetry binding', entity.proTelemetryBinding],
      ];
    case 'FEATURE_FILM':
      return [
        ['ISAN code', entity.isanCode],
        ['Theatrical gross escrow', formatUsdAmount(entity.theatricalGrossEscrowUSD)],
        ['Studio overlay', entity.studioOverlayActive ? 'ENGAGED' : 'CLEAR'],
      ];
    case 'LINEAR_TV':
      return [
        ['Nielsen flight minutes', executionsLabel(entity.nielsenFlightMinutes)],
        ['Ad insertion micro yield', formatUsdAmount(entity.adInsertionMicroYieldUSD)],
        ['Syndication reversion', entity.syndicationReversionLock ? 'LOCKED' : 'OPEN'],
      ];
    case 'PODCAST_NETWORK':
      return [
        ['Download telemetry', executionsLabel(entity.downloadCountTelemetry)],
        ['Dynamic ad insert yield', formatUsdAmount(entity.dynamicAdInsertYieldUSD)],
        ['Feed isolation', entity.feedIsolationActive ? 'ACTIVE' : 'IDLE'],
      ];
    case 'STAGE_PERFORMANCE':
      return [
        ['Ticket escrow balance', formatUsdAmount(entity.ticketEscrowBalanceUSD)],
        ['Promoter instant allocation', formatUsdAmount(entity.promoterInstantAllocationUSD)],
        ['House seat clearance', entity.houseSeatClearanceLock ? 'LOCKED' : 'OPEN'],
      ];
    case 'LITERARY_WORK':
      return [
        ['ISBN', entity.isbnNumber],
        ['Print-on-demand yield', formatUsdAmount(entity.printOnDemandYieldUSD)],
        ['Citation telemetry', executionsLabel(entity.citationTelemetryCount)],
      ];
  }
}

/**
 * The entity telemetry block — the bound entity's class pill and its
 * domain fields, all read through the SDK interfaces. Execution telemetry
 * renders beside the pill when the store has it wired (the drop-5 canon:
 * the gross is engine-path cents; the state is CLEARED or HELD IN ESCROW).
 */
export function EntityTelemetryBlock({
  entity,
  execution,
}: {
  entity: SovereignAtomicEntity;
  execution: AtomicExecutionTelemetry | null;
}): React.JSX.Element {
  const rows = entityTelemetryRows(entity);
  return (
    <div data-testid="entity-telemetry-block" className="rounded-lg border border-gold/20 bg-gold/[0.04] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <EntityClassPill entity={entity} />
        {execution ? (
          <span
            data-testid="entity-execution-telemetry"
            data-entity-execution-state={execution.executionState}
            className="font-mono text-[10px] uppercase tracking-[0.15em] text-gold-champagne"
          >
            {formatCents(execution.grossVolumeCents)} · {execution.executionState.replace(/_/g, ' ')}
          </span>
        ) : null}
      </div>
      <dl className="mt-2 space-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3">
            <dt className="font-mono text-[10px] uppercase tracking-[0.15em] text-white/40">{label}</dt>
            <dd className="font-mono text-xs text-white/80">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** One factory card — every canon field of the master template record. */
export function FactoryTemplateCard({
  record,
  entity,
  execution,
}: EntityBoundFactoryTemplate): React.JSX.Element {
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
      {entity ? (
        <div className="mt-3">
          <EntityTelemetryBlock entity={entity} execution={execution} />
        </div>
      ) : null}
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
  records: readonly EntityBoundFactoryTemplate[];
}): React.JSX.Element {
  return (
    <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="factory-template-grid">
      {records.map((bound) => (
        <li key={bound.record.templateId}>
          <FactoryTemplateCard {...bound} />
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

/** One atomic card — every canon field of the atomic clearing record. */
export function AtomicTemplateCard({
  record,
  entity,
  execution,
}: EntityBoundAtomicRecord): React.JSX.Element {
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
      {entity ? (
        <div className="mt-3">
          <EntityTelemetryBlock entity={entity} execution={execution} />
        </div>
      ) : null}
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
  records: readonly EntityBoundAtomicRecord[];
}): React.JSX.Element {
  return (
    <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="atomic-template-grid">
      {records.map((bound) => (
        <li key={bound.record.templateId}>
          <AtomicTemplateCard {...bound} />
        </li>
      ))}
    </ul>
  );
}
