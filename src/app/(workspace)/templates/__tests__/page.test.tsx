/**
 * /templates — the Covnant Control Board render test (founder directive,
 * 2026-09-20). The page renders for real (renderToStaticMarkup) against the
 * LIVE store in dev-seed mode — no mocks, the same path the e2e harness and
 * preview use. Pins the directive: the 'Covnant Control Board' header +
 * 'Atomic Entity Clearing & Real-Time Telemetry Matrix' sub-header, ZERO
 * instances of the word 'Sovereign' anywhere in the rendered view, isolated
 * per-class entity pills, the domain telemetry bindings (drop-5 canon
 * values read from the store, never inline literals), the 50/35/15 split
 * badges, and metric-based telemetry retained on sectors without an entity
 * class.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootDevSeedStore } from '@/lib/server/devSeed';

beforeAll(async () => {
  // The dev-seed boot — deterministic seeded data through the real engines.
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
});

async function renderTemplatesPage(category?: string): Promise<string> {
  const TemplatesPage = (await import('../page')).default;
  const searchParams = category
    ? Promise.resolve({ category })
    : Promise.resolve({});
  return renderToStaticMarkup(await TemplatesPage({ searchParams }));
}

describe('/templates — the Covnant Control Board', () => {
  it('renders the Control Board header and the Atomic Entity Clearing sub-header', async () => {
    const html = await renderTemplatesPage();
    expect(html).toContain('data-testid="control-board-title"');
    expect(html).toContain('Covnant Control Board');
    expect(html).toContain('Atomic Entity Clearing &amp; Real-Time Telemetry Matrix');
  });

  it('renders ZERO instances of the word Sovereign across the whole view', async () => {
    const html = await renderTemplatesPage();
    expect(html.match(/[Ss]overeign/g)).toBeNull();
  });

  it('renders the isolated entity pills — one per class, never bundled', async () => {
    const html = await renderTemplatesPage();
    for (const tag of ['MUSIC', 'FILM', 'TV', 'PODCASTING', 'LIVE', 'PUBLISHING']) {
      expect(html.match(new RegExp(`data-entity-class="${tag}"`, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(1);
    }
  });

  it('binds the canonical Music card with the drop-5 telemetry read from the store', async () => {
    const html = await renderTemplatesPage();
    expect(html).toContain('ISRC code');
    expect(html).toContain('US-S1Z-26-00001');
    expect(html).toContain('0.0035');
    expect(html).toContain('ASCAP');
    expect(html).toContain('Sub-second micro royalty rate');
    expect(html).toContain('PRO telemetry binding');
    // Execution telemetry rides the store engine, not component literals.
    expect(html).toContain('$125,000.00 · CLEARED');
  });

  it('binds the film card with ISAN, theatrical gross escrow, and studio overlay', async () => {
    const html = await renderTemplatesPage();
    expect(html).toContain('ISAN code');
    expect(html).toContain('0003-1A2F-9C4B-0002-W');
    expect(html).toContain('$4,250,000.00');
    expect(html).toContain('Studio overlay');
    expect(html).toContain('ENGAGED');
  });

  it('keeps the 50/35/15 split badges on every card', async () => {
    const html = await renderTemplatesPage();
    expect(html).toContain('Ownership reserve 50%');
    expect(html).toContain('Creative payout 35%');
    expect(html).toContain('Operations yield 15%');
  });

  it('keeps metric-based telemetry on sectors without an entity class', async () => {
    const html = await renderTemplatesPage();
    // The FILM atomic record's metric display survives alongside entity telemetry.
    expect(html).toContain('Box Office Gross Receipts and ISAN Telemetry');
    // An unbound sector's metric (gaming) still renders.
    expect(html).toContain('Player Session Hours and In-Game Purchase Volume');
  });

  it('renders the deep-linked vertical view with the same branding and no Sovereign', async () => {
    const html = await renderTemplatesPage('AUDIO_AND_RECORDED_SOUND');
    expect(html).toContain('Covnant Control Board');
    expect(html).toContain('Atomic Entity Clearing &amp; Real-Time Telemetry Matrix');
    expect(html.match(/[Ss]overeign/g)).toBeNull();
    // Single-vertical board state — the Audio vertical carries the MUSIC and
    // PODCASTING atomic records and no FILM telemetry.
    expect(html).toContain('data-entity-class="MUSIC"');
    expect(html).toContain('data-entity-class="PODCASTING"');
    expect(html).not.toContain('data-entity-class="FILM"');
  });
});
