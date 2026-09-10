/**
 * /dashboard render tests — the bank-home composition over ONE mocked
 * session aggregate. The resolver is mocked at module level (the real
 * resolver's read behavior is pinned exhaustively by the me-route suite);
 * these tests pin what the page RENDERS: the greeting hero, the props-first
 * card, the accounts row, the wired quick actions, the honest empty
 * transaction state, the readiness checklist, and the visitor/degraded
 * states — with the account-number ban asserted on the rendered HTML.
 */

import { PassThrough } from 'node:stream';

import { renderToPipeableStream } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { CovnantMeResponse } from '@/lib/covnant/types';
import { buildUct } from '@/lib/covnant/uct';

const meMock = vi.hoisted(() => ({ resolveCovnantMe: vi.fn() }));

vi.mock('@/lib/server/covnantMe', () => ({
  resolveCovnantMe: meMock.resolveCovnantMe,
}));

const { default: DashboardPage } = await import('@/app/(workspace)/dashboard/page');

/** The async server component renders through the node pipeable stream. */
async function renderPage(): Promise<string> {
  return new Promise((resolve, reject) => {
    let html = '';
    const { pipe } = renderToPipeableStream(<DashboardPage />, {
      onAllReady() {
        const sink = new PassThrough();
        sink.on('data', (chunk: Buffer) => {
          html += chunk.toString();
        });
        sink.on('end', () => resolve(html));
        sink.on('error', reject);
        pipe(sink);
      },
      onError(error) {
        reject(error);
      },
    });
  });
}

const UCT = buildUct('US', 2026, '9F3A7C21');

const ME: CovnantMeResponse = {
  profile: {
    id: 'auth_user_1',
    stage_name: 'Nova Reign',
    legal_name: 'Jordan A. Reyes',
    email: 'creator@example.com',
    phone: null,
    phone_verified_at: null,
    core_industry: 'Music — Recording',
    title: 'Recording Artist',
    udr_terms_accepted_at: '2026-09-09T00:00:00.000Z',
    kyc_status: 'PENDING_INITIALIZATION',
    tax_form_type: 'W9',
    tax_verified: false,
    bank_account_linked: false,
    created_at: '2026-09-09T00:00:00.000Z',
  },
  identity: {
    uct: UCT,
    uctCreatedAt: '2026-09-09T00:00:00.000Z',
    jurisdiction: 'US',
  },
  role: 'COMPOSER',
  provisioning: { status: 'PENDING', reason: 'INCREASE_NOT_PROVISIONED' },
  settlements: {
    grossEarnings: '175000000',
    taxWithheld: '52500000',
    availableEscrowBalance: '97500000',
    isTaxVerified: false,
  },
  registeredAssets: 1,
  activeContracts: 3,
  settlementsByCurrency: [{ currency: 'USD', grossUnits: '175000000', netUnits: '122500000' }],
  recentSettlements: [
    {
      transactionId: 'tx-1',
      cbtCode: 'CBT-MUS-2026-AAAA1111',
      platform: 'Spotify',
      currency: 'USD',
      amountUnits: '140000000',
      settledAt: '2026-06-01T00:00:00Z',
    },
  ],
};

describe('/dashboard — resolved aggregate (signed in)', () => {
  it('renders the greeting hero, anchored card, and all five regions from the aggregate', async () => {
    meMock.resolveCovnantMe.mockResolvedValue({ ok: true, data: ME });

    const html = await renderPage();

    // Greeting hero + props-first card.
    expect(html).toContain('data-testid="greeting"');
    expect(html).toContain('Nova Reign');
    expect(html).toContain('data-testid="creator-id-card"');
    expect(html).toContain(UCT);
    expect(html).toContain('data-provisioning="PENDING"');

    // Accounts row: three cards with real figures.
    expect(html).toContain('data-testid="accounts-row"');
    expect(html).toContain('Virtual account');
    expect(html).toContain('data-provisioning="PENDING"');
    expect(html).toContain('1.75'); // gross 175000000 units → 1.75 USD
    expect(html).toContain('data-testid="workspace-assets"');
    expect(html).toContain('Registered assets');
    expect(html).toContain('data-testid="workspace-contracts"');

    // Quick actions — wired destinations only.
    expect(html).toContain('href="/assets"');
    expect(html).toContain('href="/contracts"');
    expect(html).toContain('href="/templates"');

    // Transactions: the creator-scoped row (platform · date · CBT code ·
    // exact amount — the raw transaction id is not a display field).
    expect(html).toContain('data-testid="transactions-row"');
    expect(html).toContain('Spotify');
    expect(html).toContain('CBT-MUS-2026-AAAA1111');
    expect(html).toContain('1.40000000');

    // Readiness checklist — text-labeled token states, fail-closed defaults.
    expect(html).toContain('data-testid="readiness-kyc"');
    expect(html).toContain('KYC status: PENDING_INITIALIZATION');
    expect(html).toContain('W9 — awaiting verification');
    expect(html).toContain('Link an account to receive payouts');
    expect(html).toContain('data-testid="readiness-provisioning"');
  });

  it('never renders account or routing numbers anywhere', async () => {
    meMock.resolveCovnantMe.mockResolvedValue({ ok: true, data: ME });

    const html = await renderPage();

    expect(html).not.toContain('accountNumber');
    expect(html).not.toContain('routingNumber');
    expect(html).not.toContain('987654321');
    expect(html).not.toContain('101050001');
  });

  it('renders the honest empty state when no settlements exist on the ledger', async () => {
    meMock.resolveCovnantMe.mockResolvedValue({
      ok: true,
      data: { ...ME, recentSettlements: [] },
    });

    const html = await renderPage();

    expect(html).toContain('No settlements on the ledger yet');
    expect(html).not.toContain('data-testid="transactions-row"');
  });
});

describe('/dashboard — honest failure states', () => {
  it('renders the unregistered state with a sign-in path on a 401', async () => {
    meMock.resolveCovnantMe.mockResolvedValue({
      ok: false,
      status: 401,
      reason: 'no_session',
      message: 'No session — sign in to load the creator aggregate.',
    });

    const html = await renderPage();

    expect(html).toContain('Your creator home');
    expect(html).toContain('data-testid="dashboard-signin-cta"');
    expect(html).toContain('href="/signin"');
    expect(html).toContain('no_session');
    // No fabricated data: none of the resolved regions render.
    expect(html).not.toContain('data-testid="greeting"');
    expect(html).not.toContain('data-testid="accounts-row"');
  });

  it('renders the degraded state with the named reason on a server read failure', async () => {
    meMock.resolveCovnantMe.mockResolvedValue({
      ok: false,
      status: 502,
      reason: 'escrow_read_failed',
      message: 'Failed to load the creator settlements.',
    });

    const html = await renderPage();

    expect(html).toContain('escrow_read_failed');
    expect(html).toContain('data-testid="dashboard-state-reason"');
    expect(html).not.toContain('data-testid="accounts-row"');
  });
});
