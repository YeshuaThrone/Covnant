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
import { operationsFlows, type OperationsFlows } from '@/lib/admin/operations';
import type { Store } from '@/lib/server/store';
import type { AdminCreatorProfile } from '@/lib/admin/types';
import { attachRegistryPills } from '@/lib/ledger/finances';
import { cvtDisplayCode } from '@/lib/splits/codes';
import { isDemoDoorOpen, listDemoLaneExecutions } from '@/lib/admin/demoSeeds';
import { MASTER_DEMO_ASSET_REGISTRY, bindFactoryEntity, executionTelemetryFor } from '@/lib/master/masterStore';
import { entityClassTag } from '@/lib/master/CovnantAtomicDataSDK';
import {
  annualPayeeRows,
  buildTaxJoinContext,
  currencyRollupRows,
  isDemoLedger,
  periodSummaryRows,
  resolvePayeePayouts,
  transactionRegisterRows,
  withholdingRegisterRows,
  type TaxJoinContext,
} from '@/lib/tax/withholding';
import type { SovereignLedgerRecord } from '@/lib/master/sovereignLedger';
import type {
  ContractRegistrySection,
  ContractRow,
  ExecutionStampRow,
  LedgerFinancesSection,
  SectionData,
  TaxSectionData,
  TemplateBindingRow,
} from '@/components/admin/types';

/** The page's real store reads — the composers accept exactly what the page passes. */
export type ListAssetsResult = Awaited<ReturnType<typeof listAssets>>;
export type ListLedgerResult = Awaited<ReturnType<typeof listLedger>>;

/**
 * The Operations tab's payload (spec art_Eis55ifL) — `operationsFlows`' five
 * back-office views over the Don store door and the SAME ledger rows and
 * join context the Tax tab reads (one truth, never re-derived). The
 * derivation degrades to null on a failed store read; that becomes the
 * section's honest unavailable state — never an empty lie.
 */
export async function buildOperationsSection(inputs: {
  store: Store;
  ledgerRows: ListLedgerResult;
  assets: ListAssetsResult;
  contracts: SectionData<ContractRow[]>;
  creatorProfiles: readonly AdminCreatorProfile[] | null;
}): Promise<SectionData<OperationsFlows>> {
  const flows = await operationsFlows({
    store: inputs.store,
    ledgerRows: inputs.ledgerRows,
    assets: inputs.assets,
    taxJoinContext: buildAdminTaxJoinContext(inputs.assets, inputs.contracts),
    creatorProfiles: inputs.creatorProfiles,
  });
  return flows === null
    ? { kind: 'unavailable', code: 'operations_store_failed', message: 'Operations store read failed.' }
    : { kind: 'ready', value: flows };
}

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

/** The event's US state jurisdiction from the agreement's governing law ('US-TX Ledger Standard' → 'TX'). */
function stateFromGoverningLaw(law: string): string | null {
  const match = /^US-([A-Z]{2})\b/.exec(law);
  return match ? match[1] : null;
}

/**
 * The admin console's tax join context — the SAME joins the Tax tab and the
 * CSV export use. Exported so payout-level tests fold through one builder.
 */
export function buildAdminTaxJoinContext(
  assets: ListAssetsResult,
  contracts: SectionData<ContractRow[]>,
): TaxJoinContext {
  return buildTaxJoinContext(assets, {
    entityTypeLabels: MASTER_DEMO_ASSET_REGISTRY.map((asset) => ({
      cbtCode: asset.cbt,
      label: asset.kind,
    })),
    templateBindings: [
      ...(contracts.kind === 'ready'
        ? contracts.value.map((contract) => ({
            cbtCode: contract.cbtCode,
            templateId: contract.templateId,
          }))
        : []),
      ...listDemoLaneExecutions().map((execution) => ({
        cbtCode: execution.cbt ?? '',
        templateId: execution.templateId,
      })),
    ],
    eventStates: MASTER_DEMO_ASSET_REGISTRY.flatMap((asset) => {
      const state = stateFromGoverningLaw(asset.agreement.governingLaw);
      return state ? [{ cbtCode: asset.cbt, state }] : [];
    }),
  });
}

/**
 * The Tax section's payload — the founder's tax data sheet. Every USD
 * settlement's disbursements resolve through CovnantTaxEngineSDK (the tax
 * engine of record) in chronological order with running per-payee YTD; the
 * ledger layer keeps its own exact minor-unit sums. Joins derive from the
 * stores of record: template bindings from the vault contracts plus the
 * lane execution stamps, entity types from the asset registry plus the
 * demo registry's kinds, event states from the agreements' governing law.
 * The register covers EVERY creator with cleared history — never a
 * curated subset (founder addendum, 2026-09-21).
 */
export function buildTaxSection(
  rows: ListLedgerResult,
  assets: ListAssetsResult,
  contracts: SectionData<ContractRow[]>,
): TaxSectionData {
  const joinContext = buildAdminTaxJoinContext(assets, contracts);
  const fold = resolvePayeePayouts(rows, joinContext);
  return {
    demo: isDemoLedger(rows),
    payees: withholdingRegisterRows(fold.payouts, fold.ytdByPayee),
    periods: periodSummaryRows(rows, fold.payouts),
    annual: annualPayeeRows(fold.payouts),
    transactions: transactionRegisterRows(rows, fold.payouts, joinContext),
    currencies: currencyRollupRows(rows),
    excludedNonUsdSettlements: fold.excludedNonUsdSettlements,
  };
}

