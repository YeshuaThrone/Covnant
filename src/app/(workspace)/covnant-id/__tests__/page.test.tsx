/**
 * /covnant-id composition test — renders against the LIVE resolver in
 * dev-seed mode (no mocks — the same path the preview uses). Pins the
 * identity facts from the store read: the seeded persona's UCT, ISNI
 * ("Not linked" — the seed carries none), KYC and provisioning states —
 * with the DEMO DATA marker and the page-header ADMIN pill, and nothing
 * invented (no issuance date, no fabricated ISNI).
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootDevSeedStore } from '@/lib/server/devSeed';

beforeAll(async () => {
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
});

async function renderCovnantIdPage(): Promise<string> {
  const CovnantIdPage = (await import('../page')).default;
  return renderToStaticMarkup(await CovnantIdPage());
}

describe('/covnant-id — the identity surface', () => {
  it('exports the browser title — Covnant ID — Covnant', async () => {
    const page = await import('../page');
    expect(page.metadata).toEqual({
      title: 'Covnant ID — Covnant',
      description: expect.stringContaining('Universal Covnant Tag'),
    });
  });

  it('renders the seeded persona with the DEMO DATA marker and the ADMIN pill', async () => {
    const html = await renderCovnantIdPage();
    expect(html).toContain('data-testid="covnant-id-header"');
    expect(html).toContain('data-testid="demo-data-badge"');
    expect((html.match(/data-testid="demo-data-badge"/g) ?? []).length).toBe(1);
    expect(html).toContain('data-testid="admin-console-link"');
    expect(html).toContain('href="/admin"');
    expect(html).toContain('Yeshua Throne');
    expect(html).not.toContain('Nova Reign');
  });

  it('renders the real UCT, ISNI state, KYC, and provisioning from the store read', async () => {
    const html = await renderCovnantIdPage();
    // The seeded UCT — verified by the devSeed test against the store.
    expect(html).toContain('UCT-US-2026-8C4F1E7A-A9');
    expect(html).toContain('data-testid="identity-uct"');
    // The seed carries no ISNI — the honest empty state, never a fake ID.
    expect(html).toContain('data-testid="identity-isni"');
    expect(html).toContain('Not linked');
    expect(html).toContain('data-testid="identity-facts"');
    expect(html).toContain('APPROVED');
    expect(html).toContain('PROVISIONED');
  });

  it('renders no fabricated issuance date', async () => {
    const html = await renderCovnantIdPage();
    // No "Issued on …" phrasing and no date-shaped issuance strings — the
    // store carries no issuance date to render.
    expect(html).not.toContain('Issued on');
    expect(html).not.toMatch(/\b(19|20)\d{2}-\d{2}-\d{2}\b/);
  });
});
