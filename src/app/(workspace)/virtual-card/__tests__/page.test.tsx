/**
 * /virtual-card composition test — renders against the LIVE resolver in
 * dev-seed mode (no mocks). Pins the physical GoldNote structure: the
 * 1.586:1 brushed-gold face (aspect-ratio + BRUSHED_GOLD marker), the EMV
 * chip, the masked pending number, the holder identity, the
 * SOVEREIGN_NETWORK badge as the ONLY network mark, disabled wallet +
 * copy actions, the real store-read balance in the details panel, pending
 * expiry/CVC/ZIP (never fabricated), the additional-payment disclosure,
 * and the Transactions & History row.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootDevSeedStore } from '@/lib/server/devSeed';

beforeAll(async () => {
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
});

async function renderVirtualCardPage(): Promise<string> {
  const VirtualCardPage = (await import('../page')).default;
  return renderToStaticMarkup(await VirtualCardPage());
}

describe('/virtual-card — the GoldNote surface', () => {
  it('exports the browser title — Virtual Card — Covnant', async () => {
    const page = await import('../page');
    expect(page.metadata).toEqual({
      title: 'Virtual Card — Covnant',
      description: expect.stringContaining('GoldNote'),
    });
  });

  it('renders the physical card face — ratio marker, chip, masked number, holder, network badge', async () => {
    const html = await renderVirtualCardPage();
    expect(html).toContain('data-testid="goldnote-card"');
    expect(html).toContain('data-card-style="BRUSHED_GOLD"');
    expect(html).toContain('1.586');
    expect(html).toContain('data-testid="goldnote-chip"');
    expect(html).toContain('data-testid="goldnote-number"');
    expect(html).toContain('•••• •••• •••• ••••');
    expect(html).toContain('data-testid="goldnote-holder"');
    // Source casing — uppercase is applied by CSS, not in the markup.
    expect(html).toContain('Yeshua Throne');
    expect(html).toContain('data-testid="goldnote-badge-network"');
    expect(html).toContain('SOVEREIGN_NETWORK');
    // No third-party network branding ON THE FACE — the About panel may
    // honestly say the card is not a Visa or Mastercard product.
    const face = html.split('data-testid="goldnote-card"')[1]?.split('data-testid="goldnote-wallet-apple"')[0] ?? '';
    expect(face).not.toMatch(/visa|mastercard/i);
  });

  it('renders the real seeded available balance in the details panel', async () => {
    const html = await renderVirtualCardPage();
    expect(html).toContain('data-testid="goldnote-balance"');
    expect(html).toContain('$3,300,000.00');
  });

  it('renders pending financial details and disabled wallet/copy actions', async () => {
    const html = await renderVirtualCardPage();
    expect(html).toContain('data-testid="goldnote-details-expiry"');
    expect(html).toContain('Pending');
    expect(html).toContain('data-testid="goldnote-details-cvc"');
    expect(html).toContain('data-testid="goldnote-details-zip"');
    expect(html).toContain('data-testid="goldnote-details-name"');
    // Wallet + copy affordances exist but stay disabled — nothing to copy.
    expect(html).toContain('data-testid="goldnote-wallet-apple"');
    expect(html).toContain('data-testid="goldnote-wallet-google"');
    expect(html).toContain('data-testid="goldnote-copy-number"');
    expect((html.match(/disabled/g) ?? []).length).toBeGreaterThanOrEqual(3);
    // The honest not-provisioned note rides beneath the actions.
    expect(html).toContain('data-testid="goldnote-wallet-note"');
  });

  it('renders the additional-payment disclosure and the ledger link — no fake account numbers', async () => {
    const html = await renderVirtualCardPage();
    expect(html).toContain('data-testid="goldnote-additional-payment"');
    expect(html).toContain('data-testid="goldnote-transactions-link"');
    expect(html).toContain('href="/ledger"');
    // No account/routing number shapes anywhere.
    expect(html).not.toMatch(/\b\d{9,12}\b/);
  });

  it('carries the DEMO DATA marker and the seeded persona — no Nova Reign', async () => {
    const html = await renderVirtualCardPage();
    expect(html).toContain('data-testid="demo-data-badge"');
    expect(html).toContain('data-testid="admin-console-link"');
    expect(html).not.toContain('Nova Reign');
  });
});
