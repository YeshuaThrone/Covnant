/**
 * Sovereign Contract Factory gates — founder canon (CovnantTemplatesSDK).
 *
 * These tests FAIL LOUD when the library drifts: a missing founder seed, a
 * vertical or master-taxonomy subcategory left without a template (the
 * founder's "don't leave any form out" directive), a split structure off the
 * 50/35/15 canon, or a tab-filter mapping that drops a vertical.
 */
import { describe, expect, it } from 'vitest';
import {
  MASTER_TEMPLATE_LIBRARY,
  TEMPLATE_VERTICAL_TO_MASTER,
  masterTemplatesForCategory,
  applyRealExecutionCounts,
  resolveMasterTemplates,
  type ContractTemplateRecord,
  type TemplateVerticalCategory,
} from '../masterStore';
import {
  MASTER_CATEGORY_ORDER,
  MASTER_SUBCATEGORIES,
} from '../taxonomy';

const FOUNDER_SEEDS: readonly ContractTemplateRecord[] = [
  {
    templateId: 'TPL-AUD-001',
    templateName: 'Master Recording & Streaming Royalty Agreement',
    verticalCategory: 'AUDIO_SOUND',
    subCategory: 'Master Recording',
    governingJurisdiction: 'US-TX Ledger Standard',
    splitStructure: { ownershipReserve: 50, creativePayout: 35, operationsYield: 15 },
    keyClauses: [
      'Sub-Second Micro-Royalty Routing',
      'Direct PRO/ISRC Telemetry Binding',
      'Dispute Immunity Shield',
    ],
    executionStatus: 'PRODUCTION_READY',
    timesExecuted: 1420,
  },
  {
    templateId: 'TPL-FLM-004',
    templateName: 'Global SVOD & AVOD Distribution Option Contract',
    verticalCategory: 'FILM_TV',
    subCategory: 'Streaming Licensing',
    governingJurisdiction: 'US-DE Corporate Standard',
    splitStructure: { ownershipReserve: 50, creativePayout: 35, operationsYield: 15 },
    keyClauses: [
      'Territory Escrow Clearance',
      'ISAN/EIDR Automated Tracking',
      'Net Residual Auto-Split',
    ],
    executionStatus: 'PRODUCTION_READY',
    timesExecuted: 890,
  },
  {
    templateId: 'TPL-LIT-002',
    templateName: 'Audiobook & Digital E-Book Rights Acquisition',
    verticalCategory: 'PUBLISHING',
    subCategory: 'Audiobook Publishing',
    governingJurisdiction: 'US-TX Ledger Standard',
    splitStructure: { ownershipReserve: 50, creativePayout: 35, operationsYield: 15 },
    keyClauses: [
      'Print-On-Demand Realtime Ledger',
      'ISBN Unified Registry',
      'Automated Author Drawdown',
    ],
    executionStatus: 'PRODUCTION_READY',
    timesExecuted: 512,
  },
  {
    templateId: 'TPL-LVE-009',
    templateName: 'Live Stand-Up & Concert Touring Ticket Escrow',
    verticalCategory: 'LIVE_COMEDY',
    subCategory: 'Live Venue Performance',
    governingJurisdiction: 'US-TX Ledger Standard',
    splitStructure: { ownershipReserve: 50, creativePayout: 35, operationsYield: 15 },
    keyClauses: [
      'Live Venue Settlement Gate',
      'Promoter/Artist Instant Allocation',
      'Ticket Sales Escrow',
    ],
    executionStatus: 'PRODUCTION_READY',
    timesExecuted: 320,
  },
];

describe('master template library — founder canon shape', () => {
  it('carries the completed 31-record factory library', () => {
    expect(MASTER_TEMPLATE_LIBRARY).toHaveLength(31);
  });

  it('shapes every record onto the CovnantTemplatesSDK canon', () => {
    for (const record of MASTER_TEMPLATE_LIBRARY) {
      expect(record.templateId).toMatch(/^TPL-(AUD|FLM|LIT|LVE|INT|BRD)-\d{3}$/);
      expect(record.templateName.trim()).not.toBe('');
      expect(record.subCategory.trim()).not.toBe('');
      expect(record.governingJurisdiction.trim()).not.toBe('');
      // The 50/35/15 canon — compiler-enforced literals, asserted here too.
      expect(record.splitStructure).toEqual({
        ownershipReserve: 50,
        creativePayout: 35,
        operationsYield: 15,
      });
      expect(record.keyClauses.length).toBeGreaterThanOrEqual(1);
      for (const clause of record.keyClauses) {
        expect(clause.trim()).not.toBe('');
      }
      expect(['PRODUCTION_READY', 'LEGAL_VAULT_LOCKED']).toContain(record.executionStatus);
      expect(record.timesExecuted).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(record.timesExecuted)).toBe(true);
    }
  });

  it('keeps the four founder-verbatim seeds EXACTLY as dropped', () => {
    for (const seed of FOUNDER_SEEDS) {
      const stored = MASTER_TEMPLATE_LIBRARY.find((t) => t.templateId === seed.templateId);
      expect(stored, `founder seed ${seed.templateId} missing`).toBeDefined();
      expect(stored).toEqual(seed);
    }
  });
});

describe('master template library — every form of entertainment covered', () => {
  it('covers all six master verticals', () => {
    for (const category of MASTER_CATEGORY_ORDER) {
      const vertical = Object.entries(TEMPLATE_VERTICAL_TO_MASTER).find(
        ([, master]) => master === category,
      )?.[0] as TemplateVerticalCategory | undefined;
      expect(vertical, `no compact code maps to ${category}`).toBeDefined();
      const inVertical = MASTER_TEMPLATE_LIBRARY.filter((t) => t.verticalCategory === vertical);
      expect(
        inVertical.length,
        `${category} has no template — a vertical is left out`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('covers EVERY master taxonomy subcategory — no form left out', () => {
    for (const category of MASTER_CATEGORY_ORDER) {
      for (const subcategory of MASTER_SUBCATEGORIES[category]) {
        const covering = MASTER_TEMPLATE_LIBRARY.find(
          (t) =>
            TEMPLATE_VERTICAL_TO_MASTER[t.verticalCategory] === category &&
            t.subCategory === subcategory,
        );
        expect(
          covering,
          `master taxonomy subcategory "${subcategory}" (${category}) has no template`,
        ).toBeDefined();
      }
    }
  });
});

describe('master template library — tab filter mapping', () => {
  it('maps the six compact founder codes onto the six master tabs, bijectively', () => {
    const codes = Object.keys(TEMPLATE_VERTICAL_TO_MASTER) as TemplateVerticalCategory[];
    expect(codes).toHaveLength(6);
    const mapped = codes.map((code) => TEMPLATE_VERTICAL_TO_MASTER[code]);
    expect(new Set(mapped).size).toBe(6);
    for (const category of MASTER_CATEGORY_ORDER) {
      expect(mapped).toContain(category);
    }
  });

  it('filters the library per vertical tab; null returns the whole library', () => {
    const all = masterTemplatesForCategory(MASTER_TEMPLATE_LIBRARY, null);
    expect(all).toHaveLength(MASTER_TEMPLATE_LIBRARY.length);

    let covered = 0;
    for (const category of MASTER_CATEGORY_ORDER) {
      const scoped = masterTemplatesForCategory(MASTER_TEMPLATE_LIBRARY, category);
      expect(scoped.length).toBeGreaterThanOrEqual(1);
      for (const record of scoped) {
        expect(TEMPLATE_VERTICAL_TO_MASTER[record.verticalCategory]).toBe(category);
      }
      covered += scoped.length;
    }
    expect(covered).toBe(MASTER_TEMPLATE_LIBRARY.length);
  });

  it('scopes the seeded verticals to their founder counts', () => {
    expect(masterTemplatesForCategory(MASTER_TEMPLATE_LIBRARY, 'AUDIO_AND_RECORDED_SOUND')).toHaveLength(6);
    expect(masterTemplatesForCategory(MASTER_TEMPLATE_LIBRARY, 'FILM_AND_TELEVISION')).toHaveLength(6);
    expect(masterTemplatesForCategory(MASTER_TEMPLATE_LIBRARY, 'PUBLISHING_AND_LITERARY')).toHaveLength(6);
    expect(masterTemplatesForCategory(MASTER_TEMPLATE_LIBRARY, 'LIVE_PERFORMANCE_AND_COMEDY')).toHaveLength(5);
    expect(masterTemplatesForCategory(MASTER_TEMPLATE_LIBRARY, 'INTERACTIVE_AND_DIGITAL_MEDIA')).toHaveLength(4);
    expect(masterTemplatesForCategory(MASTER_TEMPLATE_LIBRARY, 'COMMERCIAL_AND_BRAND_LICENSING')).toHaveLength(4);
  });
});

describe('master template library — mode resolution', () => {
  it('derives real-mode execution counts from the live contract store', () => {
    const counted = applyRealExecutionCounts(MASTER_TEMPLATE_LIBRARY, [
      { templateId: 'TPL-AUD-001' },
      { templateId: 'TPL-AUD-001' },
      { templateId: 'MUSIC_SPLIT_SHEET' },
    ]);
    const aud = counted.find((t) => t.templateId === 'TPL-AUD-001');
    expect(aud?.timesExecuted).toBe(2);
    // Templates without factory executions read thin — zero, honestly.
    const lit = counted.find((t) => t.templateId === 'TPL-LIT-002');
    expect(lit?.timesExecuted).toBe(0);
  });

  it('resolves the seeded library under the demo door (DEMO DATA disclosed)', async () => {
    const previous = process.env.DON_DEV_SEED;
    process.env.DON_DEV_SEED = '1';
    try {
      const { demo, records } = await resolveMasterTemplates();
      expect(demo).toBe(true);
      expect(records).toEqual(MASTER_TEMPLATE_LIBRARY);
      const aud = records.find((t) => t.templateId === 'TPL-AUD-001');
      expect(aud?.timesExecuted).toBe(1420);
    } finally {
      if (previous === undefined) delete process.env.DON_DEV_SEED;
      else process.env.DON_DEV_SEED = previous;
    }
  });
});
