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
import { isDemoDoorOpen, listDemoLaneExecutions } from '@/lib/admin/demoSeeds';
import { demoCvtCode, MASTER_DEMO_ASSET_REGISTRY, bindFactoryEntity, executionTelemetryFor } from '@/lib/master/masterStore';
import { storedCvtHandle } from '@/lib/covnant/cvt';
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
  // The demo asset join rides ONLY behind the demo door: in production a
  // real clearing-ledger record must never pick up a demo CBT/CVT pill
  // through a title match — the honest null state renders instead
  // (beta-readiness purge, 2026-10-01).
  const demoAssetByTitle = new Map(
    (isDemoDoorOpen() ? MASTER_DEMO_ASSET_REGISTRY : []).map((asset) => [asset.title, asset]),
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
      cvt: asset ? demoCvtCode(asset.cbt) : null,
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

/**
 * The vault records' stored-CVT join — the Contracts section's rows carry the
 * asset's stored outward handle (`cbt_assets.cvt_code`) resolved through the
 * ONE fail-closed resolver. A contract whose asset has no stored handle renders
 * no CVT — never a client-side derivation from the CBT body (data-identity
 * audit P1 #2: one asset, one outward handle).
 */
export function attachContractCvt(
  contracts: SectionData<ContractRow[]>,
  assets: ListAssetsResult,
): SectionData<ContractRow[]> {
  if (contracts.kind !== 'ready') return contracts;
  // The join's base layer: behind the demo door, the demo master-store's
  // contracts reference the demo registry's CBTs — whose deterministic
  // engine-shape handles (demoCvtCode, the seed's stored values) are the
  // demo rows' handles of record. Real asset rows overlay and win on any
  // code collision; the layer is empty in production (the door is closed),
  // so a real deployment path carries zero demo entries — beta-readiness
  // purge, 2026-10-01.
  const demoLayer = isDemoDoorOpen()
    ? MASTER_DEMO_ASSET_REGISTRY.map((asset) => [asset.cbt, demoCvtCode(asset.cbt)] as const)
    : [];
  const cvtByCbt = new Map<string, string>([
    ...demoLayer,
    ...assets
      .map((asset) => [asset.cbtCode, storedCvtHandle(asset.cvtCode)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== null),
  ]);
  return {
    ...contracts,
    value: contracts.value.map((contract) => ({
      ...contract,
      cvt: cvtByCbt.get(contract.cbtCode) ?? null,
    })),
  };
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
  // The demo registry's joins ride ONLY behind the demo door. In production
  // this context is built for the Tax tab, the CSV export, and the
  // Operations tab, so a real deployment path must carry zero demo
  // entries: the labels/states below key on demo-only CBT codes (inert on
  // real rows), but they are fabricated data by construction — beta-readiness
  // purge, 2026-10-01. Demo mode keeps them: the demo ledger's rows can
  // only join their kinds and event states through this context.
  const demoDoor = isDemoDoorOpen();
  return buildTaxJoinContext(assets, {
    entityTypeLabels: demoDoor
      ? MASTER_DEMO_ASSET_REGISTRY.map((asset) => ({
          cbtCode: asset.cbt,
          label: asset.kind,
        }))
      : [],
    // The demo door's assets of record — their deterministic stored-shape
    // handles (demoCvtCode) join the demo ledger's tax rows. Real rows
    // overlay and win; empty in production (no demo entry rides a real
    // path — beta-readiness purge, 2026-10-01).
    cvtLabels: demoDoor
      ? MASTER_DEMO_ASSET_REGISTRY.map((asset) => ({
          cbtCode: asset.cbt,
          cvt: demoCvtCode(asset.cbt),
        }))
      : [],
    templateBindings: [
      ...(contracts.kind === 'ready'
        ? contracts.value.map((contract) => ({
            cbtCode: contract.cbtCode,
            templateId: contract.templateId,
          }))
        : []),
      // The minted lane executions exist only behind the demo door —
      // MINTED_LANE_EXECUTIONS fills exclusively through the seed.
      ...listDemoLaneExecutions().map((execution) => ({
        cbtCode: execution.cbt ?? '',
        templateId: execution.templateId,
      })),
    ],
    eventStates: demoDoor
      ? MASTER_DEMO_ASSET_REGISTRY.flatMap((asset) => {
          const state = stateFromGoverningLaw(asset.agreement.governingLaw);
          return state ? [{ cbtCode: asset.cbt, state }] : [];
        })
      : [],
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

