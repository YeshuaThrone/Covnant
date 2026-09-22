/**
 * Sovereign Clearing Framework — atomic registry gates (founder canon,
 * CovnantAtomicDataSDK). These tests FAIL LOUD when the registry drifts: an
 * atomic sector left without a record (the founder's "don't leave any form
 * out" directive), a founder-verbatim seed off its dropped shape, an
 * ampersand in a name or clause (Zero Ampersands), a tab filter that renders
 * no atomic records, or the TPL-FLM-001 id collision resolved wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  ATOMIC_TEMPLATE_REGISTRY,
  ATOMIC_SECTOR_ORDER,
  ATOMIC_SECTOR_TO_VERTICAL,
  atomicRecordsForCategory,
  applyAtomicRealExecutionCounts,
  resolveAtomicRegistry,
  MASTER_TEMPLATE_LIBRARY,
  type AtomicContractRecord,
  type AtomicSector,
} from '../masterStore';
import { MASTER_CATEGORY_ORDER } from '../taxonomy';

/** The founder's 26 atomic sectors plus the three generation-4 expansion
 *  sectors (SPORTS_AND_ATHLETICS, ESPORTS, SPONSORSHIP, 2026-09-22) — canon order, exact. */
const CANON_ATOMIC_SECTORS: readonly AtomicSector[] = [
  'MUSIC',
  'GAMING',
  'ESPORTS',
  'INTERACTIVE',
  'PODCASTING',
  'STREAMING',
  'SOCIAL_MEDIA',
  'PUBLISHING',
  'MOVIES',
  'FILM',
  'TV',
  'VIDEO',
  'SPORTS',
  'MOTORSPORT',
  'ARENA',
  'ATHLETICS',
  'SPORTS_AND_ATHLETICS',
  'FASHION',
  'MODELING',
  'CAD',
  'VISUAL_ARTS',
  'DESIGN',
  'SPONSORSHIP',
  'BOOKS',
  'LITERATURE',
  'DIGITAL_ASSETS',
  'SOFTWARE',
  'VTUBING',
  'VIRTUAL_AVATARS',
];

/** The seven founder-verbatim seeds, EXACTLY as dropped. */
const FOUNDER_ATOMIC_SEEDS: readonly AtomicContractRecord[] = [
  {
    templateId: 'TPL-MTR-001',
    templateName: 'Motorsport Circuit Trackage Media Rights Agreement',
    atomicSector: 'MOTORSPORT',
    entityType: 'Motorsport Circuit',
    telemetryMetric: 'Telemetry Track Telematics and Pit Revenue',
    splitStructure: { ownershipReserve: 50, creativePayout: 35, operationsYield: 15 },
    keyClauses: ['Lap Time Broadcast Micro Payouts', 'Circuit Pit Lane Asset Lock', 'Telemetry Escrow Gate'],
    executionStatus: 'PRODUCTION_READY',
    timesExecuted: 210,
  },
  {
    templateId: 'TPL-ARN-001',
    templateName: 'Arena Venue Facility Access and Gate Yield Clearing',
    atomicSector: 'ARENA',
    entityType: 'Arena Operator',
    telemetryMetric: 'Turnstile Gate Foot Traffic and Venue Concessions',
    splitStructure: { ownershipReserve: 50, creativePayout: 35, operationsYield: 15 },
    keyClauses: ['Sub Second Turnstile Settlement', 'Facility Fee Floor Gate', 'In Venue Commercial Clearing'],
    executionStatus: 'PRODUCTION_READY',
    timesExecuted: 430,
  },
  {
    templateId: 'TPL-FLM-001',
    templateName: 'Feature Film Theatrical Distribution Master Agreement',
    atomicSector: 'FILM',
    entityType: 'Film Studio',
    telemetryMetric: 'Box Office Gross Receipts and ISAN Telemetry',
    splitStructure: { ownershipReserve: 50, creativePayout: 35, operationsYield: 15 },
    keyClauses: ['Box Office Gross Escrow Lock', 'Territorial Window Distribution Gate', 'ISAN Asset Tracking'],
    executionStatus: 'PRODUCTION_READY',
    timesExecuted: 890,
  },
  {
    templateId: 'TPL-TV-001',
    templateName: 'Linear Television Broadcast Syndication Contract',
    atomicSector: 'TV',
    entityType: 'Broadcaster',
    telemetryMetric: 'Nielsen Ratings and Linear Commercial Flight Minutes',
    splitStructure: { ownershipReserve: 50, creativePayout: 35, operationsYield: 15 },
    keyClauses: ['Ad Insertion Micro Routing', 'Syndication Reversion Lock', 'Territory Airtime Escrow'],
    executionStatus: 'PRODUCTION_READY',
    timesExecuted: 620,
  },
  {
    templateId: 'TPL-CAD-001',
    templateName: '3D CAD Mesh Spatial Asset Licensing Agreement',
    atomicSector: 'CAD',
    entityType: 'CAD Asset Store',
    telemetryMetric: 'Direct Polygon Mesh Downloads and API Invocations',
    splitStructure: { ownershipReserve: 50, creativePayout: 35, operationsYield: 15 },
    keyClauses: ['Spatial Polygon Licensing Lock', 'Automated Render Engine Yield', 'Zero Knowledge Asset Protection'],
    executionStatus: 'PRODUCTION_READY',
    timesExecuted: 1150,
  },
  {
    templateId: 'TPL-FSH-001',
    templateName: 'Physical Garment High Volume Production Contract',
    atomicSector: 'FASHION',
    entityType: 'Fashion House',
    telemetryMetric: 'Cut and Sew Unit Yield and Wholesale Inventory',
    splitStructure: { ownershipReserve: 50, creativePayout: 35, operationsYield: 15 },
    keyClauses: ['Continuous Floor Manufacturing Escrow', 'Unit Run Payout Gate', 'DTC Order Settlement'],
    executionStatus: 'PRODUCTION_READY',
    timesExecuted: 540,
  },
  {
    templateId: 'TPL-VTB-001',
    templateName: 'Virtual Avatar Rigging and Model Ownership Contract',
    atomicSector: 'VTUBING',
    entityType: 'Virtual Avatar Creator',
    telemetryMetric: 'Stream Frame Render Hours and Direct Fan Micro Tipping',
    splitStructure: { ownershipReserve: 50, creativePayout: 35, operationsYield: 15 },
    keyClauses: ['Live Stream Micro Tipping Telemetry', 'Rigging Model IP Isolation', 'Syndicated Avatar Split'],
    executionStatus: 'PRODUCTION_READY',
    timesExecuted: 980,
  },
];

describe('atomic registry — founder canon shape', () => {
  it('carries the completed 29-record atomic registry', () => {
    expect(ATOMIC_TEMPLATE_REGISTRY).toHaveLength(29);
  });

  it('declares the 29 atomic sectors in exact canon order', () => {
    expect(ATOMIC_SECTOR_ORDER).toEqual(CANON_ATOMIC_SECTORS);
  });

  it('shapes every record onto the CovnantAtomicDataSDK canon', () => {
    for (const record of ATOMIC_TEMPLATE_REGISTRY) {
      expect(CANON_ATOMIC_SECTORS).toContain(record.atomicSector);
      expect(record.templateName.trim()).not.toBe('');
      expect(record.entityType.trim()).not.toBe('');
      expect(record.telemetryMetric.trim()).not.toBe('');
      // The 50/35/15 canon — compiler-enforced literals, asserted here too.
      expect(record.splitStructure).toEqual({
        ownershipReserve: 50,
        creativePayout: 35,
        operationsYield: 15,
      });
      expect(record.keyClauses).toHaveLength(3);
      for (const clause of record.keyClauses) {
        expect(clause.trim()).not.toBe('');
      }
      expect(['PRODUCTION_READY', 'LEGAL_VAULT_LOCKED']).toContain(record.executionStatus);
      expect(record.timesExecuted).toBeGreaterThan(0);
      expect(Number.isInteger(record.timesExecuted)).toBe(true);
    }
  });

  it('keeps the seven founder-verbatim seeds EXACTLY as dropped', () => {
    for (const seed of FOUNDER_ATOMIC_SEEDS) {
      const stored = ATOMIC_TEMPLATE_REGISTRY.find((r) => r.templateId === seed.templateId);
      expect(stored, `founder atomic seed ${seed.templateId} missing`).toBeDefined();
      expect(stored).toEqual(seed);
    }
  });

  it('owns TPL-FLM-001 with the founder Feature Film seed — the generated theatrical record renumbers', () => {
    const atomicFlm = ATOMIC_TEMPLATE_REGISTRY.find((r) => r.templateId === 'TPL-FLM-001');
    expect(atomicFlm?.templateName).toBe('Feature Film Theatrical Distribution Master Agreement');
    // The factory library no longer holds TPL-FLM-001...
    expect(MASTER_TEMPLATE_LIBRARY.some((r) => r.templateId === 'TPL-FLM-001')).toBe(false);
    // ...and keeps the generated record otherwise intact under TPL-FLM-007.
    const flm7 = MASTER_TEMPLATE_LIBRARY.find((r) => r.templateId === 'TPL-FLM-007');
    expect(flm7?.templateName).toBe('Theatrical Distribution & Box Office Settlement');
    expect(flm7?.subCategory).toBe('Theatrical');
    expect(flm7?.timesExecuted).toBe(812);
    expect(flm7?.keyClauses).toEqual([
      'Box Office Gross Escrow',
      'Per-Screen Settlement Telemetry',
      'Studio Overlay Auto-Distribution',
    ]);
  });

  it('never shares a template id with the factory library', () => {
    const factoryIds = new Set(MASTER_TEMPLATE_LIBRARY.map((r) => r.templateId));
    for (const record of ATOMIC_TEMPLATE_REGISTRY) {
      expect(
        factoryIds.has(record.templateId),
        `${record.templateId} collides with the factory library`,
      ).toBe(false);
    }
  });

  it('is a zero-ampersand registry — names and clauses read "and", never "&"', () => {
    for (const record of ATOMIC_TEMPLATE_REGISTRY) {
      expect(record.templateName.includes('&'), `${record.templateId} name carries &`).toBe(false);
      for (const clause of record.keyClauses) {
        expect(clause.includes('&'), `${record.templateId} clause "${clause}" carries &`).toBe(false);
      }
    }
  });
});

describe('atomic registry — every sector covered, no empty tab', () => {
  it('covers ALL 29 atomic sectors with at least one record', () => {
    for (const sector of CANON_ATOMIC_SECTORS) {
      const inSector = ATOMIC_TEMPLATE_REGISTRY.filter((r) => r.atomicSector === sector);
      expect(inSector.length, `atomic sector ${sector} has no record`).toBeGreaterThanOrEqual(1);
    }
  });

  it('renders at least one atomic record under every master vertical tab', () => {
    for (const category of MASTER_CATEGORY_ORDER) {
      const scoped = atomicRecordsForCategory(ATOMIC_TEMPLATE_REGISTRY, category);
      expect(scoped.length, `${category} renders no atomic records`).toBeGreaterThanOrEqual(1);
      for (const record of scoped) {
        expect(ATOMIC_SECTOR_TO_VERTICAL[record.atomicSector]).toBe(category);
      }
    }
  });

  it('scopes each vertical tab to its sector counts', () => {
    expect(atomicRecordsForCategory(ATOMIC_TEMPLATE_REGISTRY, 'FILM_AND_TELEVISION')).toHaveLength(5);
    expect(atomicRecordsForCategory(ATOMIC_TEMPLATE_REGISTRY, 'AUDIO_AND_RECORDED_SOUND')).toHaveLength(2);
    expect(atomicRecordsForCategory(ATOMIC_TEMPLATE_REGISTRY, 'PUBLISHING_AND_LITERARY')).toHaveLength(3);
    expect(atomicRecordsForCategory(ATOMIC_TEMPLATE_REGISTRY, 'LIVE_PERFORMANCE_AND_COMEDY')).toHaveLength(3);
    expect(atomicRecordsForCategory(ATOMIC_TEMPLATE_REGISTRY, 'SPORTS_AND_ATHLETICS')).toHaveLength(2);
    expect(atomicRecordsForCategory(ATOMIC_TEMPLATE_REGISTRY, 'INTERACTIVE_AND_DIGITAL_MEDIA')).toHaveLength(9);
    expect(atomicRecordsForCategory(ATOMIC_TEMPLATE_REGISTRY, 'COMMERCIAL_AND_BRAND_LICENSING')).toHaveLength(5);
  });

  it('maps every canon sector onto a master vertical — no unmapped sector', () => {
    expect(Object.keys(ATOMIC_SECTOR_TO_VERTICAL)).toHaveLength(29);
    for (const sector of CANON_ATOMIC_SECTORS) {
      expect(ATOMIC_SECTOR_TO_VERTICAL[sector]).toBeDefined();
    }
  });

  it('returns the whole registry when no tab is active', () => {
    expect(atomicRecordsForCategory(ATOMIC_TEMPLATE_REGISTRY, null)).toHaveLength(
      ATOMIC_TEMPLATE_REGISTRY.length,
    );
  });
});

describe('atomic registry — mode resolution', () => {
  it('derives real-mode execution counts from the live contract store', () => {
    const counted = applyAtomicRealExecutionCounts(ATOMIC_TEMPLATE_REGISTRY, [
      { templateId: 'TPL-FLM-001' },
      { templateId: 'TPL-FLM-001' },
      { templateId: 'TPL-FLM-001' },
    ]);
    expect(counted.find((r) => r.templateId === 'TPL-FLM-001')?.timesExecuted).toBe(3);
    // Records without factory executions read thin — zero, honestly.
    expect(counted.find((r) => r.templateId === 'TPL-MTR-001')?.timesExecuted).toBe(0);
  });

  it('resolves the seeded registry under the demo door (DEMO DATA disclosed)', async () => {
    const previous = process.env.DON_DEV_SEED;
    process.env.DON_DEV_SEED = '1';
    try {
      const { demo, records } = await resolveAtomicRegistry();
      expect(demo).toBe(true);
      expect(records).toEqual(ATOMIC_TEMPLATE_REGISTRY);
      const mtr = records.find((r) => r.templateId === 'TPL-MTR-001');
      expect(mtr?.timesExecuted).toBe(210);
    } finally {
      if (previous === undefined) delete process.env.DON_DEV_SEED;
      else process.env.DON_DEV_SEED = previous;
    }
  });
});
