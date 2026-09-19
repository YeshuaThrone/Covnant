/**
 * /settings composition test — the fiat-only rebuild (G-directive). Pins
 * the real account facts (stage name, UCT, KYC, provisioning, payout link
 * state), the fiat-only USD currency section with no selector, the honest
 * notifications/security disclosures, and the demo marker — with no form
 * and no browser-local preference storage anywhere on the surface.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootDevSeedStore } from '@/lib/server/devSeed';

beforeAll(async () => {
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
});

async function renderSettingsPage(): Promise<string> {
  const SettingsPage = (await import('../page')).default;
  return renderToStaticMarkup(await SettingsPage());
}

describe('/settings — the fiat-only rebuild', () => {
  it('exports the browser title — Settings — Covnant', async () => {
    const page = await import('../page');
    expect(page.metadata).toEqual({
      title: 'Settings — Covnant',
      description: expect.stringContaining('fiat-only'),
    });
  });

  it('renders the real profile facts from the seeded session', async () => {
    const html = await renderSettingsPage();
    expect(html).toContain('data-testid="settings-profile"');
    expect(html).toContain('data-testid="settings-stage-name"');
    expect(html).toContain('Yeshua Throne');
    expect(html).not.toContain('Nova Reign');
    expect(html).toContain('UCT-US-2026-8C4F1E7A-A9');
    expect(html).toContain('data-testid="settings-kyc"');
    expect(html).toContain('data-testid="settings-provisioning"');
  });

  it('renders the real payout-account link state', async () => {
    const html = await renderSettingsPage();
    expect(html).toContain('data-testid="settings-payouts"');
    expect(html).toContain('data-testid="settings-bank-status"');
    // The seeded persona's bank account is linked (dashboard readiness pins
    // bank COMPLETE from the same field).
    expect(html).toContain('Linked');
  });

  it('renders fiat-only USD with no currency selector', async () => {
    const html = await renderSettingsPage();
    expect(html).toContain('data-testid="settings-currency-value"');
    expect(html).toContain('USD');
    expect(html).toContain('fiat only');
    // The old localStorage currency selector is gone entirely.
    expect(html).not.toContain('data-testid="display-currency"');
    expect(html).not.toContain('covnant.settings.v1');
  });

  it('renders honest disclosures for notifications and security — no fake toggles', async () => {
    const html = await renderSettingsPage();
    expect(html).toContain('data-testid="settings-notifications-note"');
    expect(html).toContain('not available yet');
    expect(html).toContain('data-testid="settings-security-note"');
    // No forms, no toggles — nothing pretends to save.
    expect(html).not.toContain('<form');
  });

  it('carries the DEMO DATA marker and the ADMIN pill', async () => {
    const html = await renderSettingsPage();
    expect(html).toContain('data-testid="demo-data-badge"');
    expect(html).toContain('data-testid="admin-console-link"');
    expect(html).toContain('href="/admin"');
  });
});
