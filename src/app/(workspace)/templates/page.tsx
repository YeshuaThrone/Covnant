import type {
  AtomicContractRecord,
  ContractTemplateRecord,
} from '@/lib/master/masterStore';
import {
  bindAtomicEntity,
  bindFactoryEntity,
  executionTelemetryFor,
  masterTemplatesForCategory,
  resolveMasterTemplates,
  atomicRecordsForCategory,
  resolveAtomicRegistry,
} from '@/lib/master/masterStore';
import {
  MASTER_CATEGORY_ORDER,
  masterCategoryFromParam,
} from '@/lib/master/taxonomy';
import type {
  ControlBoardState,
  EntityBoundAtomicRecord,
  EntityBoundFactoryTemplate,
} from '@/lib/master/controlBoard';
import { HeaderActions } from '@/components/workspace/HeaderActions';
import { TemplatesControlBoard } from '@/components/master/TemplatesControlBoard';

export const dynamic = 'force-dynamic';

function bindFactoryPair(record: ContractTemplateRecord): EntityBoundFactoryTemplate {
  return { record, entity: bindFactoryEntity(record), execution: executionTelemetryFor(record.templateId) };
}

function bindAtomicPair(record: AtomicContractRecord): EntityBoundAtomicRecord {
  return { record, entity: bindAtomicEntity(record), execution: executionTelemetryFor(record.templateId) };
}

/**
 * /templates — the COVNANT CONTROL BOARD (founder directive, 2026-09-20),
 * on the existing page shell: the six master entertainment verticals tab
 * the boards, and every tab renders a fully populated board — every form
 * of entertainment, none left out.
 *
 * The server SSRs the default view (first paint) with every card
 * entity-bound from the master store engine; the client board hydrates
 * vertical swaps from the per-sector entity doors
 * (GET /api/v1/entities/[sector]). Cards render their ContractTemplateRecord
 * and AtomicContractRecord fields — jurisdiction, key clauses, the 50/35/15
 * allocation structure, execution history — plus the CovnantAtomicDataSDK
 * entity telemetry of their class: no inline literals anywhere (the honesty
 * law). Drafts and finalization live in the Contract Vault.
 */
export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const { category } = await searchParams;
  const active = masterCategoryFromParam(category);

  // The master data seam — the seeded factory library and atomic registry in
  // demo/preview (under the DEMO DATA badge), the canon definitions with
  // live-store execution counts otherwise. Store-computed, always.
  const { demo, records } = await resolveMasterTemplates();
  const { records: atomicRecords } = await resolveAtomicRegistry();

  const board: ControlBoardState = {
    demo,
    active,
    verticals: (active ? [active] : [...MASTER_CATEGORY_ORDER]).map((vertical) => ({
      vertical,
      factoryTemplates: masterTemplatesForCategory(records, vertical).map(bindFactoryPair),
      atomicRecords: atomicRecordsForCategory(atomicRecords, vertical).map(bindAtomicPair),
    })),
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-12">
      <header>
        <div className="flex items-center justify-between gap-2.5">
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">Templates</p>
          <HeaderActions demo={demo} />
        </div>
        <h1 data-testid="control-board-title" className="mt-3 text-3xl font-semibold text-white md:text-4xl">
          Covnant Control Board
        </h1>
        <p
          data-testid="control-board-subheader"
          className="mt-2 font-mono text-xs uppercase tracking-[0.25em] text-gold-champagne md:text-sm"
        >
          Atomic Entity Clearing &amp; Real-Time Telemetry Matrix
        </p>
        <p className="mt-4 max-w-2xl text-white/60">
          {records.length} contract templates and {atomicRecords.length} atomic sector records
          across the six master entertainment verticals and all 26 atomic sectors — click a
          vertical to swap the boards below.
        </p>
      </header>

      <div className="mt-10">
        {/* Keyed by the server view: a client-side param navigation (e.g.
            the All-verticals tab) re-renders the server board with new
            initial props — remount so useState adopts them instead of
            holding a stale single-vertical state. */}
        <TemplatesControlBoard key={active ?? 'all'} initial={board} />
      </div>
    </div>
  );
}
