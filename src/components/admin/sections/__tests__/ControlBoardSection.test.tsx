/**
 * ControlBoardSection — the console's Control Board render test (founder
 * directive, 2026-09-20). The section mounts the EXACT TemplatesControlBoard
 * the /templates page renders, over the same master-store seam the /admin
 * page composes. Asserted against the LIVE dev-seed store — no mocks: the
 * section mounts fully populated (no empty states), carries the DEMO DATA
 * disclosure, and every card is store-bound (canon drop-5 telemetry, the
 * 50/35/15 split badges, isolated entity pills) — never literals, and the
 * Control Board branding law (zero 'Sovereign' copy) holds.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootDevSeedStore } from '@/lib/server/devSeed';
import {
  atomicRecordsForCategory,
  bindAtomicEntity,
  bindFactoryEntity,
  executionTelemetryFor,
  masterTemplatesForCategory,
  resolveAtomicRegistry,
  resolveMasterTemplates,
} from '@/lib/master/masterStore';
import { MASTER_CATEGORY_ORDER } from '@/lib/master/taxonomy';
import type { ControlBoardState } from '@/lib/master/controlBoard';
import { ControlBoardSection } from '../ControlBoardSection';

beforeAll(async () => {
  // The dev-seed boot — deterministic seeded data through the real engines.
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
});

/** The /admin page's server seam, verbatim — the same store path. */
async function buildBoard(): Promise<ControlBoardState> {
  const { demo, records } = await resolveMasterTemplates();
  const { records: atomicRecords } = await resolveAtomicRegistry();
  return {
    demo,
    active: null,
    verticals: [...MASTER_CATEGORY_ORDER].map((vertical) => ({
      vertical,
      factoryTemplates: masterTemplatesForCategory(records, vertical).map((record) => ({
        record,
        entity: bindFactoryEntity(record),
        execution: executionTelemetryFor(record.templateId),
      })),
      atomicRecords: atomicRecordsForCategory(atomicRecords, vertical).map((record) => ({
        record,
        entity: bindAtomicEntity(record),
        execution: executionTelemetryFor(record.templateId),
      })),
    })),
  };
}

async function renderSection(): Promise<string> {
  return renderToStaticMarkup(<ControlBoardSection board={await buildBoard()} />);
}

describe('the /admin Control Board section', () => {
  it('mounts the section shell with the demo disclosure and store-derived counts', async () => {
    const board = await buildBoard();
    const html = await renderSection();

    expect(html).toContain('aria-label="Control Board"');
    expect(html).toContain('Covnant Control Board');
    expect(html).toContain('data-testid="demo-data-badge"');

    // The blurb's library counts are the store's numbers, not literals.
    const factoryCount = board.verticals.reduce(
      (total, vertical) => total + vertical.factoryTemplates.length,
      0,
    );
    const atomicCount = board.verticals.reduce(
      (total, vertical) => total + vertical.atomicRecords.length,
      0,
    );
    expect(html).toContain(`${factoryCount} contract`);
    expect(html).toContain(`${atomicCount} atomic sector records`);
  });

  it('renders the reused board — six vertical tabs, entity pills, split badges', async () => {
    const html = await renderSection();

    // The board mounts in its all-verticals initial view — fully populated.
    expect((html.match(/data-testid="vertical-tab"/g) ?? []).length).toBe(6);
    for (const tag of ['MUSIC', 'FILM', 'TV', 'PODCASTING', 'LIVE', 'PUBLISHING']) {
      expect(
        html.match(new RegExp(`data-entity-class="${tag}"`, 'g'))?.length ?? 0,
      ).toBeGreaterThanOrEqual(1);
    }

    // Drop-5 canon values, bound from the store engine — never inline literals.
    expect(html).toContain('US-S1Z-26-00001');
    expect(html).toContain('ASCAP');
    expect(html).toContain('Ownership reserve 50%');
    expect(html).toContain('Creative payout 35%');
    expect(html).toContain('Operations yield 15%');

    // The Control Board branding law holds in the console too.
    expect(html.match(/[Ss]overeign/g)).toBeNull();
  });
});
