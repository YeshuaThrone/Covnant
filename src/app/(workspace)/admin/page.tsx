/**
 * /admin — the gated operator console.
 *
 * Three honest views, chosen server-side before anything renders
 * (adminPageView over the gate verdict):
 *   - 'unavailable' — ADMIN_DASHBOARD_PASSWORD is unset; the console
 *     cannot be enabled and says so plainly (no form, no lie).
 *   - 'login' — the AdminGate: the only thing an unauthenticated visitor
 *     can see. No hints about what lies behind.
 *   - 'console' — AdminConsole with server-side reads over the verified
 *     stores: registry (provisioning status ONLY), ledger, contracts,
 *     creator profiles, platform allowlists, the master ledger, and the
 *     entity-bound Covnant Control Board library. Supabase-backed stores
 *     degrade to their honest unavailable state when the service-role
 *     client cannot be built.
 *
 * The gate never touches middleware — this page (and every /api/admin
 * route) verifies the signed session itself, per the PR F contract.
 */

import { cookies } from 'next/headers';
import { listAssets } from '@/lib/sdk';
import { listLedger } from '@/lib/ledger/store';
import { isDemoDoorOpen, seedAdminDemoDataIfEmpty } from '@/lib/admin/demoSeeds';
import { buildContractRegistrySection, buildLedgerFinancesSection, buildTaxSection } from '@/lib/admin/sectionPayloads';
import { listContracts, type StoredContract } from '@/lib/contracts/store';
import { listCreators } from '@/lib/admin/creators';
import { listAllowlists } from '@/lib/admin/allowlists';
import { supabaseFromEnv } from '@/lib/supabase';
import type { AdminStoreResult } from '@/lib/admin/types';
import { registrySummary, ledgerSummary } from '@/lib/admin/overview';
import { ADMIN_COOKIE_NAME, verifyAdminSession } from '@/lib/admin/gate';
import { adminPageView } from '@/lib/admin/console';
import {
  atomicRecordsForCategory,
  bindAtomicEntity,
  bindFactoryEntity,
  executionTelemetryFor,
  masterTemplatesForCategory,
  resolveAtomicRegistry,
  resolveMasterLedger,
  resolveMasterTemplates,
} from '@/lib/master/masterStore';
import { MASTER_CATEGORY_ORDER } from '@/lib/master/taxonomy';
import type { ControlBoardState } from '@/lib/master/controlBoard';
import type {
  AtomicContractRecord,
  ContractTemplateRecord,
} from '@/lib/master/masterStore';
import { summarizeSovereignLedger } from '@/lib/master/sovereignLedger';
import { platformRevenueStreams } from '@/lib/admin/revenueStreams';
import { companyAnalytics } from '@/lib/admin/companyAnalytics';
import { creatorAnalytics } from '@/lib/admin/creatorAnalytics';
import { entityIntelligence, type EntityIntelligence } from '@/lib/admin/entityIntelligence';
import { isDevSeedMode, getSeededStore } from '@/lib/server/devSeed';
import { getStore, type Store } from '@/lib/server/store';
import { AdminGate } from '@/components/admin/AdminGate';
import { AdminConsole } from '@/components/admin/AdminConsole';
import type { AdminConsoleData, ContractRow, SectionData } from '@/components/admin/types';

export const dynamic = 'force-dynamic';

const NOT_CONFIGURED_NOTICE =
  'The admin console is not configured. Set the ADMIN_DASHBOARD_PASSWORD environment variable to enable operator access.';

/** StoredContract → the console's read-only row (record metadata, never the document). */
function contractRows(contracts: StoredContract[]): ContractRow[] {
  return contracts.map((contract) => ({
    id: contract.id,
    cbtCode: contract.cbtCode,
    templateId: contract.templateId,
    industry: contract.industry,
    status: contract.status,
    createdAt: new Date(contract.createdAt).toISOString(),
    updatedAt: new Date(contract.updatedAt).toISOString(),
  }));
}

/** Store result → the section's honest data union (null = no service-role client). */
function toSectionData<T>(result: AdminStoreResult<T> | null): SectionData<T> {
  if (!result) {
    return {
      kind: 'unavailable',
      code: 'supabase_not_configured',
      message: 'Supabase credentials are not configured.',
    };
  }
  return result.ok
    ? { kind: 'ready', value: result.value }
    : { kind: 'unavailable', code: result.code, message: result.message };
}

/**
 * The Control Board's server seam — the same composition the /templates
 * page and the per-sector entity doors run over the master store: every
 * factory template and atomic record of the seven verticals, entity-bound
 * with its CovnantAtomicDataSDK telemetry and execution history before
 * anything renders. No literals — the board is the store's library.
 */
function buildControlBoardState(
  masterTemplates: { demo: boolean; records: readonly ContractTemplateRecord[] },
  atomicRegistry: { records: readonly AtomicContractRecord[] },
): ControlBoardState {
  return {
    demo: masterTemplates.demo,
    active: null,
    verticals: [...MASTER_CATEGORY_ORDER].map((vertical) => ({
      vertical,
      factoryTemplates: masterTemplatesForCategory(masterTemplates.records, vertical).map(
        (record) => ({
          record,
          entity: bindFactoryEntity(record),
          execution: executionTelemetryFor(record.templateId),
        }),
      ),
      atomicRecords: atomicRecordsForCategory(atomicRegistry.records, vertical).map((record) => ({
        record,
        entity: bindAtomicEntity(record),
        execution: executionTelemetryFor(record.templateId),
      })),
    })),
  };
}

/**
 * listContracts throws on a store read failure (its documented contract) —
 * one failing store must never take the whole console down, so the read
 * is caught here and degraded to the section's honest unavailable state.
 */
function safeContractsRead(): Promise<AdminStoreResult<ContractRow[]>> {
  return listContracts()
    .then(
      (rows): AdminStoreResult<ContractRow[]> => ({
        ok: true,
        value: contractRows(rows),
      }),
    )
    .catch(
      (): AdminStoreResult<ContractRow[]> => ({
        ok: false,
        status: 502,
        code: 'contract_store_failed',
        message: 'Contract store read failed.',
      }),
    );
}

/**
 * The Overview tab's Revenue Streams strip (founder directive 2026-09-22):
 * platform-wide royalty inflow by source over the Don store — the same
 * derivation as the Gold Board's strip, widened to every payee. One failing
 * store read must never take the console down (the console's own contract),
 * so both the store resolution and the aggregation degrade to the section's
 * honest unavailable state.
 */
async function safeRevenueStreamsRead(): Promise<AdminConsoleData['revenueStreams']> {
  try {
    // The Don store door — the same environment branch dashboardLive uses:
    // dev-seed previews read the booted seeded store; production reads the
    // configured store.
    const donStore: Store = isDevSeedMode() ? await getSeededStore() : getStore();
    return { kind: 'ready', value: await platformRevenueStreams(donStore) };
  } catch {
    return {
      kind: 'unavailable',
      code: 'revenue_streams_store_failed',
      message: 'Revenue stream store read failed.',
    };
  }
}

/**
 * The Analytics tab's payload (spec art_rRYEJBpS): `companyAnalytics` for
 * EVERY registered window (7d / 30d / 90d / all) over the same Don store
 * door as the Revenue Streams read — one pass, so the section's window
 * filter picks among pre-derived windows and never re-fetches. One failing
 * store read must never take the console down: both the store resolution
 * and the derivations degrade to the section's honest unavailable state.
 */
async function safeCompanyAnalyticsRead(): Promise<AdminConsoleData['analytics']> {
  try {
    const donStore: Store = isDevSeedMode() ? await getSeededStore() : getStore();
    const [d7, d30, d90, dAll] = await Promise.all([
      companyAnalytics(donStore, '7d'),
      companyAnalytics(donStore, '30d'),
      companyAnalytics(donStore, '90d'),
      companyAnalytics(donStore, 'all'),
    ]);
    if (d7 === null || d30 === null || d90 === null || dAll === null) {
      return {
        kind: 'unavailable',
        code: 'analytics_store_failed',
        message: 'Analytics store read failed.',
      };
    }
    return { kind: 'ready', value: { '7d': d7, '30d': d30, '90d': d90, all: dAll } };
  } catch {
    return {
      kind: 'unavailable',
      code: 'analytics_store_failed',
      message: 'Analytics store read failed.',
    };
  }
}

/**
 * The Intelligence tab's payload (2026-09-22 founder directive: "we need
 * real analytics like the NFL would have on their players"): every
 * registered atomic entity read through the entityIntelligence derivation
 * over the same Don store door as the Analytics read — the four reads per
 * entity. The roster is the FULL registered universe, from both template
 * registries: the atomic registry's sector-bound records (bindAtomicEntity)
 * and the factory templates that bind an entity class (bindFactoryEntity),
 * deduplicated by template id. One failing store read must never take the
 * console down: both the store resolution and the per-entity fan-out
 * degrade to the section's honest unavailable state.
 */
async function safeIntelligenceRead(): Promise<AdminConsoleData['intelligence']> {
  try {
    const donStore: Store = isDevSeedMode() ? await getSeededStore() : getStore();
    const [{ records: atomicRecords }, { records: factoryRecords }] = await Promise.all([
      resolveAtomicRegistry(),
      resolveMasterTemplates(),
    ]);
    const identities = new Set<string>();
    const readouts: EntityIntelligence[] = [];
    const addEntity = async (templateId: string) => {
      if (identities.has(templateId)) return;
      identities.add(templateId);
      const readout = await entityIntelligence(templateId, donStore);
      if (readout !== null) readouts.push(readout);
    };
    // Both registries, each through its own typed binding — the atomic
    // sector-bound records and the factory templates that bind a class.
    for (const record of atomicRecords) {
      const entity = bindAtomicEntity(record);
      if (entity !== null) await addEntity(entity.templateId);
    }
    for (const record of factoryRecords) {
      const entity = bindFactoryEntity(record);
      if (entity !== null) await addEntity(entity.templateId);
    }
    return { kind: 'ready', value: readouts };
  } catch {
    return {
      kind: 'unavailable',
      code: 'intelligence_store_failed',
      message: 'Intelligence store read failed.',
    };
  }
}

/**
 * The Creator Analytics tab's payload (spec art_UccVWZpj): the creator-side
 * derivation for EVERY registered window (7 / 30 / 90 / all — the module's
 * own `CreatorWindowDays`, `null` for ALL) over the same Don store door as
 * the Analytics and Intelligence reads — one pass, so the tab's window
 * filter picks among pre-derived windows and never re-fetches. One failing
 * store read must never take the console down: both the store resolution
 * and the derivations degrade to the section's honest unavailable state
 * (the derivation itself degrades to null on a failed scan — same code).
 */
async function safeCreatorAnalyticsRead(): Promise<AdminConsoleData['creatorAnalytics']> {
  try {
    const donStore: Store = isDevSeedMode() ? await getSeededStore() : getStore();
    const [d7, d30, d90, dAll] = await Promise.all([
      creatorAnalytics(donStore, 7),
      creatorAnalytics(donStore, 30),
      creatorAnalytics(donStore, 90),
      creatorAnalytics(donStore, null),
    ]);
    if (d7 === null || d30 === null || d90 === null || dAll === null) {
      return {
        kind: 'unavailable',
        code: 'creator_analytics_store_failed',
        message: 'Creator analytics store read failed.',
      };
    }
    return { kind: 'ready', value: { '7d': d7, '30d': d30, '90d': d90, all: dAll } };
  } catch {
    return {
      kind: 'unavailable',
      code: 'creator_analytics_store_failed',
      message: 'Creator analytics store read failed.',
    };
  }
}

export default async function AdminPage() {
  const token = (await cookies()).get(ADMIN_COOKIE_NAME)?.value ?? null;
  const view = adminPageView(verifyAdminSession(token));

  if (view === 'unavailable') {
    return <AdminGate notice={NOT_CONFIGURED_NOTICE} />;
  }
  if (view === 'login') {
    return <AdminGate />;
  }

  // The demo door — dev-seed previews hydrate settlements, the vault, and the
  // lane execution through the real engine paths before the reads (idempotent;
  // Supabase-backed stores are never touched).
  await seedAdminDemoDataIfEmpty();

  const db = supabaseFromEnv();
  const [ledgerRows, assets, contracts, creators, allowlists, master, masterTemplates, atomicRegistry, revenueStreams, analytics, intelligence, creatorAnalyticsFlows] = await Promise.all([
    listLedger(),
    listAssets(),
    safeContractsRead(),
    db ? listCreators(db) : Promise.resolve(null),
    db ? listAllowlists(db) : Promise.resolve(null),
    resolveMasterLedger().then(
      (resolved): AdminConsoleData['master'] => ({
        kind: 'ready',
        value: {
          demo: resolved.demo,
          summary: summarizeSovereignLedger(resolved.records),
          records: [...resolved.records],
        },
      }),
    ),
    resolveMasterTemplates(),
    resolveAtomicRegistry(),
    safeRevenueStreamsRead(),
    safeCompanyAnalyticsRead(),
    safeIntelligenceRead(),
    safeCreatorAnalyticsRead(),
  ]);

  const data: AdminConsoleData = {
    registry: registrySummary(assets),
    ledger: ledgerSummary(ledgerRows),
    contracts: toSectionData(contracts),
    creators: toSectionData(creators),
    creatorsDemo: isDemoDoorOpen(),
    allowlists: toSectionData(allowlists),
    master,
    controlBoard: buildControlBoardState(masterTemplates, atomicRegistry),
    finances: buildLedgerFinancesSection(ledgerRows, assets),
    contractRegistry: buildContractRegistrySection(
      masterTemplates,
      master.kind === 'ready' ? master.value.records : [],
    ),
    tax: buildTaxSection(ledgerRows, assets, toSectionData(contracts)),
    revenueStreams,
    analytics,
    analyticsDemo: isDemoDoorOpen(),
    intelligence,
    intelligenceDemo: isDemoDoorOpen(),
    creatorAnalytics: creatorAnalyticsFlows,
    creatorAnalyticsDemo: isDemoDoorOpen(),
  };

  return <AdminConsole data={data} />;
}
