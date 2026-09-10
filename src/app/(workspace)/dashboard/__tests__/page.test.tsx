/**
 * /dashboard composition test — The Don home renders for real
 * (renderToStaticMarkup) against the fixtures provider, no mocks: the
 * page is a pure composition over DashboardDataProvider. Pins the
 * reference IA element-for-element — THE DON wordmark, greeting + avatar
 * chip, three vault-bucket cards with right-aligned balances, carousel
 * dots, View all → /ledger, payout rail tiles (RTP instant, ACH +3
 * business days), quick actions on real routes only, dense transaction
 * rows with debit/credit pairs + See more, the readiness panel — plus
 * the brand rails: browser title, no blue palette, no fabricated
 * identity (no UCT, no account numbers).
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

async function renderDashboardPage(): Promise<string> {
  const DashboardPage = (await import('../page')).default;
  return renderToStaticMarkup(await DashboardPage());
}

describe('/dashboard — The Don composition', () => {
  it('exports the browser title — The Don — Covnant', async () => {
    const page = await import('../page');
    expect(page.metadata).toEqual({
      title: 'The Don — Covnant',
      description: expect.stringContaining('The Don'),
    });
  });

  it('renders the page-header THE DON wordmark and the greeting + avatar chip', async () => {
    const html = await renderDashboardPage();
    expect(html).toContain('data-testid="don-wordmark"');
    expect(html).toContain('THE DON');
    expect(html).toContain('data-testid="greeting"');
    expect(html).toContain('Hi,');
    expect(html).toContain('Nova Reign'); // the fixture holder's stage name
    expect(html).toContain('data-testid="avatar-chip"');
    expect(html).toContain('NR'); // initials in the chip
  });

  it('renders the Accounts section with three vault-bucket cards', async () => {
    const html = await renderDashboardPage();
    expect(html).toContain('Accounts');
    expect(html).toContain('data-testid="accounts-row"');
    expect((html.match(/data-testid="vault-bucket-card"/g) ?? []).length).toBe(3);
    // The three cards ARE the three buckets — available / pending / reserve.
    expect(html).toContain('Available');
    expect(html).toContain('Pending');
    expect(html).toContain('Reserve');
    // Fixture balances, exact from integer cents.
    expect(html).toContain('$2,478.30');
    expect(html).toContain('$912.05');
    expect(html).toContain('$450.00');
  });

  it('right-aligns the balance inside each card (bank-reference layout)', async () => {
    const html = await renderDashboardPage();
    const cards = html.split('data-testid="vault-bucket-card"').slice(1);
    expect(cards.length).toBe(3);
    for (const card of cards) {
      // The balance row is right-aligned; the sublabel sits under it.
      expect(card).toContain('text-right');
    }
  });

  it('wires View all to the Ownership Ledger and renders three carousel dots', async () => {
    const html = await renderDashboardPage();
    expect(html).toContain('data-testid="accounts-view-all"');
    expect(html).toContain('href="/ledger"');
    expect(html).toContain('data-testid="carousel-dots"');
    expect((html.match(/role="tab"/g) ?? []).length).toBe(3);
  });

  it('renders payout tiles on the sandbox rail — RTP instant, ACH +3 business days', async () => {
    const html = await renderDashboardPage();
    expect(html).toContain('data-testid="payout-tile"');
    expect(html).toContain('RTP');
    expect(html).toContain('ACH');
    expect(html).toContain('Instant');
    expect(html).toContain('+3 business days');
    expect(html).toContain('$250.00'); // RTP in-flight hold
    expect(html).toContain('$1,200.00'); // ACH in-flight hold
  });

  it('renders compact square quick actions on real routes only', async () => {
    const html = await renderDashboardPage();
    expect(html).toContain('data-testid="quick-action"');
    expect(html).toContain('href="/assets"');
    expect(html).toContain('href="/contracts"');
    expect(html).toContain('href="/ledger"');
    // No invented routes — every action href stays inside the workspace nav.
    const hrefs = [...html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
    for (const href of hrefs) {
      expect(
        ['/dashboard', '/ledger', '/assets', '/contracts'].some((allowed) => href.startsWith(allowed)),
        `invented route in a quick action: ${href}`,
      ).toBe(true);
    }
  });

  it('renders the dense transactions card with debit/credit pairs and See more', async () => {
    const html = await renderDashboardPage();
    expect(html).toContain('Transactions');
    expect((html.match(/data-testid="transaction-row"/g) ?? []).length).toBe(6); // visible rows
    // Pair lines as the GL stores them: DR / CR with exactly one live side.
    expect(html).toContain('DR $0.00 / CR $129.90');
    expect(html).toContain('+$129.90'); // inflow signed positive
    expect(html).toContain('−$250.00'); // payout hold signed negative
    expect(html).toContain('data-testid="see-more"');
    expect(html).toContain('href="/ledger"');
  });

  it('renders the quiet readiness side panel with text-labeled states', async () => {
    const html = await renderDashboardPage();
    expect(html).toContain('Readiness');
    expect(html).toContain('data-testid="readiness-row"');
    expect(html).toContain('Identity verified');
    expect(html).toContain('Provisioning complete');
  });

  it('never fabricates identity or account details — no UCT, no account numbers', async () => {
    const html = await renderDashboardPage();
    expect(html).not.toContain('UCT-');
    expect(html).not.toContain('accountNumber');
    expect(html).not.toContain('routingNumber');
  });

  it('keeps the Covnant brand rails — no blue palette anywhere', async () => {
    const html = await renderDashboardPage();
    expect(html).not.toMatch(/blue-\d{3}/);
    expect(html).not.toContain('#0000FF');
  });
});
