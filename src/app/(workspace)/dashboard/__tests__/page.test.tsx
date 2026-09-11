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

  it('renders the Accounts section with the three vault-bucket cards', async () => {
    const html = await renderDashboardPage();
    expect(html).toContain('Accounts');
    expect(html).toContain('data-testid="accounts-row"');
    // The three cards ARE the three buckets — available / pending / reserve.
    expect(html).toContain('data-testid="account-card-available"');
    expect(html).toContain('data-testid="account-card-pending"');
    expect(html).toContain('data-testid="account-card-reserve"');
    expect((html.match(/data-testid="account-card-(available|pending|reserve)"/g) ?? []).length).toBe(3);
    expect(html).toContain('Available');
    expect(html).toContain('Pending');
    expect(html).toContain('Reserve');
    // Fixture balances, exact from integer cents.
    expect(html).toContain('$2,478.30');
    expect(html).toContain('$912.05');
    expect(html).toContain('$450.00');
  });

  it('right-aligns each balance with its sublabel beneath (bank-reference layout)', async () => {
    const html = await renderDashboardPage();
    for (const bucket of ['available', 'pending', 'reserve']) {
      const balance = html.split(`data-testid="account-card-${bucket}-balance"`)[1] ?? '';
      expect(balance, `${bucket} balance must be right-aligned`).toContain('text-right');
      // The sublabel is the next paragraph after the balance.
      expect(balance).toMatch(
        /Spendable now|Awaiting release or settlement|Held — disputes &amp; withholding/,
      );
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
    expect(html).toContain('data-testid="payout-tiles"');
    expect((html.match(/data-testid="payout-tile"/g) ?? []).length).toBe(2);
    expect(html).toContain('data-rail="rtp"');
    expect(html).toContain('data-rail="ach"');
    expect(html).toContain('RTP · Instant');
    expect(html).toContain('ACH · +3 business days');
    expect(html).toContain('$250.00'); // RTP in-flight hold
    expect(html).toContain('$1,200.00'); // ACH in-flight hold
  });

  it('renders compact square quick actions on real routes only', async () => {
    const html = await renderDashboardPage();
    expect(html).toContain('data-testid="quick-actions"');
    expect((html.match(/data-testid="quick-action"/g) ?? []).length).toBe(3);
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
    expect((html.match(/data-testid="transactions-row"/g) ?? []).length).toBe(6); // visible of 7
    // Pair lines as the GL stores them: DR / CR with exactly one live side.
    expect(html).toContain('DR $0.00 / CR $129.90'); // fx_j_001 royalty ingest
    expect(html).toContain('DR $250.00 / CR $0.00'); // payout legs
    expect(html).toContain('+$129.90'); // inflow signed positive
    expect(html).toContain('−$250.00'); // payout displayed as outflow
    expect(html).toContain('data-testid="transactions-see-more"');
    expect(html).toContain('href="/ledger"');
  });

  it('renders the quiet readiness side panel with text-labeled states', async () => {
    const html = await renderDashboardPage();
    expect(html).toContain('Financial readiness');
    expect(html).toContain('data-testid="readiness-kyc"');
    expect(html).toContain('data-testid="readiness-tax"');
    expect(html).toContain('data-testid="readiness-bank"');
    expect(html).toContain('data-testid="readiness-provisioning"');
    // Fixture states: KYC approved and provisioning complete — labeled in
    // text, never color-only.
    expect(html).toContain('COMPLETE');
    expect(html).not.toContain('TODO');
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
