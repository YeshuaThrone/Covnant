/**
 * /catalog — the registered-assets render test. The page renders for real
 * (renderToStaticMarkup) against the LIVE store in dev-seed mode — the same
 * harness as the /templates render test, no mocks. Pinned here (data audit
 * #6 + #12):
 *
 * 1. Catalog pills render ONLY for identifiers of record — an unmapped
 *    ISWC/EIDR renders NO pill (no empty pill placeholder), and no pill
 *    value is ever the dash (the no-'—' placeholder canon).
 * 2. The seeded ISRC values render in their CANONICAL shape — the seeds
 *    canonicalize through the vault canonicalizer, so the page and the
 *    vault agree on identifier shape.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootDevSeedStore } from '@/lib/server/devSeed';

beforeAll(async () => {
  // The dev-seed boot — deterministic seeded data through the real engines.
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
});

async function renderCatalogPage(category?: string): Promise<string> {
  const CatalogPage = (await import('../page')).default;
  const searchParams = category
    ? Promise.resolve({ category })
    : Promise.resolve({});
  return renderToStaticMarkup(await CatalogPage({ searchParams }));
}

describe('/catalog — the registered assets grid', () => {
  it('renders registry cards with their CBT and ISRC pills', async () => {
    const html = await renderCatalogPage();
    expect(html).toContain('data-testid="catalog-card"');
    // The CBT pill — every registered asset carries its system of record.
    expect(html).toContain('>CBT</span>');
    // The ISRC pill — the seeded sheets map one.
    expect(html).toContain('>ISRC</span>');
  });

  it('renders NO pill for an unmapped identifier — no empty placeholders', async () => {
    const html = await renderCatalogPage();
    // No seed maps an ISWC or EIDR — their pills must not render at all
    // (the old page rendered them as dash placeholders).
    expect(html).not.toContain('>ISWC</span>');
    expect(html).not.toContain('>EIDR</span>');
  });

  it('never renders the dash as a pill value — the no-placeholder canon', async () => {
    const html = await renderCatalogPage();
    // A pill value span would render the dash between its own tags; body
    // copy (titles of record) carries em-dashes mid-text, not as a span.
    expect(html).not.toContain('>—</span>');
  });

  it('renders the seeded ISRCs in their canonical shape — seeds and registrations agree', async () => {
    const html = await renderCatalogPage();
    expect(html).toContain('USCVN2600001');
    expect(html).not.toContain('US-CVN-26-00001');
  });
});
