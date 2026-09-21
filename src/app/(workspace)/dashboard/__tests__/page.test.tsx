/**
 * /dashboard composition test — The Don home renders for real
 * (renderToStaticMarkup) against the LIVE resolver in dev-seed mode: the
 * store boots through the real engines (DON_DEV_SEED=1, no mocks — the
 * same path the e2e harness and preview use). Pins the Gold Board UI spec
 * (goldBoardUiSpec) element-for-element — THE DON wordmark, greeting +
 * avatar chip, three vault-bucket cards with right-aligned balances, the
 * REVENUE STREAMS strip (store-read, per goldBoardUiSpec — Quick Actions
 * are REMOVED), the ADMIN console pill in the page-header slot, carousel
 * dots, View all → /ledger, payout rail tiles (RTP instant, ACH +3
 * business days), dense transaction rows with debit/credit pairs + See
 * more, the readiness panel — plus the brand rails: browser title, no
 * blue palette, no fabricated identity (no UCT rendered, no account
 * numbers), and the seeded persona is Yeshua Throne.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { bootDevSeedStore } from '@/lib/server/devSeed';

beforeAll(async () => {
  // The dev-seed boot — deterministic seeded data through the real engines.
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
});

async function renderDashboardPage(): Promise<string> {
  const DashboardPage = (await import('../page')).default;
  return renderToStaticMarkup(await DashboardPage());
}

describe('/dashboard — The Don composition', () => {
  it('exports the browser title — Goldboard — Covnant', async () => {
    const page = await import('../page');
    expect(page.metadata).toEqual({
      title: 'Goldboard — Covnant',
      description: expect.stringContaining('The Don'),
    });
  });

  it('renders the page-header THE DON wordmark, the greeting + avatar chip, and the ADMIN pill', async () => {
    const html = await renderDashboardPage();
    expect(html).toContain('data-testid="don-wordmark"');
    expect(html).toContain('GOLD BOARD');
    // The dev-seed render IS the sessionless demo view — exactly ONE DEMO
    // DATA badge, opposite the wordmark, marks the seeded balances.
    expect(html).toContain('data-testid="demo-data-badge"');
    expect((html.match(/data-testid="demo-data-badge"/g) ?? []).length).toBe(1);
    // The gated administrator console rides the page-header slot (the
    // five-tab creator nav carries no Admin entry).
    expect(html).toContain('data-testid="admin-console-link"');
    expect(html).toContain('href="/admin"');
    expect(html).toContain('data-testid="greeting"');
    expect(html).toContain('Hi,');
    expect(html).toContain('Yeshua Throne'); // the seeded persona's name
    expect(html).not.toContain('Nova Reign');
    expect(html).toContain('data-testid="avatar-chip"');
    expect(html).toContain('YT'); // initials in the chip
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
    // The founder's seeded portfolio, EXACT from integer cents through the
    // real engine paths — never display strings: available 330_000_000
    // (net royalty proceeds minus settled and in-flight payouts), pending
    // 65_000_000 (two in-flight payout holds: 25M + 40M), reserve
    // 100_000_000_000 (24% backup withholding credited to the creator's
    // reserve bucket across five seeded UDR settlements).
    expect(html).toContain('$3,300,000.00');
    expect(html).toContain('$650,000.00');
    // Founder directive 2026-09-21 — at full width '$1,000,000,000.00'
    // overlaps the card placeholder, so the reserve renders compact ($1B),
    // derived from the engine cents, not a display string. The full string
    // must not appear AS the reserve balance — other surfaces (revenue
    // streams) keep their exact formatting.
    expect(html).toContain('$1B');
    const reserveBalance = html.split('data-testid="account-card-reserve-balance"')[1] ?? '';
    expect(reserveBalance).toContain('$1B');
    expect(reserveBalance.slice(0, 200)).not.toContain('$1,000,000,000.00');
  });

  it('renders the revenue streams strip and NO quick actions (goldBoardUiSpec)', async () => {
    const html = await renderDashboardPage();
    expect(html).toContain('Revenue streams');
    expect(html).toContain('data-testid="revenue-streams"');
    // Store-read per-source royalty inflow — Spotify (two settlements),
    // Amazon Music, YouTube Music, Bandcamp (one each).
    expect((html.match(/data-testid="revenue-stream"/g) ?? []).length).toBe(4);
    expect(html).toContain('Spotify');
    expect(html).toContain('Amazon Music');
    expect(html).toContain('YouTube Music');
    expect(html).toContain('Bandcamp');
    // Quick actions are REMOVED — the strip is read-only financial truth.
    expect(html).not.toContain('data-testid="quick-actions"');
    expect(html).not.toContain('Quick actions');
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
    // Four seeded transfers: two settled (the historical withdrawals) and
    // two in-flight holds (the $650,000.00 pending movement).
    expect((html.match(/data-testid="payout-tile"/g) ?? []).length).toBe(4);
    expect(html).toContain('data-rail="rtp"');
    expect(html).toContain('data-rail="ach"');
    expect(html).toContain('RTP · Instant');
    expect(html).toContain('ACH · +3 business days');
    expect(html).toContain('$250,000.00'); // RTP in-flight hold
    expect(html).toContain('$400,000.00'); // ACH in-flight hold
  });

  it('renders the dense transactions card with debit/credit pairs and See more', async () => {
    const html = await renderDashboardPage();
    expect(html).toContain('Transactions');
    expect((html.match(/data-testid="transactions-row"/g) ?? []).length).toBe(6); // visible of 12
    // Pair lines as the GL stores them: DR / CR with exactly one live side.
    // The seeded window is payout-heavy (newest first): the two in-flight
    // holds, the two historical settlement journals, and their original
    // hold journals — each shows the holder-facing leg only.
    expect(html).toContain('DR $400,000.00 / CR $0.00');
    expect(html).toContain('DR $250,000.00 / CR $0.00');
    expect(html).toContain('DR $1,162,716,666.68 / CR $0.00');
    expect(html).toContain('DR $2,000,000,000.00 / CR $0.00');
    expect(html).toContain('−$250,000.00'); // payout displayed as outflow
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
    // Seeded states, labeled in text, never color-only: KYC, bank, and
    // provisioning are COMPLETE; the tax row is honestly incomplete
    // (zero/zero TIN and W-9) and renders its TODO state.
    expect(html).toContain('COMPLETE');
    expect(html).toContain('data-testid="readiness-tax" data-state="incomplete"');
    expect(html).toContain('TODO');
  });

  it('never fabricates identity or account details — no UCT, no account numbers', async () => {
    const html = await renderDashboardPage();
    expect(html).not.toContain('UCT-');
    expect(html).not.toContain('accountNumber');
    expect(html).not.toContain('routingNumber');
  });

  it('the demo door: the seeded dashboard renders sessionless — exactly one badge, no sign-in wall', async () => {
    // renderToStaticMarkup runs with NO session (the page reads the live
    // provider in dev-seed mode → the demo door): the populated dashboard
    // renders immediately, and the DEMO DATA disclosure rides exactly once
    // so no seeded balance presents as a real holder's.
    const html = await renderDashboardPage();
    expect(html).toContain('data-testid="greeting"'); // populated, not a wall
    expect(html).toContain('data-testid="account-card-available"');
    expect((html.match(/data-testid="demo-data-badge"/g) ?? []).length).toBe(1);
    expect(html).not.toContain('NO SESSION');
    expect(html).not.toContain('Your vault lives behind your sign-in');
  });

  it('keeps the Covnant brand rails — no blue palette anywhere', async () => {
    const html = await renderDashboardPage();
    expect(html).not.toMatch(/blue-\d{3}/);
    expect(html).not.toContain('#0000FF');
  });
});
