/**
 * /admin section payload composers — the server seam between the stores
 * and the console sections (founder directive, 2026-09-20: Ledger = the
 * FINANCES surface, Contracts = the REGISTRY).
 *
 * Pure composition over the store paths: the finances payload hydrates
 * settlement rows through the same selector layer the /ledger page reads
 * (one truth, never copied strings); the registry payload joins the
 * master clearing ledger's stamped executions with the master template
 * bindings and their entity telemetry. Kept out of the page file so the
 * vitest suite asserts on the exact composition the page renders.
 */

import { listAssets } from '@/lib/sdk';
import { listLedger } from '@/lib/ledger/store';
import { attachRegistryPills } from '@/lib/ledger/finances';
import { cvtDisplayCode } from '@/lib/splits/codes';
import { isDemoDoorOpen, listDemoLaneExecutions } from '@/lib/admin/demoSeeds';
import { MASTER_DEMO_ASSET_REGISTRY, bindFactoryEntity, executionTelemetryFor } from '@/lib/master/masterStore';
import { entityClassTag } from '@/lib/master/CovnantAtomicDataSDK';
import type { SovereignLedgerRecord } from '@/lib/master/sovereignLedger';
import type {
  ContractRegistrySection,
  ExecutionStampRow,
  LedgerFinancesSection,
  TemplateBindingRow,
} from '@/components/admin/types';

/** The page's real store reads — the composers accept exactly what the page passes. */
type ListAssetsResult = Awaited<ReturnType<typeof listAssets>>;
type ListLedgerResult = Awaited<ReturnType<typeof listLedger>>;

/**
 * The Ledger section's FINANCES payload — the settlement rows hydrated
 * through the same selector layer the /ledger page reads (one truth), with
 * the demo door's disclosure. No math is recomputed here; the section folds
 * the engine output on the client.
 */
export function buildLedgerFinancesSection(
  rows: ListLedgerResult,
  assets: ListAssetsResult,
): LedgerFinancesSection {
  return { demo: isDemoDoorOpen(), rows: attachRegistryPills(rows, assets) };
}

/**
 * The Contracts section's REGISTRY payload — CBT-stamped lane executions
 * (the minted stamps of record, plus any further clearing-ledger landings
 * joined by title), and the master template bindings with their entity
 * telemetry. Never settlement math — that lives on the Ledger tab.
 */
export function buildContractRegistrySection(
  masterTemplates: { demo: boolean; records: readonly import('@/lib/master/masterStore').ContractTemplateRecord[] },
  masterRecords: readonly SovereignLedgerRecord[],
): ContractRegistrySection {
  const executions: ExecutionStampRow[] = [...listDemoLaneExecutions()];
  const covered = new Set(executions.map((execution) => execution.ledgerId));
  const demoAssetByTitle = new Map(
    MASTER_DEMO_ASSET_REGISTRY.map((asset) => [asset.title, asset]),
  );
  for (const record of masterRecords) {
    if (record.clearinghouseStatus !== 'PENDING_CLEARANCE' || covered.has(record.ledgerId)) continue;
    const asset = demoAssetByTitle.get(record.assetTitle);
    executions.push({
      executionId: record.ledgerId,
      stampedAt: record.settlementTimestamp,
      ledgerId: record.ledgerId,
      assetTitle: record.assetTitle,
      cbt: asset?.cbt ?? null,
      cvt: asset ? cvtDisplayCode(asset.cbt) : null,
      templateId: null,
      sector: record.subcategory,
    });
  }

  const templates: TemplateBindingRow[] = masterTemplates.records.map((record) => ({
    templateId: record.templateId,
    templateName: record.templateName,
    sector: record.subCategory,
    verticalCategory: record.verticalCategory,
    executionStatus: record.executionStatus,
    timesExecuted: record.timesExecuted,
    entityClassTag: (() => {
      const entity = bindFactoryEntity(record);
      return entity ? entityClassTag(entity) : null;
    })(),
    executionState: executionTelemetryFor(record.templateId)?.executionState ?? null,
  }));

  return { demo: masterTemplates.demo, executions, templates };
}

