/**
 * IntelligenceSection — the per-entity readout's render suite. Pins the
 * four surfaces per the no-empty-states canon (performance profile,
 * cleared-flow trend, cohort benchmark, valuation vs. production) and the
 * honest states: the zero-cleared line (never an empty block), the cohort
 * of one stated plainly ("Rank 1 of 1"), the fail-closed unavailable copy,
 * and the demo-data disclosure. The no-literal pin proves every money
 * figure on the page is the formatter's output over the store figures the
 * props carry — nothing fabricated. The counterparty boundary is pinned
 * from BOTH sides: the sponsorship profile renders its brandPartner (the
 * entity-level fact that belongs here) while the AnalyticsSection suite
 * pins its absence from the platform cuts — untouched by this suite.
 * The live dev-seed case renders the REAL derivation over the REAL seeded
 * store — structurally pinned only, because the demo journal histories
 * are a parallel workstream's surface.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import type {
  AthleteContractIntelligence,
  EntityIntelligence,
  FilmIntelligence,
  MusicIntelligence,
  SponsorshipDealIntelligence,
} from '@/lib/admin/entityIntelligence';
import {
  EntityIntelligenceProfile,
  formatCentsBigintSigned,
  formatUsdWholeBigint,
  groupInteger,
  IntelligenceSection,
  rosterGroups,
  trendBarWidth,
} from '../IntelligenceSection';

describe('trendBarWidth — the trend bar-width derivation', () => {
  it('charts each point against the trend peak — integer percent, bigint math', () => {
    // 100,000,000 against a 100,000,000 peak → 100%; a quarter of the peak → 25%.
    expect(trendBarWidth(100_000_000n, 100_000_000n)).toBe(100);
    expect(trendBarWidth(25_000_000n, 100_000_000n)).toBe(25);
    // Truncating integer division: 1 of 3 → 33%, not 33.33.
    expect(trendBarWidth(1n, 3n)).toBe(33);
  });

  it('floors a nonzero point at a 1% sliver so small moments stay on the chart', () => {
    // 1 of 299,000,000 truncates to 0 — the sliver keeps it visible.
    expect(trendBarWidth(1n, 299_000_000n)).toBe(1);
  });

  it('renders nothing for empty math — never a fabricated width', () => {
    expect(trendBarWidth(0n, 0n)).toBe(0);
    expect(trendBarWidth(5n, 0n)).toBe(0);
    expect(trendBarWidth(0n, 100n)).toBe(0);
  });
});

describe('formatCentsBigintSigned — the signed bigint-cents voice', () => {
  it('carries a plus for gains, the true minus for shortfalls, no sign on zero', () => {
    expect(formatCentsBigintSigned(855_000_000n)).toBe('+$8,550,000.00');
    expect(formatCentsBigintSigned(-115_000_000n)).toBe('−$1,150,000.00');
    expect(formatCentsBigintSigned(0n)).toBe('$0.00');
  });
});

describe('formatUsdWholeBigint — the canon USD alignment', () => {
  it('aligns whole USD to ledger cents exactly (×100 bigint) — never a float', () => {
    expect(formatUsdWholeBigint(2_400_000n)).toBe('$2,400,000.00');
    expect(formatUsdWholeBigint(0n)).toBe('$0.00');
  });
});

describe('groupInteger — the count telemetry voice', () => {
  it('groups thousands deterministically and refuses non-integers', () => {
    expect(groupInteger(12_480)).toBe('12,480');
    expect(groupInteger(1_284_000)).toBe('1,284,000');
    expect(() => groupInteger(1.5)).toThrow(TypeError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — the derivation module's real arm shapes (entityIntelligence.ts),
// with figures standing in for what the store hands the page.
// ─────────────────────────────────────────────────────────────────────────────

const ATHLETE: AthleteContractIntelligence = {
  class: 'ATHLETE_CONTRACT',
  templateId: 'TPL-SPT-001',
  contractId: 'NK-404-BAL',
  sport: 'Basketball',
  endorsementExclusivityLock: true,
  promisedUSD: 2_400_000n,
  cleared: 125_000_000n,
  trend: [
    { at: '2026-09-11T15:00:00.000Z', credit: 100_000_000n },
    { at: '2026-08-11T15:00:00.000Z', credit: 25_000_000n },
  ],
  cohort: { rank: 1n, of: 2n },
};

const ATHLETE_TAIL: AthleteContractIntelligence = {
  ...ATHLETE,
  templateId: 'TPL-SPT-002',
  contractId: 'NK-405-ELA',
  promisedUSD: 1_800_000n,
  cleared: 25_000_000n,
  trend: [{ at: '2026-09-12T15:00:00.000Z', credit: 25_000_000n }],
  cohort: { rank: 2n, of: 2n },
};

const FILM_NEVER_CLEARED: FilmIntelligence = {
  class: 'FEATURE_FILM',
  templateId: 'TPL-FLM-005',
  isanCode: '0009-7A8D-6C1B-0008-J',
  studioOverlayActive: false,
  promisedUSD: 310_000n,
  cleared: 0n,
  trend: [],
  cohort: { rank: 1n, of: 1n },
};

const MUSIC_NO_PROMISED: MusicIntelligence = {
  class: 'MASTER_RECORDING',
  templateId: 'TPL-MUS-001',
  isrcCode: 'US-S1Z-26-00001',
  subSecondMicroRoyaltyRate: 0.0035,
  proTelemetryBinding: 'ASCAP',
  promisedUSD: null,
  cleared: 833_333_333_336n,
  trend: [{ at: '2026-09-06T14:00:00.000Z', credit: 833_333_333_336n }],
  cohort: { rank: 1n, of: 1n },
};

const SPONSOR: SponsorshipDealIntelligence = {
  class: 'SPONSORSHIP_DEAL',
  templateId: 'TPL-SPN-001',
  brandPartner: 'Nike',
  campaignId: 'SPN-2026-40',
  activationWindowLock: false,
  promisedUSD: 950_000n,
  cleared: 950_000_000n,
  trend: [{ at: '2026-09-15T15:00:00.000Z', credit: 950_000_000n }],
  cohort: { rank: 1n, of: 1n },
};

function renderProfile(readout: EntityIntelligence): string {
  return renderToStaticMarkup(<EntityIntelligenceProfile readout={readout} />);
}

/** Every money figure in the markup — the no-literal pin's extraction. The
 * currency/minus prefix is required so timestamp fragments (…00.000Z) can
 * never masquerade as figures. */
function moneyFigures(html: string): string[] {
  return html.match(/[−$]\$?[\d,]+\.\d{2}/g) ?? [];
}

describe('EntityIntelligenceProfile — the four reads, ready state', () => {
  const html = renderProfile(ATHLETE);

  it('renders all four surfaces with their stable testids', () => {
    expect(html).toContain('data-testid="intelligence-profile-telemetry"');
    expect(html).toContain('data-testid="intelligence-profile-trend"');
    expect(html).toContain('data-testid="intelligence-profile-cohort"');
    expect(html).toContain('data-testid="intelligence-profile-valuation"');
  });

  it('renders the class telemetry profile from the arm — verbatim, store-read', () => {
    expect(html).toContain('TPL-SPT-001');
    expect(html).toContain('Basketball');
    expect(html).toContain('NK-404-BAL');
    expect(html).toContain('Locked'); // the endorsement exclusivity lock
    expect(html).toContain('Sponsorship guarantee');
    expect(html).toContain('$2,400,000.00'); // formatUsdWholeBigint(promisedUSD)
  });

  it('renders the cleared-flow trend as gold bars in the house strip language', () => {
    expect(html).toContain('bg-slate-700/50');
    expect(html).toContain('from-gold-champagne/80 to-gold/60');
    // Two points, each a bar — newest first (the derivation's order).
    expect((html.match(/data-testid="intelligence-trend-bar"/g) ?? []).length).toBe(2);
    // Peak-relative widths: the newest point IS the peak (100%), the older is 25%.
    expect(html).toContain('style="width:100%"');
    expect(html).toContain('style="width:25%"');
    expect(html.indexOf('style="width:100%"')).toBeLessThan(html.indexOf('style="width:25%"'));
    // Every point renders its exact formatted credit — never a rounded float.
    expect(html).toContain('$1,000,000.00');
    expect(html).toContain('$250,000.00');
    expect(html).toContain('2026-09-11T15:00:00.000Z');
  });

  it('renders the cohort rank as "rank r of n" — integer, never a float percentage', () => {
    expect(html).toContain('data-testid="intelligence-cohort-rank"');
    expect(html).toContain('Rank 1 of 2');
  });

  it('renders the promised-vs-cleared valuation with the exact delta — units aligned ×100 bigint', () => {
    expect(html).toContain('data-testid="intelligence-valuation-promised"');
    expect(html).toContain('$2,400,000.00'); // promised, whole USD at cents precision
    expect(html).toContain('$1,250,000.00'); // cleared, ledger cents
    // delta = cleared − promised×100 = 125,000,000 − 240,000,000 cents.
    expect(html).toContain('−$1,150,000.00');
    expect(html).toContain('$1,150,000.00 below the promised value.');
  });

  it('renders EVERY money figure from the props — the no-literal pin', () => {
    const allowed = new Set([
      '$2,400,000.00', // promised (telemetry + valuation)
      '$1,250,000.00', // cleared
      '$1,000,000.00', // trend peak point
      '$250,000.00', // trend older point
      '−$1,150,000.00', // delta row (signed)
      '$1,150,000.00', // delta magnitude in the verdict copy
    ]);
    for (const figure of moneyFigures(html)) {
      expect(allowed.has(figure)).toBe(true);
    }
    // And the impossible fabricated figure is nowhere.
    expect(html).not.toContain('$9,999.99');
  });
});

describe('EntityIntelligenceProfile — the entity-level counterparty fact', () => {
  it('renders the sponsorship brandPartner on the entity profile — where it belongs', () => {
    const html = renderProfile(SPONSOR);

    expect(html).toContain('Brand partner');
    expect(html).toContain('Nike');
    expect(html).toContain('SPN-2026-40');
  });
});

describe('EntityIntelligenceProfile — the honest off-happy-path states', () => {
  it('renders a never-cleared entity as the full telemetry profile, the zero-cleared line, and rank 1 of 1', () => {
    const html = renderProfile(FILM_NEVER_CLEARED);

    // The profile renders — telemetry, never an empty block.
    expect(html).toContain('TPL-FLM-005');
    expect(html).toContain('ISAN code');
    expect(html).toContain('0009-7A8D-6C1B-0008-J');
    // The honest zero-cleared line — no invented point at a fabricated timestamp.
    expect(html).toContain('data-testid="intelligence-trend-zero"');
    expect(html).toContain('Zero cleared to date');
    expect((html.match(/data-testid="intelligence-trend-bar"/g) ?? []).length).toBe(0);
    // The zero total renders as a real figure.
    expect(html).toContain('$0.00');
    // The cohort of one — stated, never hidden.
    expect(html).toContain('Rank 1 of 1');
  });

  it('renders the honest no-promised-value line for a class the canon leaves null — never a fabricated number', () => {
    const html = renderProfile(MUSIC_NO_PROMISED);

    expect(html).toContain('data-testid="intelligence-valuation-null"');
    expect(html).toContain('No promised value in canon for this class');
    expect(html).not.toContain('data-testid="intelligence-valuation-promised"');
    expect(html).not.toContain('data-testid="intelligence-valuation-delta"');
    // The cleared figure still renders — exact, past the float-safe range.
    expect(html).toContain('$8,333,333,333.36');
  });

  it('renders no money figure outside the props on the null-promised profile', () => {
    const html = renderProfile(MUSIC_NO_PROMISED);

    const allowed = new Set(['$8,333,333,333.36']);
    for (const figure of moneyFigures(html)) {
      expect(allowed.has(figure)).toBe(true);
    }
  });
});

describe('rosterGroups — the class-grouped, descending selector order', () => {
  it('groups by atomic class, descending by cleared within class, strongest class first', () => {
    const readouts: EntityIntelligence[] = [
      // Music's 833b out-clears the athlete group's 125m lead — music leads.
      MUSIC_NO_PROMISED,
      ATHLETE,
      ATHLETE_TAIL,
    ];
    const groups = rosterGroups(readouts);

    expect(groups.length).toBe(2);
    // Master recordings out-clear the athlete group — the music group leads.
    expect(groups[0]?.class).toBe('MASTER_RECORDING');
    expect(groups[0]?.entities[0]?.templateId).toBe('TPL-MUS-001');
    expect(groups[1]?.class).toBe('ATHLETE_CONTRACT');
    // Descending within the class: the 125m athlete precedes the 25m tail.
    expect(groups[1]?.entities.map((entity) => entity.templateId)).toEqual([
      'TPL-SPT-001',
      'TPL-SPT-002',
    ]);
  });

  it('keeps a zero-cleared entity on the roster — at its class tail, never dropped', () => {
    const groups = rosterGroups([FILM_NEVER_CLEARED, SPONSOR]);

    expect(groups.length).toBe(2);
    const filmGroup = groups.find((group) => group.class === 'FEATURE_FILM');
    expect(filmGroup?.entities.length).toBe(1);
    expect(filmGroup?.entities[0]?.cleared).toBe(0n);
    // The sponsorship group (950m) leads the zero-cleared film group.
    expect(groups[0]?.class).toBe('SPONSORSHIP_DEAL');
  });

  it('returns an empty roster for an empty readout list', () => {
    expect(rosterGroups([])).toEqual([]);
  });
});

function renderSection(
  intelligence: EntityIntelligence[],
  demo: boolean = true,
): string {
  return renderToStaticMarkup(
    <IntelligenceSection intelligence={{ kind: 'ready', value: intelligence }} demo={demo} />,
  );
}

describe('IntelligenceSection — the tab shell', () => {
  it('renders the selector class-grouped with descending options and opens on the roster leader', () => {
    const html = renderSection([ATHLETE, MUSIC_NO_PROMISED, ATHLETE_TAIL]);

    expect(html).toContain('data-testid="intelligence-entity-selector"');
    expect(html).toContain('data-testid="intelligence-selector"');
    // The optgroups carry the registered class vocabulary.
    expect(html).toContain('label="Master recordings"');
    expect(html).toContain('label="Athlete contracts"');
    // The roster leads with music (833b), then the athletes descending.
    const musicIndex = html.indexOf('value="TPL-MUS-001"');
    const athleteLead = html.indexOf('value="TPL-SPT-001"');
    const athleteTail = html.indexOf('value="TPL-SPT-002"');
    expect(musicIndex).toBeGreaterThan(-1);
    expect(athleteLead).toBeGreaterThan(-1);
    expect(athleteTail).toBeGreaterThan(athleteLead);
    // Opens on the roster leader — the music entity's profile, store-derived.
    expect(html).toContain('US-S1Z-26-00001');
    expect(html).toContain('ASCAP');
  });

  it('carries the demo-data badge only when the demo door is open', () => {
    expect(renderSection([ATHLETE], true)).toContain('data-testid="demo-data-badge"');
    expect(renderSection([ATHLETE], false)).not.toContain('data-testid="demo-data-badge"');
  });

  it('renders the honest roster-empty state when no entities registered — never a blank block', () => {
    const html = renderSection([]);

    expect(html).toContain('data-testid="intelligence-roster-empty"');
    expect(html).toContain('No registered entities to profile yet');
    expect(html).not.toContain('data-testid="intelligence-entity-selector"');
  });

  it('renders the fail-closed unavailable state — the same treatment as the platform cuts', () => {
    const html = renderToStaticMarkup(
      <IntelligenceSection
        intelligence={{
          kind: 'unavailable',
          code: 'intelligence_store_failed',
          message: 'Intelligence store read failed.',
        }}
        demo={true}
      />,
    );

    expect(html).toContain('data-testid="intelligence-unavailable"');
    expect(html).toContain('intelligence_store_failed');
    expect(html).toContain('Intelligence store read failed.');
    expect(html).not.toContain('data-testid="intelligence-entity-selector"');
  });
});

describe('IntelligenceSection — the live dev-seed render', () => {
  let html = '';

  beforeAll(async () => {
    // The dev-seed boot — the same store the analytics suite renders over.
    // Structurally pinned only: the seeded journal histories are the parallel
    // demo-seed workstream's surface, so no figure is pinned here.
    process.env.DON_DEV_SEED = '1';
    const { bootDevSeedStore, getSeededStore } = await import('@/lib/server/devSeed');
    const { seedAdminDemoDataIfEmpty } = await import('@/lib/admin/demoSeeds');
    const { entityIntelligence } = await import('@/lib/admin/entityIntelligence');
    const {
      bindAtomicEntity,
      bindFactoryEntity,
      resolveAtomicRegistry,
      resolveMasterTemplates,
    } = await import('@/lib/master/masterStore');
    await bootDevSeedStore();
    await seedAdminDemoDataIfEmpty();
    const store = await getSeededStore();
    const [{ records: atomicRecords }, { records: factoryRecords }] = await Promise.all([
      resolveAtomicRegistry(),
      resolveMasterTemplates(),
    ]);
    const identities = new Set<string>();
    const readouts: EntityIntelligence[] = [];
    const addEntity = async (templateId: string) => {
      if (identities.has(templateId)) return;
      identities.add(templateId);
      const readout = await entityIntelligence(templateId, store);
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
    html = renderSection(readouts, true);
  });

  it('renders a roster option for every registered entity — the full cleared universe', () => {
    // The 29 bound entity seeds of the atomic registry — additive expansion
    // updates this pin deliberately.
    expect((html.match(/<option /g) ?? []).length).toBe(29);
  });

  it('renders the four surfaces for the opened entity, with the demo disclosure', () => {
    expect(html).toContain('data-testid="intelligence-profile-telemetry"');
    expect(html).toContain('data-testid="intelligence-profile-trend"');
    expect(html).toContain('data-testid="intelligence-profile-cohort"');
    expect(html).toContain('data-testid="intelligence-profile-valuation"');
    expect(html).toContain('data-testid="demo-data-badge"');
    expect(html).toContain('data-testid="intelligence-cohort-rank"');
  });

  it('renders the roster class-grouped — the registered class vocabulary', () => {
    for (const label of [
      'Master recordings',
      'Feature films',
      'Linear TV',
      'Podcast networks',
      'Stage performances',
      'Literary works',
      'Athlete contracts',
      'Tournament events',
      'Esports streams',
      'Social channels',
      'Sponsorship deals',
    ]) {
      expect(html).toContain(`label="${label}"`);
    }
  });
});
