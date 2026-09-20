/**
 * THE UNIVERSAL EXECUTION LANE — the ONE payload hydrator (founder GO,
 * 2026-09-20: 'I like this, there is just way more then 6 verticals. Do this
 * but anything with 6 verticals expand this is for EVERY vertical of
 * entertainment. GO').
 *
 * `resolveExecutionLane({ templateKey, cbt })` returns ONE typed payload for
 * the /contracts/new execution surface — template record (resolved from
 * EITHER library, with a production-key alias map), asset of record (demo
 * registry keyed by CBT), UCT party identities AUTO-FILLED from the master
 * store (ISNI/IPI populated — never 'To be completed'), participant BPS
 * pools reconciled to EXACTLY 10,000 under the 50/35/15 canon (integer math,
 * dust to the operations yield per the Don dust canon), structured guard
 * verdicts, entity telemetry (the six isolated classes render full domain
 * fields; every other sector renders its telemetryMetric canon), CBT/CVT
 * lineage, agreement fields, signature state, and display-only
 * auditor-reconciled payout flows.
 *
 * This module is a SERVER module: it touches the master store, the
 * allocation engine, and node:crypto — never imported from client
 * components.
 */
import { createHash } from 'node:crypto';

import { formatUsdAmount } from '@/lib/money/format';
import { isDevSeedMode } from '@/lib/server/devSeed';
import { allocateWithCompanyDustSweep } from '@/modules/don/dust';
import type { PayeeRole, SplitPartyInput } from '@/lib/don/types';
import { cvtDisplayCode } from '@/lib/splits/codes';
import {
  ATOMIC_SECTOR_GUARDS,
  FACTORY_VERTICAL_GUARDS,
  LANE_POOL_BPS,
  LANE_POOL_LABELS,
  LANE_POOL_ORDER,
  LANE_TOTAL_BPS,
  entityClassTag,
  evaluateCrossDomainBinding,
  evaluateGuardBinding,
  type AtomicEntityClassTag,
  type GuardVerdict,
  type LanePoolName,
  type SovereignAtomicEntity,
} from './CovnantAtomicDataSDK';
import {
  ATOMIC_TEMPLATE_REGISTRY,
  MASTER_TEMPLATE_LIBRARY,
  TEMPLATE_VERTICAL_TO_MASTER,
  UCT_DEMO_IDENTITIES,
  bindAtomicEntity,
  bindFactoryEntity,
  demoAssetForCbt,
  recordExecutionInMasterLedger,
  validateServedEntity,
  type AtomicContractRecord,
  type ContractTemplateRecord,
  type LanePoolPartySeed,
  type MasterDemoAsset,
} from './masterStore';
import { ATOMIC_SECTOR_ORDER, ATOMIC_SECTOR_TO_VERTICAL, MASTER_CATEGORY_LABELS, type GlobalEntertainmentCategory } from './taxonomy';
import type { SovereignLedgerRecord } from './sovereignLedger';

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE RESOLUTION — either library, plus the production-key alias map.
// The aliases map legacy/production-style SCREAMING_SNAKE keys (the keys the
// founder's production URL uses, e.g. FASHION_RUNWAY_TALENT_RELEASE) onto
// their master registry records. Founder-owned: new aliases land only on the
// founder's direction.
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATE_KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  FASHION_RUNWAY_TALENT_RELEASE: 'TPL-FSH-001',
});

/** One resolved template — a discriminated union, exactly one record held. */
export type LaneTemplateResolution =
  | { readonly library: 'atomic'; readonly atomicRecord: AtomicContractRecord; readonly requestedKey: string; readonly aliasResolved: boolean }
  | { readonly library: 'factory'; readonly factoryRecord: ContractTemplateRecord; readonly requestedKey: string; readonly aliasResolved: boolean };

/**
 * Resolve a template key against EITHER library, honoring the alias map.
 * Returns null for unknown keys — the route maps that to fail-closed 404
 * (no invented records).
 */
export function resolveLaneTemplate(templateKey: string): LaneTemplateResolution | null {
  const normalized = templateKey.toUpperCase();
  const canonical = TEMPLATE_KEY_ALIASES[normalized] ?? normalized;
  const aliasResolved = canonical !== normalized;
  const atomicRecord = ATOMIC_TEMPLATE_REGISTRY.find((record) => record.templateId === canonical);
  if (atomicRecord) {
    return { library: 'atomic', atomicRecord, requestedKey: templateKey, aliasResolved };
  }
  const factoryRecord = MASTER_TEMPLATE_LIBRARY.find((record) => record.templateId === canonical);
  if (factoryRecord) {
    return { library: 'factory', factoryRecord, requestedKey: templateKey, aliasResolved };
  }
  return null;
}

/** Prettified sector name for display ('SOCIAL_MEDIA' → 'Social Media'). */
function prettySectorName(sector: string): string {
  return sector
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// POOL RECONCILIATION — the 50/35/15 canon as integer BPS of the whole
// 10,000. Pool-internal units convert to BPS with integer floor division;
// every pool's rounding dust sweeps to the operations yield (the Don dust
// canon). The grand total is asserted to EXACTLY 10,000 — a payload that
// cannot balance is a programming error and throws, never a silent drift.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconciledPoolParty {
  readonly identityKey: string;
  readonly uctId: string;
  readonly name: string;
  readonly role: string;
  readonly pool: LanePoolName;
  /** Whole-10,000 BPS after integer reconciliation (dust swept to operations). */
  readonly poolShareBps: number;
}

export interface ReconciledPool {
  readonly pool: LanePoolName;
  readonly label: string;
  readonly weightBps: number;
  /** Rounding dust this pool gave up (swept to the operations yield). */
  readonly dustBps: number;
  /** Sum of party shares AFTER the dust sweep (operations may exceed its weight). */
  readonly totalBps: number;
  readonly parties: readonly ReconciledPoolParty[];
}

export interface ReconciledPools {
  readonly pools: readonly ReconciledPool[];
  /** Total rounding dust swept to the operations yield. */
  readonly dustBps: number;
  /** Always EXACTLY 10,000 (asserted). */
  readonly totalBps: number;
}

/**
 * Reconcile a roster into the three canon pools with integer BPS math.
 * Deterministic: same roster in, same shares out — no floating point.
 */
export function reconcileParticipantPools(roster: readonly LanePoolPartySeed[]): ReconciledPools {
  const computed = LANE_POOL_ORDER.map((pool) => {
    const seedParties = roster.filter((party) => party.pool === pool);
    const unitsSum = seedParties.reduce((sum, party) => sum + party.poolUnits, 0);
    const weight = LANE_POOL_BPS[pool];
    const parties = seedParties.map((party) => {
      const identity = UCT_DEMO_IDENTITIES[party.identityKey];
      if (!identity) {
        throw new Error(`executionLane: roster references unknown identity ${party.identityKey}`);
      }
      return {
        identityKey: party.identityKey,
        uctId: identity.uctId,
        name: identity.name,
        role: party.role,
        pool,
        poolShareBps: Math.floor((party.poolUnits * weight) / unitsSum),
      };
    });
    const shareSum = parties.reduce((sum, party) => sum + party.poolShareBps, 0);
    return { pool, weight, parties, poolDustBps: weight - shareSum };
  });

  // The dust sweep: every pool's rounding dust lands on the LAST party of
  // the operations yield pool. The integrity gate guarantees every roster
  // carries an operations party — this find cannot miss.
  const operations = computed.find((entry) => entry.pool === 'OPERATIONS_YIELD');
  if (!operations || operations.parties.length === 0) {
    throw new Error('executionLane: roster carries no OPERATIONS_YIELD party (the dust recipient)');
  }
  const dustBps = computed.reduce((sum, entry) => sum + entry.poolDustBps, 0);
  if (dustBps > 0) {
    operations.parties[operations.parties.length - 1].poolShareBps += dustBps;
  }

  const pools: ReconciledPool[] = computed.map((entry) => ({
    pool: entry.pool,
    label: LANE_POOL_LABELS[entry.pool],
    weightBps: entry.weight,
    dustBps: entry.poolDustBps,
    totalBps: entry.parties.reduce((sum, party) => sum + party.poolShareBps, 0),
    parties: entry.parties,
  }));
  const totalBps = pools.reduce((sum, pool) => sum + pool.totalBps, 0);
  if (totalBps !== LANE_TOTAL_BPS) {
    throw new Error(`executionLane: reconciled pools total ${totalBps} BPS — must be exactly ${LANE_TOTAL_BPS}`);
  }
  return { pools, dustBps, totalBps };
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYLOAD SHAPES — the ONE typed payload the lane serves.
// ─────────────────────────────────────────────────────────────────────────────

export interface LaneTemplateCard {
  readonly templateId: string;
  readonly templateName: string;
  readonly library: 'factory' | 'atomic';
  /** Sector label (atomic) or master category label (factory). */
  readonly domainLabel: string;
  /** The guard-registry sector name of the template's owning registry. */
  readonly sector: string;
  readonly masterCategory: GlobalEntertainmentCategory;
  readonly governingJurisdiction: string | null;
  readonly keyClauses: readonly string[];
  readonly executionStatus: string;
  readonly timesExecuted: number;
  readonly requestedKey: string;
  readonly aliasResolved: boolean;
}

export interface LaneAssetPanel {
  readonly cbt: string;
  readonly kind: string;
  readonly title: string;
  readonly sector: string;
  readonly sectorLabel: string;
  readonly workIdentifiers: readonly { readonly label: string; readonly value: string }[];
}

export interface LanePartyIdentity {
  readonly identityKey: string;
  readonly uctId: string;
  readonly name: string;
  readonly isni: string;
  /** Music-industry parties carry an IPI; null elsewhere (never a placeholder). */
  readonly ipi: string | null;
  readonly pools: readonly LanePoolName[];
  readonly role: string;
  readonly totalShareBps: number;
}

export interface LaneField {
  readonly label: string;
  readonly value: string;
}

export type LaneTelemetry =
  | { readonly kind: 'entity'; readonly classTag: AtomicEntityClassTag; readonly fields: readonly LaneField[] }
  | { readonly kind: 'sector_metric'; readonly telemetryMetric: string };

export interface LaneAgreement {
  readonly effectiveDate: string;
  readonly territory: string;
  readonly term: string;
  readonly governingLaw: string;
  readonly feeCents: number;
}

export interface LaneSignature {
  readonly uctId: string;
  readonly name: string;
  readonly role: string;
  readonly status: 'AWAITING_SIGNATURE' | 'EXECUTED';
  readonly signedAt: string | null;
}

export interface LanePayoutFlow {
  readonly pool: LanePoolName;
  readonly poolLabel: string;
  readonly name: string;
  readonly role: string;
  readonly shareBps: number;
  readonly amountCents: number;
}

export interface LaneAuditor {
  readonly grossCents: number;
  readonly allocatedCents: number;
  readonly companyDustCents: number;
  readonly balanced: boolean;
}

export interface LaneLineage {
  readonly cbt: string;
  readonly cvt: string;
  readonly derivation: string;
}

export interface LaneExecutionStamp {
  readonly executionId: string;
  readonly stampedAt: string;
  readonly ledgerId: string;
}

export interface ExecutionLanePayload {
  readonly template: LaneTemplateCard;
  readonly asset: LaneAssetPanel;
  readonly parties: readonly LanePartyIdentity[];
  readonly pools: ReconciledPools;
  readonly telemetry: LaneTelemetry;
  readonly guardReport: readonly GuardVerdict[];
  readonly crossDomainBlocked: boolean;
  readonly agreement: LaneAgreement;
  readonly signatures: readonly LaneSignature[];
  readonly payoutFlows: readonly LanePayoutFlow[];
  readonly auditor: LaneAuditor;
  readonly lineage: LaneLineage;
  readonly execution: LaneExecutionStamp | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEMETRY FORMATTING — the six isolated classes render their full domain
// fields (from the controlBoard canon seeds through the store's binding);
// every OTHER sector renders its telemetryMetric string. Server-side only,
// through the money formatters — never client-computed, never literals.
// ─────────────────────────────────────────────────────────────────────────────

function formatEntityTelemetry(entity: SovereignAtomicEntity): LaneTelemetry {
  const classTag = entityClassTag(entity);
  switch (entity.entityType) {
    case 'MASTER_RECORDING':
      return {
        kind: 'entity',
        classTag,
        fields: [
          { label: 'ISRC Code', value: entity.isrcCode },
          { label: 'Per-Stream Micro-Royalty Rate', value: `${entity.subSecondMicroRoyaltyRate} USD per stream` },
          { label: 'PRO Telemetry Binding', value: entity.proTelemetryBinding },
        ],
      };
    case 'FEATURE_FILM':
      return {
        kind: 'entity',
        classTag,
        fields: [
          { label: 'ISAN Code', value: entity.isanCode },
          { label: 'Theatrical Gross Escrow', value: formatUsdAmount(entity.theatricalGrossEscrowUSD) },
          { label: 'Studio Overlay', value: entity.studioOverlayActive ? 'Active' : 'Inactive' },
        ],
      };
    case 'LINEAR_TV':
      return {
        kind: 'entity',
        classTag,
        fields: [
          { label: 'Nielsen Flight Minutes', value: `${entity.nielsenFlightMinutes.toLocaleString('en-US')} minutes` },
          { label: 'Ad-Insert Micro Yield', value: formatUsdAmount(entity.adInsertionMicroYieldUSD) },
          { label: 'Syndication Reversion Lock', value: entity.syndicationReversionLock ? 'Locked' : 'Open' },
        ],
      };
    case 'PODCAST_NETWORK':
      return {
        kind: 'entity',
        classTag,
        fields: [
          { label: 'Download Telemetry', value: `${entity.downloadCountTelemetry.toLocaleString('en-US')} downloads` },
          { label: 'Dynamic Ad-Insert Yield', value: formatUsdAmount(entity.dynamicAdInsertYieldUSD) },
          { label: 'Feed Isolation', value: entity.feedIsolationActive ? 'Active' : 'Inactive' },
        ],
      };
    case 'STAGE_PERFORMANCE':
      return {
        kind: 'entity',
        classTag,
        fields: [
          { label: 'Ticket Escrow Balance', value: formatUsdAmount(entity.ticketEscrowBalanceUSD) },
          { label: 'Promoter Instant Allocation', value: formatUsdAmount(entity.promoterInstantAllocationUSD) },
          { label: 'House Seat Clearance', value: entity.houseSeatClearanceLock ? 'Locked' : 'Clear' },
        ],
      };
    case 'LITERARY_WORK':
      return {
        kind: 'entity',
        classTag,
        fields: [
          { label: 'ISBN', value: entity.isbnNumber },
          { label: 'Print-on-Demand Yield', value: formatUsdAmount(entity.printOnDemandYieldUSD) },
          { label: 'Citation Telemetry', value: `${entity.citationTelemetryCount.toLocaleString('en-US')} citations` },
        ],
      };
  }
}

/**
 * The engine's payee-role vocabulary mapped onto the lane identities —
 * deterministic by identity, 'other' elsewhere.
 */
const PAYEE_ROLE_BY_IDENTITY: Readonly<Record<string, PayeeRole>> = Object.freeze({
  'identity-founder': 'creator',
  'identity-gold-hours': 'label',
  'identity-gold-hours-publishing': 'publisher',
});

function payeeRoleFor(identityKey: string): PayeeRole {
  return PAYEE_ROLE_BY_IDENTITY[identityKey] ?? 'other';
}

// ─────────────────────────────────────────────────────────────────────────────
// PAYLOAD ASSEMBLY — the ONE seam.
// ─────────────────────────────────────────────────────────────────────────────

/** Mutable assembly accumulator for identity blocks — payload shape stays frozen. */
interface MutableLaneParty {
  readonly identityKey: string;
  readonly uctId: string;
  readonly name: string;
  readonly isni: string;
  readonly ipi: string | null;
  pools: LanePoolName[];
  role: string;
  totalShareBps: number;
}

/**
 * Build the full lane payload for a resolved template + registry asset.
 * Returns null when the entity guard fails (fail closed — never serve a
 * payload whose bound entity cannot pass the served-entity validation).
 */
function buildLanePayload(template: LaneTemplateResolution, asset: MasterDemoAsset): ExecutionLanePayload | null {
  const record = template.library === 'atomic' ? template.atomicRecord : template.factoryRecord;

  // Entity binding — the template's bound SDK entity, validated before serving.
  const boundEntity =
    template.library === 'atomic' ? bindAtomicEntity(template.atomicRecord) : bindFactoryEntity(template.factoryRecord);
  if (boundEntity && !validateServedEntity(boundEntity)) {
    return null;
  }

  // Guard 1 — the entityType↔templateId binding from the owning registry.
  const binding =
    template.library === 'atomic'
      ? ATOMIC_SECTOR_GUARDS.find((entry) => entry.sector === template.atomicRecord.atomicSector)
      : FACTORY_VERTICAL_GUARDS.find((entry) => entry.sector === template.factoryRecord.verticalCategory);
  if (!binding) {
    throw new Error(`executionLane: no guard binding covers template ${record.templateId}`);
  }
  if (!EXECUTION_LANE_ROUTE_MANIFEST.includes(binding.sector)) {
    throw new Error(`executionLane: ${binding.sector} is not registered on the route manifest`);
  }
  const entityVerdict = evaluateGuardBinding(binding, {
    templateId: record.templateId,
    entityType: boundEntity?.entityType ?? null,
  });

  // Guard 2 — cross-domain binding on the MASTER domain names (the six
  // GlobalEntertainmentCategory values): same domain always allowed,
  // otherwise only through the founder-owned allowlist (default empty —
  // fail closed).
  const templateMasterCategory =
    template.library === 'atomic'
      ? ATOMIC_SECTOR_TO_VERTICAL[template.atomicRecord.atomicSector]
      : TEMPLATE_VERTICAL_TO_MASTER[template.factoryRecord.verticalCategory];
  const assetMasterCategory = ATOMIC_SECTOR_TO_VERTICAL[asset.sector];
  const crossVerdict = evaluateCrossDomainBinding(templateMasterCategory, assetMasterCategory);

  const guardReport: readonly GuardVerdict[] = [entityVerdict, crossVerdict];

  // Pool reconciliation — integer BPS, dust to the operations yield.
  const pools = reconcileParticipantPools(asset.poolRoster);

  // Engine allocation of the agreement fee across the reconciled shares.
  const splits: SplitPartyInput[] = pools.pools.flatMap((pool) =>
    pool.parties.map((party) => ({
      payee_id: `${party.identityKey}:${party.pool}`,
      payee_name: party.name,
      role: payeeRoleFor(party.identityKey),
      share_bps: party.poolShareBps,
    })),
  );
  const allocation = allocateWithCompanyDustSweep(asset.agreement.feeCents, splits);
  if (!allocation.ok) {
    // Unreachable while the reconciler asserts 10,000 — kept explicit so a
    // future roster change surfaces as a thrown error, never a bad payload.
    throw new Error(`executionLane: the reconciled pools failed the engine balance check (${allocation.message})`);
  }
  const amountByLine = new Map(allocation.splits.map((split) => [split.payee_id, split.amount_cents]));
  const payoutFlows: readonly LanePayoutFlow[] = pools.pools.flatMap((pool) =>
    pool.parties.map((party) => ({
      pool: party.pool,
      poolLabel: pool.label,
      name: party.name,
      role: party.role,
      shareBps: party.poolShareBps,
      amountCents: amountByLine.get(`${party.identityKey}:${party.pool}`) ?? 0,
    })),
  );
  const allocatedCents = allocation.splits.reduce((sum, split) => sum + split.amount_cents, 0);
  const auditor: LaneAuditor = {
    grossCents: asset.agreement.feeCents,
    allocatedCents,
    companyDustCents: allocation.company_dust_cents,
    balanced: allocatedCents + allocation.company_dust_cents === asset.agreement.feeCents,
  };

  // Identity blocks — unique identities with their pools and roles.
  const byIdentity = new Map<string, MutableLaneParty>();
  for (const pool of pools.pools) {
    for (const party of pool.parties) {
      const existing = byIdentity.get(party.identityKey);
      if (existing) {
        existing.pools.push(party.pool);
        existing.role = `${existing.role}, ${party.role}`;
        existing.totalShareBps += party.poolShareBps;
      } else {
        const identity = UCT_DEMO_IDENTITIES[party.identityKey];
        if (!identity) {
          throw new Error(`executionLane: roster references unknown identity ${party.identityKey}`);
        }
        byIdentity.set(party.identityKey, {
          identityKey: party.identityKey,
          uctId: identity.uctId,
          name: identity.name,
          isni: identity.isni,
          ipi: identity.ipi,
          pools: [party.pool],
          role: party.role,
          totalShareBps: party.poolShareBps,
        });
      }
    }
  }
  const parties: readonly LanePartyIdentity[] = [...byIdentity.values()];
  const signatures: readonly LaneSignature[] = parties.map((party) => ({
    uctId: party.uctId,
    name: party.name,
    role: party.role,
    status: 'AWAITING_SIGNATURE',
    signedAt: null,
  }));

  // Telemetry — the bound entity's full domain fields, or the sector's
  // telemetryMetric canon. Factory records without a bound entity compose
  // their metric line from registry data (subCategory + master category).
  const telemetry: LaneTelemetry = boundEntity
    ? formatEntityTelemetry(boundEntity)
    : {
        kind: 'sector_metric',
        telemetryMetric:
          template.library === 'atomic'
            ? template.atomicRecord.telemetryMetric
            : `${template.factoryRecord.subCategory} telemetry — ${MASTER_CATEGORY_LABELS[templateMasterCategory]} vertical`,
      };

  const templateCard: LaneTemplateCard = {
    templateId: record.templateId,
    templateName: record.templateName,
    library: template.library,
    domainLabel:
      template.library === 'atomic'
        ? prettySectorName(template.atomicRecord.atomicSector)
        : MASTER_CATEGORY_LABELS[templateMasterCategory],
    sector: binding.sector,
    masterCategory: templateMasterCategory,
    governingJurisdiction: template.library === 'factory' ? template.factoryRecord.governingJurisdiction : null,
    keyClauses: record.keyClauses,
    executionStatus: record.executionStatus,
    timesExecuted: record.timesExecuted,
    requestedKey: template.requestedKey,
    aliasResolved: template.aliasResolved,
  };

  return {
    template: templateCard,
    asset: {
      cbt: asset.cbt,
      kind: asset.kind,
      title: asset.title,
      sector: asset.sector,
      sectorLabel: prettySectorName(asset.sector),
      workIdentifiers: asset.workIdentifiers,
    },
    parties,
    pools,
    telemetry,
    guardReport,
    crossDomainBlocked: !crossVerdict.allowed,
    agreement: {
      effectiveDate: asset.agreement.effectiveDate,
      territory: asset.agreement.territory,
      term: asset.agreement.term,
      governingLaw: asset.agreement.governingLaw,
      feeCents: asset.agreement.feeCents,
    },
    signatures,
    payoutFlows,
    auditor,
    lineage: {
      cbt: asset.cbt,
      cvt: cvtDisplayCode(asset.cbt),
      derivation: 'CVT display code derived server-side from the CBT body — last four hex',
    },
    execution: null,
  };
}

export type ExecutionLaneResolution =
  | { readonly ok: true; readonly demo: boolean; readonly lane: ExecutionLanePayload }
  | { readonly ok: false; readonly reason: 'unknown_template' | 'unknown_cbt' | 'entity_guard_failed' };

/**
 * The GET-path hydrator: ONE typed payload for a template key + CBT pair.
 * Fail-closed — an unknown template key or CBT never invents a record.
 */
export function resolveExecutionLane(input: { readonly templateKey: string; readonly cbt: string }): ExecutionLaneResolution {
  const template = resolveLaneTemplate(input.templateKey);
  if (template === null) {
    return { ok: false, reason: 'unknown_template' };
  }
  const asset = demoAssetForCbt(input.cbt);
  if (asset === undefined) {
    return { ok: false, reason: 'unknown_cbt' };
  }
  const lane = buildLanePayload(template, asset);
  if (lane === null) {
    return { ok: false, reason: 'entity_guard_failed' };
  }
  return { ok: true, demo: isDevSeedMode(), lane };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE POST PATH — execute. Guards, then the CBT-stamped execution record,
// then the master clearing ledger landing through the store path.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The execution stamp — a deterministic CBT-EXEC code derived from the
 * binding triple (CBT, template id, stamp time). Server-side only.
 */
export function executionStampCode(cbt: string, templateId: string, stampedAt: string): string {
  const digest = createHash('sha256').update(`${cbt}::${templateId}::${stampedAt}`).digest('hex').slice(0, 12).toUpperCase();
  return `CBT-EXEC-${digest}`;
}

export type ExecutionMintResolution =
  | { readonly ok: true; readonly lane: ExecutionLanePayload; readonly ledgerRecord: SovereignLedgerRecord }
  | {
      readonly ok: false;
      readonly reason: 'unknown_template' | 'unknown_cbt' | 'entity_guard_failed' | 'guard_blocked';
      readonly guardReport?: readonly GuardVerdict[];
    };

/**
 * Execute a binding: resolve, enforce the guard report (any blocked verdict
 * stops the mint — nothing lands), then mint the CBT-stamped execution
 * record, land it in the master clearing ledger through the store path, and
 * return the stamped payload with every signature EXECUTED.
 */
export function mintExecutionLane(
  input: { readonly templateKey: string; readonly cbt: string },
  stampedAt: string = new Date().toISOString(),
): ExecutionMintResolution {
  const resolution = resolveExecutionLane(input);
  if (!resolution.ok) {
    return resolution;
  }
  const { lane } = resolution;
  const blocked = lane.guardReport.filter((verdict) => !verdict.allowed);
  if (blocked.length > 0) {
    return { ok: false, reason: 'guard_blocked', guardReport: blocked };
  }

  const executionId = executionStampCode(lane.lineage.cbt, lane.template.templateId, stampedAt);
  const ledgerRecord = recordExecutionInMasterLedger({
    category: lane.template.masterCategory,
    subcategory: lane.asset.kind,
    assetTitle: lane.asset.title,
    // The rights holder of record — the payload's lead ownership party.
    rightsHolderKey: lane.pools.pools[0].parties[0].identityKey,
    grossCents: lane.agreement.feeCents,
    stampedAt,
  });

  return {
    ok: true,
    ledgerRecord,
    lane: {
      ...lane,
      execution: { executionId, stampedAt, ledgerId: ledgerRecord.ledgerId },
      signatures: lane.signatures.map((signature) => ({ ...signature, status: 'EXECUTED' as const, signedAt: stampedAt })),
    },
  };
}

/**
 * The route manifest — EVERY sector the lane serves, straight from the
 * canon: all 26 atomic sectors plus all six factory verticals. No vertical
 * of entertainment is left out of the execution lane; buildLanePayload
 * refuses to serve any template whose owning sector is missing here.
 */
export const EXECUTION_LANE_ROUTE_MANIFEST: readonly string[] = Object.freeze([
  ...ATOMIC_SECTOR_ORDER,
  ...FACTORY_VERTICAL_GUARDS.map((entry) => entry.sector),
]);
