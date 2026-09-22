/**
 * Universal Execution Lane gates — the founder's GO (2026-09-20): ONE typed
 * payload for EVERY vertical of entertainment. These tests hold the lane to
 * its canon: template resolution across BOTH libraries with the
 * production-key alias map, pool reconciliation that sums to EXACTLY 10,000
 * BPS under 50/35/15 with integer dust to the operations yield, payload
 * completeness for every seeded sector, structured guard verdicts (same
 * sector passes, cross-sector fails closed, the founder-owned allowlist is
 * the only door), and fail-closed behavior on unknown keys — no invented
 * records, ever.
 */
import { describe, expect, it } from 'vitest';

import {
  ATOMIC_TEMPLATE_REGISTRY,
  MASTER_TEMPLATE_LIBRARY,
  demoAssetForCbt,
  listDemoLaneAssets,
} from '../masterStore';
import {
  CROSS_DOMAIN_BINDING_ALLOWLIST,
  LANE_POOL_BPS,
  LANE_POOL_ORDER,
  LANE_TOTAL_BPS,
  evaluateCrossDomainBindingWithAllowlist,
} from '../CovnantAtomicDataSDK';
import {
  EXECUTION_LANE_ROUTE_MANIFEST,
  executionStampCode,
  mintExecutionLane,
  reconcileParticipantPools,
  resolveExecutionLane,
  resolveLaneTemplate,
} from '../executionLane';

const FOUNDER_TEMPLATE_KEY = 'FASHION_RUNWAY_TALENT_RELEASE';
const FOUNDER_CBT = 'CBT-TRK-A51DF05B4279';

describe('lane template resolution — either library, alias map, fail closed', () => {
  it('resolves the production alias FASHION_RUNWAY_TALENT_RELEASE to the FASHION atomic record', () => {
    const resolution = resolveLaneTemplate(FOUNDER_TEMPLATE_KEY);
    expect(resolution).not.toBeNull();
    expect(resolution?.library).toBe('atomic');
    expect(resolution?.library === 'atomic' && resolution.atomicRecord.templateId).toBe('TPL-FSH-001');
    expect(resolution?.aliasResolved).toBe(true);
    expect(resolution?.requestedKey).toBe(FOUNDER_TEMPLATE_KEY);
  });

  it('resolves every atomic registry id', () => {
    expect(ATOMIC_TEMPLATE_REGISTRY.length).toBe(29);
    for (const record of ATOMIC_TEMPLATE_REGISTRY) {
      const resolution = resolveLaneTemplate(record.templateId);
      expect(resolution, `${record.templateId} must resolve`).not.toBeNull();
      expect(resolution?.library).toBe('atomic');
    }
  });

  it('resolves every factory library id', () => {
    expect(MASTER_TEMPLATE_LIBRARY.length).toBe(31);
    for (const record of MASTER_TEMPLATE_LIBRARY) {
      const resolution = resolveLaneTemplate(record.templateId);
      expect(resolution, `${record.templateId} must resolve`).not.toBeNull();
      expect(resolution?.library).toBe('factory');
    }
  });

  it('returns null for an unknown key — never an invented record', () => {
    expect(resolveLaneTemplate('TPL-XXX-999')).toBeNull();
    expect(resolveLaneTemplate('NOT_A_TEMPLATE')).toBeNull();
  });
});

describe('pool reconciliation — integer BPS, 50/35/15, dust to the operations yield', () => {
  it('holds the 50/35/15 canon weights summing to exactly 10,000 BPS', () => {
    expect(LANE_TOTAL_BPS).toBe(10_000);
    expect(LANE_POOL_ORDER).toEqual(['OWNERSHIP_RESERVE', 'CREATIVE_PAYOUT', 'OPERATIONS_YIELD']);
    expect(LANE_POOL_BPS.OWNERSHIP_RESERVE).toBe(5_000);
    expect(LANE_POOL_BPS.CREATIVE_PAYOUT).toBe(3_500);
    expect(LANE_POOL_BPS.OPERATIONS_YIELD).toBe(1_500);
  });

  it('reconciles every seeded asset to exactly 10,000 BPS with all dust on the operations yield', () => {
    const assets = listDemoLaneAssets();
    expect(assets.length).toBeGreaterThanOrEqual(6);
    for (const row of assets) {
      const asset = demoAssetForCbt(row.cbt);
      expect(asset, `${row.cbt} must hydrate`).toBeDefined();
      const pools = reconcileParticipantPools(asset?.poolRoster ?? []);
      // The grand total is EXACTLY 10,000 — never 9,999, never 10,001.
      expect(pools.totalBps, `${row.cbt} pool total`).toBe(LANE_TOTAL_BPS);
      expect(pools.pools.reduce((sum, pool) => sum + pool.totalBps, 0)).toBe(10_000);
      // The fixed pools keep their canon weights minus rounding dust; ALL
      // dust sweeps to the operations yield (the Don dust canon).
      for (const pool of pools.pools) {
        const partySum = pool.parties.reduce((sum, party) => sum + party.poolShareBps, 0);
        expect(partySum, `${row.cbt} ${pool.pool} party sum`).toBe(pool.totalBps);
        for (const party of pool.parties) {
          expect(Number.isInteger(party.poolShareBps), 'integer BPS only').toBe(true);
          expect(party.poolShareBps).toBeGreaterThanOrEqual(0);
        }
      }
      expect(pools.pools[0].totalBps).toBe(5_000 - pools.pools[0].dustBps);
      expect(pools.pools[1].totalBps).toBe(3_500 - pools.pools[1].dustBps);
      expect(pools.pools[2].totalBps).toBe(1_500 + pools.dustBps);
    }
  });

  it('reconciles deterministically — same roster, same shares', () => {
    const asset = demoAssetForCbt(FOUNDER_CBT);
    expect(asset).toBeDefined();
    const first = reconcileParticipantPools(asset?.poolRoster ?? []);
    const second = reconcileParticipantPools(asset?.poolRoster ?? []);
    expect(second).toEqual(first);
  });
});

describe('payload hydration — completeness for every seeded sector', () => {
  it('hydrates a complete payload for every demo asset through its owning sector template', () => {
    for (const row of listDemoLaneAssets()) {
      const asset = demoAssetForCbt(row.cbt);
      expect(asset).toBeDefined();
      const sectorTemplate = ATOMIC_TEMPLATE_REGISTRY.find((record) => record.atomicSector === row.sector);
      expect(sectorTemplate, `${row.sector} must own an atomic template`).toBeDefined();
      const resolution = resolveExecutionLane({ templateKey: sectorTemplate?.templateId ?? '', cbt: row.cbt });
      if (!resolution.ok) throw new Error(`${row.cbt} failed hydration: ${resolution.reason}`);
      const lane = resolution.lane;

      // Template card.
      expect(lane.template.templateId).toBe(sectorTemplate?.templateId);
      expect(lane.template.templateName.length).toBeGreaterThan(0);
      expect(lane.template.keyClauses.length).toBeGreaterThan(0);
      // Asset of record.
      expect(lane.asset.cbt).toBe(row.cbt);
      expect(lane.asset.title.length).toBeGreaterThan(0);
      expect(lane.asset.workIdentifiers.length).toBeGreaterThan(0);
      // Identities — auto-filled, never 'To be completed'.
      expect(lane.parties.length).toBeGreaterThanOrEqual(2);
      for (const party of lane.parties) {
        expect(party.uctId.startsWith('UCT-'), `${party.name} carries a UCT id`).toBe(true);
        expect(party.isni.length).toBeGreaterThan(0);
        expect(party.isni).not.toBe('To be completed');
        expect(party.totalShareBps).toBeGreaterThan(0);
      }
      // Pools, agreement, signatures, flows, auditor.
      expect(lane.pools.totalBps).toBe(10_000);
      expect(lane.agreement.governingLaw.length).toBeGreaterThan(0);
      expect(lane.agreement.feeCents).toBeGreaterThan(0);
      expect(lane.signatures).toHaveLength(lane.parties.length);
      // One payout line per (identity, pool) membership.
      expect(lane.payoutFlows).toHaveLength(
        lane.parties.reduce((sum, party) => sum + party.pools.length, 0),
      );
      expect(lane.auditor.balanced).toBe(true);
      expect(lane.auditor.grossCents).toBe(lane.agreement.feeCents);
      // The structured guard report — every verdict visible.
      expect(lane.guardReport).toHaveLength(2);
      expect(lane.crossDomainBlocked).toBe(false);
      for (const verdict of lane.guardReport) {
        expect(verdict.allowed).toBe(true);
        expect(verdict.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('serves the CBT/CVT lineage canon — CBT-TRK-A51DF05B4279 displays as CVT-TRK-4279', () => {
    const resolution = resolveExecutionLane({ templateKey: 'TPL-MUS-001', cbt: FOUNDER_CBT });
    expect(resolution.ok).toBe(true);
    expect(resolution.ok && resolution.lane.lineage.cbt).toBe(FOUNDER_CBT);
    expect(resolution.ok && resolution.lane.lineage.cvt).toBe('CVT-TRK-4279');
  });

  it('renders full entity fields for the seeded MUSIC class and canon metrics elsewhere', () => {
    const music = resolveExecutionLane({ templateKey: 'TPL-MUS-001', cbt: FOUNDER_CBT });
    expect(music.ok).toBe(true);
    if (music.ok) {
      expect(music.lane.telemetry.kind).toBe('entity');
      if (music.lane.telemetry.kind === 'entity') {
        expect(music.lane.telemetry.classTag).toBe('MUSIC');
        const labels = music.lane.telemetry.fields.map((field) => field.label);
        expect(labels).toContain('ISRC Code');
        expect(labels).toContain('PRO Telemetry Binding');
      }
    }
    // A sector without an SDK entity class keeps its telemetryMetric canon.
    const fashion = resolveExecutionLane({ templateKey: 'TPL-FSH-001', cbt: 'CBT-FSH-3F7A1B9D5E2C' });
    expect(fashion.ok).toBe(true);
    if (fashion.ok) {
      expect(fashion.lane.telemetry.kind).toBe('sector_metric');
      if (fashion.lane.telemetry.kind === 'sector_metric') {
        expect(fashion.lane.telemetry.telemetryMetric.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('guard verdicts — fail closed, allowlist is the only cross-domain door', () => {
  it('keeps the founder-owned default allowlist EMPTY', () => {
    expect(CROSS_DOMAIN_BINDING_ALLOWLIST).toHaveLength(0);
  });

  it('always allows a same-sector binding', () => {
    const resolution = resolveExecutionLane({ templateKey: 'TPL-MUS-001', cbt: FOUNDER_CBT });
    expect(resolution.ok).toBe(true);
    const cross = resolution.ok ? resolution.lane.guardReport.find((verdict) => verdict.kind === 'CROSS_DOMAIN') : undefined;
    expect(cross?.allowed).toBe(true);
    expect(cross?.reason).toContain('Same-sector');
  });

  it('blocks a cross-sector pair by default — every verdict visible in the payload', () => {
    // The founder's production pairing — a FASHION template on a MUSIC asset.
    const resolution = resolveExecutionLane({ templateKey: FOUNDER_TEMPLATE_KEY, cbt: FOUNDER_CBT });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      const cross = resolution.lane.guardReport.find((verdict) => verdict.kind === 'CROSS_DOMAIN');
      expect(cross?.allowed).toBe(false);
      expect(resolution.lane.crossDomainBlocked).toBe(true);
    }
  });

  it('lets an explicit allowlist entry pass the same pair', () => {
    const verdict = evaluateCrossDomainBindingWithAllowlist(
      [{
        sourceSector: 'COMMERCIAL_AND_BRAND_LICENSING',
        targetSector: 'AUDIO_AND_RECORDED_SOUND',
        note: 'test-grant — allowlist is founder-owned',
      }],
      'COMMERCIAL_AND_BRAND_LICENSING',
      'AUDIO_AND_RECORDED_SOUND',
    );
    expect(verdict.allowed).toBe(true);
  });

  it('registers every atomic sector and factory vertical on the route manifest', () => {
    expect(EXECUTION_LANE_ROUTE_MANIFEST.length).toBe(29 + 6);
    for (const record of ATOMIC_TEMPLATE_REGISTRY) {
      expect(EXECUTION_LANE_ROUTE_MANIFEST, `${record.atomicSector} must be on the manifest`).toContain(record.atomicSector);
    }
    expect(EXECUTION_LANE_ROUTE_MANIFEST).toContain('FASHION');
    expect(EXECUTION_LANE_ROUTE_MANIFEST).toContain('AUDIO_SOUND');
  });
});

describe('execution mint — fail closed on unknowns and blocked guards, stamped through the ledger', () => {
  it('fails closed with 404 reasons on unknown template key and unknown CBT', () => {
    const unknownTemplate = mintExecutionLane({ templateKey: 'TPL-XXX-999', cbt: FOUNDER_CBT });
    expect(unknownTemplate.ok).toBe(false);
    expect(!unknownTemplate.ok && unknownTemplate.reason).toBe('unknown_template');
    const unknownCbt = mintExecutionLane({ templateKey: 'TPL-MUS-001', cbt: 'CBT-XXX-000000000000' });
    expect(unknownCbt.ok).toBe(false);
    expect(!unknownCbt.ok && unknownCbt.reason).toBe('unknown_cbt');
  });

  it('refuses to mint when a guard blocks the pair — nothing lands in the ledger', () => {
    const minted = mintExecutionLane({ templateKey: FOUNDER_TEMPLATE_KEY, cbt: FOUNDER_CBT });
    expect(minted.ok).toBe(false);
    expect(!minted.ok && minted.reason).toBe('guard_blocked');
    expect(
      !minted.ok && minted.guardReport?.every((verdict) => !verdict.allowed),
      'the blocked verdicts ride the refusal',
    ).toBe(true);
  });

  it('mints a CBT-stamped execution record through the master clearing ledger on an allowed pair', () => {
    const minted = mintExecutionLane({ templateKey: 'TPL-MUS-001', cbt: FOUNDER_CBT }, '2026-09-20T00:00:00.000Z');
    expect(minted.ok).toBe(true);
    if (minted.ok) {
      expect(minted.lane.execution?.executionId).toMatch(/^CBT-EXEC-[0-9A-F]{12}$/);
      expect(minted.lane.execution?.ledgerId).toMatch(/^CVN-/);
      expect(minted.lane.execution?.ledgerId).toBe(minted.ledgerRecord.ledgerId);
      for (const signature of minted.lane.signatures) {
        expect(signature.status).toBe('EXECUTED');
        expect(signature.signedAt).toBe('2026-09-20T00:00:00.000Z');
      }
    }
  });

  it('derives the execution stamp deterministically from the binding triple', () => {
    const first = executionStampCode(FOUNDER_CBT, 'TPL-MUS-001', '2026-09-20T00:00:00.000Z');
    const second = executionStampCode(FOUNDER_CBT, 'TPL-MUS-001', '2026-09-20T00:00:00.000Z');
    expect(first).toBe(second);
    expect(first).toMatch(/^CBT-EXEC-[0-9A-F]{12}$/);
    expect(executionStampCode(FOUNDER_CBT, 'TPL-MUS-001', '2026-09-21T00:00:00.000Z')).not.toBe(first);
  });
});
