/**
 * Admin demo seeds — the demo door's data for the settlement and contract
 * stores (founder directive, 2026-09-20: the /admin Ledger section is the
 * FINANCES surface and the Contracts section is the REGISTRY; neither may
 * render empty in the disclosed demo preview).
 *
 * The seed runs ONLY when the demo door is open — dev seed mode with no
 * service-role client (memory mode). Real sessions with Supabase configured
 * read their own stored rows and are never touched. Every seeded row is
 * produced through the REAL paths the app reads: settlements through the
 * vendored engine's processRoyaltySettlement (the same engine settleDirectAction
 * uses — corner dust comes out of its integer-cent path, never a literal),
 * contracts through saveContract/markContractFinal (the vault's own state
 * machine), and the lane execution through mintExecutionLane (the POST path
 * the /api/v1/contracts/execute door runs).
 */

import { CovenantMasterSDK, type CovenantBlockAsset, type MediaMedium, type SelfServeRightsHolder, type SettlementResult, type SettlementCurrency, type UniversalAssetIdentifier } from '@/engine/covenant-master-sdk';
import { PLATFORM_FEE_PERCENTAGE } from '@/lib/sdk';
import { isDevSeedMode } from '@/lib/server/devSeed';
import { supabaseFromEnv } from '@/lib/supabase';
import { listLedger, rememberSettlement } from '@/lib/ledger/store';
import { listContracts, markContractFinal, saveContract } from '@/lib/contracts/store';
import { hydrateContext } from '@/lib/contracts/generator';
import { cvtDisplayCode } from '@/lib/splits/codes';
import type { ExecutionStampRow } from '@/components/admin/types';
import {
  MASTER_DEMO_ASSET_REGISTRY,
  UCT_DEMO_IDENTITIES,
  resolveMasterLedger,
  type LanePoolPartySeed,
  type MasterDemoAsset,
} from '@/lib/master/masterStore';
import { mintExecutionLane } from '@/lib/master/executionLane';

/** The demo door: dev-seed preview running on the in-memory stores (no service-role client — supabaseFromEnv yields undefined when unconfigured). */
function demoDoorOpen(): boolean {
  return isDevSeedMode() && supabaseFromEnv() === undefined;
}

/** The demo flag the console sections disclose — true exactly when the door is open. */
export function isDemoDoorOpen(): boolean {
  return demoDoorOpen();
}

/** Demo asset kind → engine medium. An unmapped registry kind throws — the seed list and the registry must stay in sync. */
function mediumForKind(kind: string): MediaMedium {
  switch (kind) {
    case 'Music Track':
      return 'MUSIC_TRACK';
    case 'Feature Film':
      return 'FEATURE_FILM';
    case 'Live Event':
      return 'LIVE_EVENT';
    case 'Print Book':
      return 'PRINT_BOOK';
    case 'Game Asset Bundle':
      return 'VIDEO_GAME';
    case 'Garment Line':
      return 'GARMENT_LINE';
    default:
      // A registry kind the settlement engine cannot register is a seed
      // bug — fail the seed loudly, never a silent skip that would leave
      // the settlement path with an unhydrated asset.
      throw new Error(`demo-seed: no MediaMedium maps the registry kind "${kind}"`);
  }
}

/** Pool of record → engine rights-holder role (the engine's closed role enum). */
function roleForPool(pool: LanePoolPartySeed['pool']): SelfServeRightsHolder['role'] {
  switch (pool) {
    case 'OWNERSHIP_RESERVE':
      return 'STUDIO';
    case 'CREATIVE_PAYOUT':
      return 'COMPOSER';
    case 'OPERATIONS_YIELD':
      return 'PRODUCER';
  }
}

/**
 * The pool roster's 50/35/15 BPS weights as the engine's split percentages —
 * the same canon split the master ledger records carry, so a demo settlement
 * and its clearing row tell one story.
 */
const POOL_SPLIT_PERCENT: Record<LanePoolPartySeed['pool'], number> = {
  OWNERSHIP_RESERVE: 50,
  CREATIVE_PAYOUT: 35,
  OPERATIONS_YIELD: 15,
};

/** Which roster party gets which engine tax profile — variety comes from the engine, not literals: the operations party's verification is still pending, so its 24% backup withholding is the engine's own rate. */
function taxProfileForPool(pool: LanePoolPartySeed['pool']): SelfServeRightsHolder['taxProfile'] {
  if (pool === 'OPERATIONS_YIELD') {
    return {
      taxFormType: 'W9_US_PERSON',
      taxIdentifierEncrypted: 'demo-encrypted-tin',
      usTaxResident: true,
      isBackupWithholdingRequired: true,
      isVerified: false,
    };
  }
  return {
    taxFormType: 'W9_US_PERSON',
    taxIdentifierEncrypted: 'demo-encrypted-tin',
    usTaxResident: true,
    isBackupWithholdingRequired: false,
    isVerified: true,
  };
}

/** Demo payout rail per pool — the sandbox ACH rail the withdrawal routes use. */
function payoutRoutingFor(name: string, pool: LanePoolPartySeed['pool']): SelfServeRightsHolder['payoutRouting'] {
  const railByPool: Record<LanePoolPartySeed['pool'], string> = {
    OWNERSHIP_RESERVE: 'WIRE',
    CREATIVE_PAYOUT: 'ACH',
    OPERATIONS_YIELD: 'ACH',
  };
  return {
    accountHolderName: name,
    bankName: 'Covnant Clearing Bank',
    accountNumberOrIBAN: 'DEMO-ROUTING-0001',
    routingOrBIC: 'DEMOUS33',
    currency: 'USD',
    countryCode: 'US',
    planetaryJurisdiction: 'EARTH',
    railType: railByPool[pool],
  };
}

function rightsHoldersFor(asset: MasterDemoAsset): SelfServeRightsHolder[] {
  // Pool-internal units set each party's share WITHIN its canon pool — the
  // pool's parties together carry exactly the pool's 50/35/15 weight (the
  // reconciliation the execution lane runs). Assigning the full pool
  // percentage per party over-disburses the settlement (payee shares beyond
  // the gross, the fee pushed negative) — money no tax sheet may report.
  const unitsByPool = new Map<LanePoolPartySeed['pool'], number>();
  for (const party of asset.poolRoster) {
    unitsByPool.set(party.pool, (unitsByPool.get(party.pool) ?? 0) + party.poolUnits);
  }
  return asset.poolRoster.map((party, index) => {
    const identity = UCT_DEMO_IDENTITIES[party.identityKey];
    const name = identity?.name ?? party.role;
    const poolUnits = unitsByPool.get(party.pool) ?? 0;
    return {
      id: `${party.identityKey}-demo-${index}`,
      name,
      role: roleForPool(party.pool),
      splitPercentage: (party.poolUnits / poolUnits) * POOL_SPLIT_PERCENT[party.pool],
      taxProfile: taxProfileForPool(party.pool),
      payoutRouting: payoutRoutingFor(name, party.pool),
      confirmedByArtist: true,
    };
  });
}

/** The lane's work identifiers mapped onto the engine's identifier slots — known registry codes take their slot, everything else rides the guid fallback. */
function mappedIdentifiersFor(asset: MasterDemoAsset): UniversalAssetIdentifier {
  const mapped: UniversalAssetIdentifier = {};
  for (const identifier of asset.workIdentifiers) {
    switch (identifier.label) {
      case 'ISRC':
        mapped.isrc = identifier.value;
        break;
      case 'ISAN':
        mapped.isanHex = identifier.value;
        break;
      case 'ISBN':
        mapped.isbn = identifier.value;
        break;
      default:
        mapped.guid = identifier.value;
    }
  }
  return mapped;
}

/**
 * Register one canonical demo asset on an SDK instance (idempotent per CBT).
 * PRIVATE instances only: the shared singleton and the global asset index are
 * the app's live data paths — the e2e asset-studio flow registers its own
 * asset of record and must start from the index it finds, never demo state.
 */
function registerDemoAsset(sdk: CovenantMasterSDK, asset: MasterDemoAsset): CovenantBlockAsset {
  const medium = mediumForKind(asset.kind);
  const block: CovenantBlockAsset = {
    cvtCode: cvtDisplayCode(asset.cbt),
    cbtCode: asset.cbt,
    title: asset.title,
    medium,
    mappedIdentifiers: mappedIdentifiersFor(asset),
    rightsHolders: rightsHoldersFor(asset),
    createdTimestamp: DEMO_SEED_INSTANT,
  };
  sdk.registerInMemory(block);
  return block;
}

/** Fixed instant for the demo records — deterministic across boots. */
const DEMO_SEED_INSTANT = Date.parse('2026-09-20T00:00:00.000Z');

/** Deterministic demo transaction ids (idempotent replays re-derive the row). */
function demoTransactionId(sequence: number): string {
  return `DIR-DEMO-${String(sequence).padStart(4, '0')}`;
}

interface DemoSettlement {
  readonly cbt: string;
  readonly grossAmount: number;
  readonly currency: SettlementCurrency;
  readonly platform: string;
}

/**
 * The demo settlement script — odd minor units on both fee paths so the
 * engine's integer-cent dust sweep produces a nonzero corner dust on every
 * row (DIRECT settles on the app's 0% singleton; the social platforms settle
 * on the 10% claims-path fee). Every demo asset settles at least once, so
 * every UCT identity in the master store carries cleared transactions — the
 * tax surfaces report EVERY creator, never a curated subset.
 */
const DEMO_SETTLEMENTS: readonly DemoSettlement[] = [
  { cbt: 'CBT-TRK-A51DF05B4279', grossAmount: 12500.3337, currency: 'USD', platform: 'DIRECT' },
  { cbt: 'CBT-TRK-A51DF05B4279', grossAmount: 4380.9013, currency: 'USD', platform: 'DIRECT' },
  { cbt: 'CBT-TRK-A51DF05B4279', grossAmount: 2300.7777, currency: 'USD', platform: 'SPOTIFY' },
  { cbt: 'CBT-FLM-7C3A91D2E40B', grossAmount: 98760.5432, currency: 'USD', platform: 'YOUTUBE_CONTENT_ID' },
  { cbt: 'CBT-LVE-5D2E8A4B91C7', grossAmount: 7712.6149, currency: 'USD', platform: 'DIRECT' },
  { cbt: 'CBT-GAM-8B4D0C6E2F1A', grossAmount: 51240.8173, currency: 'USD', platform: 'DIRECT' },
  { cbt: 'CBT-FSH-3F7A1B9D5E2C', grossAmount: 9085.2217, currency: 'USD', platform: 'DIRECT' },
  { cbt: 'CBT-BOK-2E6B4F08A3D9', grossAmount: 4470.3591, currency: 'USD', platform: 'DIRECT' },
];

/** The direct-path engine instance — the same 0% fee as the app singleton, private to the demo door. */
const DEMO_DIRECT_SDK = new CovenantMasterSDK(PLATFORM_FEE_PERCENTAGE);

/** The 10% social-fee engine instance — the claims webhook's fee path (the engine takes a percent: 10.00, the claims path's own convention). */
const SOCIAL_FEE_SDK = new CovenantMasterSDK(10.00);

async function settleDemoRow(
  settlement: DemoSettlement,
  sequence: number,
): Promise<SettlementResult> {
  const sdk = settlement.platform === 'DIRECT' ? DEMO_DIRECT_SDK : SOCIAL_FEE_SDK;
  const result = await sdk.processRoyaltySettlement({
    transactionId: demoTransactionId(sequence),
    cbtCode: settlement.cbt,
    grossAmount: settlement.grossAmount,
    currency: settlement.currency,
    sourcePlatform: settlement.platform,
    territoryCountryCode: 'US',
    timestamp: DEMO_SEED_INSTANT,
  });
  if (result.reconciliationStatus !== 'PASS') {
    throw new Error(`demo seed: settlement ${demoTransactionId(sequence)} failed reconciliation (${result.reconciliationStatus})`);
  }
  await rememberSettlement(result, settlement.platform);
  return result;
}

/**
 * Seed the demo settlements when the ledger store is empty. Idempotent: a
 * store that already carries rows (seeded or real) is never re-seeded.
 */
export async function seedDemoSettlementsIfEmpty(): Promise<void> {
  if (!demoDoorOpen()) return;
  const rows = await listLedger();
  if (rows.length > 0) return;

  for (const asset of MASTER_DEMO_ASSET_REGISTRY) {
    registerDemoAsset(DEMO_DIRECT_SDK, asset);
    registerDemoAsset(SOCIAL_FEE_SDK, asset);
  }
  for (const [index, settlement] of DEMO_SETTLEMENTS.entries()) {
    await settleDemoRow(settlement, index + 1);
  }
  console.error('demo-seed: universal royalty ledger seeded through the settlement engine (demo door).');
}

/** The demo vault contracts — real template ids, saved through the vault's own paths. */
const DEMO_CONTRACTS: readonly { cbt: string; templateId: string; industry: 'MUSIC' | 'FILM_MEDIA_MERCH'; finalize: boolean }[] = [
  { cbt: 'CBT-TRK-A51DF05B4279', templateId: 'MUSIC_SPLIT_SHEET', industry: 'MUSIC', finalize: true },
  { cbt: 'CBT-TRK-A51DF05B4279', templateId: 'MUSIC_SYNC_LICENSE', industry: 'MUSIC', finalize: false },
  { cbt: 'CBT-FLM-7C3A91D2E40B', templateId: 'FILM_SCREENPLAY_OPTION', industry: 'FILM_MEDIA_MERCH', finalize: false },
];

/**
 * Seed the demo contract vault when it is empty — drafts and one finalized
 * agreement through saveContract/markContractFinal, so the registry's
 * signature states are the vault's own state machine output.
 */
export async function seedDemoContractsIfEmpty(): Promise<void> {
  if (!demoDoorOpen()) return;
  const contracts = await listContracts();
  if (contracts.length > 0) return;

  const registryByCbt = new Map(MASTER_DEMO_ASSET_REGISTRY.map((asset) => [asset.cbt, asset]));
  for (const demo of DEMO_CONTRACTS) {
    const seedAsset = registryByCbt.get(demo.cbt);
    if (seedAsset === undefined) continue;
    const block = registerDemoAsset(DEMO_DIRECT_SDK, seedAsset);
    if (block === null) continue;
    // The vault context hydrates from the asset's engine block; the fee of
    // record is the lane agreement's own store value — never a derived guess.
    const context = hydrateContext(block, {
      effectiveDate: seedAsset.agreement.effectiveDate,
      fee: `${(seedAsset.agreement.feeCents / 100).toFixed(2)} USD, the lane agreement's fee of record`,
    });
    const saved = await saveContract({
      cbtCode: block.cbtCode,
      templateId: demo.templateId,
      industry: demo.industry,
      context,
    });
    if (demo.finalize) await markContractFinal(saved.id);
  }
  console.error('demo-seed: contract vault seeded through the vault paths (demo door).');
}

/**
 * The lane's demo execution binding — the live-escrow pair (sector-matched
 * template and asset). Deliberately NOT the audio canonical asset: the
 * asset-studio e2e registers that title through the UI and asserts the
 * registered-asset count on /assets, where the master clearing ledger (with
 * this mint's landing record) also renders.
 */
const DEMO_LANE_BINDING = { templateKey: 'TPL-LVE-009', cbt: 'CBT-LVE-5D2E8A4B91C7' } as const;

/** The binding asset's title — the mint's fingerprint in the clearing ledger. */
const DEMO_LANE_ASSET_TITLE =
  MASTER_DEMO_ASSET_REGISTRY.find((asset) => asset.cbt === DEMO_LANE_BINDING.cbt)?.title ?? null;

/**
 * The lane executions this process minted — the CBT-EXEC stamp, template,
 * and lineage of record, exactly as the POST path returned them. Lives and
 * dies with the process, same as the seeded ledger landing it mirrors.
 */
const MINTED_LANE_EXECUTIONS: ExecutionStampRow[] = [];

/** The demo lane executions of record (empty outside the demo door). */
export function listDemoLaneExecutions(): ExecutionStampRow[] {
  return MINTED_LANE_EXECUTIONS;
}

/**
 * Execute the demo lane binding through the REAL POST path when no lane
 * execution has landed yet — the CBT-EXEC stamp, the EXECUTED signatures,
 * and the master clearing ledger landing are the store's own outputs.
 */
export async function seedDemoLaneExecutionIfMissing(): Promise<void> {
  if (!demoDoorOpen()) return;
  if (DEMO_LANE_ASSET_TITLE === null) {
    throw new Error('demo seed: the lane binding CBT is not in the demo asset registry');
  }
  const { records } = await resolveMasterLedger();
  // Idempotence fingerprint: the mint lands THIS asset's title as
  // PENDING_CLEARANCE. The seeded library's rotation carries other titles'
  // pending records — those are canon state, not a previous demo mint.
  if (
    records.some(
      (record) =>
        record.clearinghouseStatus === 'PENDING_CLEARANCE' &&
        record.assetTitle === DEMO_LANE_ASSET_TITLE,
    )
  ) {
    return;
  }
  const minted = mintExecutionLane(DEMO_LANE_BINDING, new Date(DEMO_SEED_INSTANT).toISOString());
  if (!minted.ok) {
    throw new Error(`demo seed: lane execution failed (${minted.reason})`);
  }
  const execution = minted.lane.execution;
  if (execution === null) {
    throw new Error('demo seed: lane mint returned no execution stamp');
  }
  MINTED_LANE_EXECUTIONS.push({
    executionId: execution.executionId,
    stampedAt: execution.stampedAt,
    ledgerId: execution.ledgerId,
    assetTitle: minted.ledgerRecord.assetTitle,
    cbt: DEMO_LANE_BINDING.cbt,
    cvt: cvtDisplayCode(DEMO_LANE_BINDING.cbt),
    templateId: minted.lane.template.templateId,
    sector: minted.ledgerRecord.subcategory,
  });
  console.error(`demo-seed: lane execution ${execution.executionId} landed in the master clearing ledger (demo door).`);
}

/** One boot call for the /admin and /ledger server seams. */
export async function seedAdminDemoDataIfEmpty(): Promise<void> {
  await seedDemoSettlementsIfEmpty();
  await seedDemoContractsIfEmpty();
  await seedDemoLaneExecutionIfMissing();
}
