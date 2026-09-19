/**
 * /sync-license composition test — renders against the LIVE resolver and
 * the real SDK enumeration in dev-seed mode (no mocks). Pins the seeded
 * library states: Midnight Clear and Gold Hours PRE-CLEARED with their
 * real fee floors ($4,950.00 / $3,200.00) and Crown Ledger honestly
 * PENDING PRE-CLEARANCE (a registered CBT asset with no catalog row), the
 * registration form offering the unsubmitted work, the locked 50/35/15
 * note, and the F-refinement: no dev warning banner.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootDevSeedStore } from '@/lib/server/devSeed';

beforeAll(async () => {
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
});

async function renderSyncLicensePage(): Promise<string> {
  const SyncLicensePage = (await import('../page')).default;
  return renderToStaticMarkup(await SyncLicensePage());
}

describe('/sync-license — the Sync Library', () => {
  it('exports the browser title — Sync License — Covnant', async () => {
    const page = await import('../page');
    expect(page.metadata).toEqual({
      title: 'Sync License — Covnant',
      description: expect.stringContaining('Sync Library'),
    });
  });

  it('renders the pre-cleared works with their real fee floors', async () => {
    const html = await renderSyncLicensePage();
    expect(html).toContain('data-testid="sync-library"');
    expect(html).toContain('Midnight Clear');
    expect(html).toContain('data-testid="sync-fee-floor"');
    expect(html).toContain('$4,950.00 minimum');
    expect(html).toContain('Gold Hours');
    expect(html).toContain('$3,200.00 minimum');
    expect(html).toContain('data-testid="sync-state-pre-cleared"');
  });

  it('renders the unsubmitted work as honestly pending pre-clearance', async () => {
    const html = await renderSyncLicensePage();
    expect(html).toContain('Crown Ledger');
    expect(html).toContain('data-testid="sync-state-pending"');
    expect(html).toContain('Pending pre-clearance');
    // The pending row never renders a fee floor — scope to that row alone.
    const pendingRow = html.split('data-state="pending"')[1] ?? '';
    const pendingOnly = pendingRow.split('data-state="pre-cleared"')[0] ?? '';
    expect(pendingOnly).not.toContain('minimum');
  });

  it('renders the registration form wired to the locked split note', async () => {
    const html = await renderSyncLicensePage();
    expect(html).toContain('data-testid="sync-license-form"');
    expect(html).toContain('data-testid="sync-asset-select"');
    expect(html).toContain('Crown Ledger');
    expect(html).toContain('data-testid="sync-fee-input"');
    expect(html).toContain('data-testid="sync-submit"');
    expect(html).toContain('data-testid="sync-splits-note"');
    expect(html).toContain('50% ownership');
  });

  it('carries the F-refinement — no dev warning banner — plus the demo marker', async () => {
    const html = await renderSyncLicensePage();
    expect(html).not.toContain('data-testid="dev-warning"');
    expect(html).toContain('data-testid="demo-data-badge"');
    expect(html).toContain('data-testid="admin-console-link"');
    expect(html).not.toContain('Nova Reign');
  });
});
