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
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CovnantMeResponse } from '@/lib/covnant/types';
import { buildUct } from '@/lib/covnant/uct';
import { formatUnitsMajor } from '@/lib/money/format';

const meMock = vi.hoisted(() => ({ resolveCovnantMe: vi.fn() }));

vi.mock('@/lib/server/covnantMe', () => ({
  resolveCovnantMe: meMock.resolveCovnantMe,
}));

const { default: DashboardPage } = await import('@/app/(workspace)/dashboard/page');

/** The async server component renders through the node pipeable stream.
 *  An optional searchParams object mirrors the Next 15 page-prop shape. */
async function renderPage(searchParams?: { demo_login_failed?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    let html = '';
    const { pipe } = renderToPipeableStream(
      <DashboardPage searchParams={searchParams ? Promise.resolve(searchParams) : undefined} />,
      {
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
      }
    );
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
  it('renders the greeting row, identity chip, and all five regions from the aggregate', async () => {
    meMock.resolveCovnantMe.mockResolvedValue({ ok: true, data: ME });

    const html = await renderPage();

    // Greeting row: large greeting + the small identity chip. The Creator
    // ID card is explicitly OUT of the dashboard (user directive) — the
    // chip (initials + compact UCT) is the only identity on the page.
    expect(html).toContain('data-testid="greeting"');
    expect(html).toContain('Nova Reign');
    expect(html).toContain('data-testid="identity-chip"');
    expect(html).toContain(UCT);
    expect(html).not.toContain('creator-id-card');

    // Accounts section: small-caps label, three calm cards. Provisioning
    // is status-only quiet text — never a badge stack.
    expect(html).toContain('data-testid="accounts-row"');
    expect(html).toContain('Virtual Account');
    expect(html).toContain('data-testid="virtual-status"');
    expect(html).toContain('data-provisioning="PENDING"');
    // Pending provisioning renders the honest status line, not a balance.
    expect(html).toContain('data-testid="virtual-balance-pending"');
    expect(html).not.toContain('data-testid="virtual-balance"');
    expect(html).toContain('data-testid="account-card-settlements"');
    expect(html).toContain('1.22500000'); // net 122500000 units — exact minor string
    expect(html).toContain('data-testid="workspace-assets"');
    expect(html).toContain('data-testid="workspace-contracts"');

    // Quick actions — compact icon tiles over wired destinations only.
    expect(html).toContain('href="/assets"');
    expect(html).toContain('href="/contracts"');
    expect(html).toContain('href="/templates"');

    // Transactions: the creator-scoped row (platform · date · CBT code ·
    // exact amount — the raw transaction id is not a display field).
    expect(html).toContain('data-testid="transactions-row"');
    expect(html).toContain('Spotify');
    expect(html).toContain('CBT-MUS-2026-AAAA1111');
    expect(html).toContain('1.40000000');
    // One bounded slice: no truncation, so no "See more" affordance.
    expect(html).not.toContain('data-testid="transactions-see-more"');

    // Readiness checklist — small, quiet, text-labeled token states.
    expect(html).toContain('data-testid="readiness-kyc"');
    expect(html).toContain('KYC status: PENDING_INITIALIZATION');
    expect(html).toContain('W9 — awaiting verification');
    expect(html).toContain('Link an account to receive payouts');
    expect(html).toContain('data-testid="readiness-provisioning"');
  });

  it('renders the large right-aligned balance once the virtual account is provisioned', async () => {
    meMock.resolveCovnantMe.mockResolvedValue({
      ok: true,
      data: { ...ME, provisioning: { status: 'PROVISIONED', reason: null } },
    });

    const html = await renderPage();

    expect(html).toContain('data-testid="virtual-balance"');
    expect(html).toContain(formatUnitsMajor(ME.settlements.availableEscrowBalance, 'USD'));
    expect(html).not.toContain('data-testid="virtual-balance-pending"');
  });

  it('renders the largest net balance as the primary large figure regardless of route order', async () => {
    // The me-route aggregates per-currency alphabetically (EUR first); the
    // card must lead with the balance that matters most, not route order.
    meMock.resolveCovnantMe.mockResolvedValue({
      ok: true,
      data: {
        ...ME,
        settlementsByCurrency: [
          { currency: 'EUR', grossUnits: '50000000', netUnits: '35000000' },
          { currency: 'USD', grossUnits: '140000000', netUnits: '140000000' },
        ],
      },
    });

    const html = await renderPage();

    // USD is the largest net balance → the primary large-type figure.
    const primary = html.match(/data-testid="settlements-net-USD"[^>]*class="([^"]*)"/)?.[1] ?? '';
    expect(primary).toContain('text-4xl');
    expect(primary).not.toContain('text-xs');
    // EUR drops to the exact small-print lines.
    expect(html).toContain('data-testid="settlements-gross-EUR"');
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

describe('/dashboard — preview-only direct access (VERCEL_ENV gate)', () => {
  afterEach(() => {
    delete process.env.VERCEL_ENV;
  });

  it('in preview, an unauthenticated visit redirects through the demo-login door', async () => {
    process.env.VERCEL_ENV = 'preview';
    meMock.resolveCovnantMe.mockResolvedValue({
      ok: false,
      status: 401,
      reason: 'no_session',
      message: 'No session — sign in to load the creator aggregate.',
    });

    // redirect() throws with the URL in the digest, not the message.
    const error = (await renderPage().catch((e: unknown) => e)) as {
      message?: string;
      digest?: string;
    };
    expect(error.message).toBe('NEXT_REDIRECT');
    expect(error.digest ?? '').toContain('/api/preview/demo-login');
  });

  it('in preview, a stale session (session_invalid) also routes through the door', async () => {
    process.env.VERCEL_ENV = 'preview';
    meMock.resolveCovnantMe.mockResolvedValue({
      ok: false,
      status: 401,
      reason: 'session_invalid',
      message: 'The session is absent or invalid.',
    });

    const error = (await renderPage().catch((e: unknown) => e)) as {
      message?: string;
      digest?: string;
    };
    expect(error.message).toBe('NEXT_REDIRECT');
    expect(error.digest ?? '').toContain('/api/preview/demo-login');
  });

  it('in preview, a signed-but-unregistered creator keeps the honest 404 state — no redirect loop', async () => {
    process.env.VERCEL_ENV = 'preview';
    meMock.resolveCovnantMe.mockResolvedValue({
      ok: false,
      status: 404,
      reason: 'holder_not_found',
      message: 'No registered creator for this session.',
    });

    const html = await renderPage();

    expect(html).toContain('Your creator home');
    expect(html).toContain('holder_not_found');
  });

  it('in preview, the demo_login_failed param renders the visitor state — loop guard', async () => {
    process.env.VERCEL_ENV = 'preview';
    meMock.resolveCovnantMe.mockResolvedValue({
      ok: false,
      status: 401,
      reason: 'no_session',
      message: 'No session — sign in to load the creator aggregate.',
    });

    const html = await renderPage({ demo_login_failed: '1' });

    expect(html).toContain('Your creator home');
    expect(html).toContain('no_session');
  });

  it('in production, an unauthenticated visit renders the real visitor state — no demo session', async () => {
    process.env.VERCEL_ENV = 'production';
    meMock.resolveCovnantMe.mockResolvedValue({
      ok: false,
      status: 401,
      reason: 'no_session',
      message: 'No session — sign in to load the creator aggregate.',
    });

    const html = await renderPage();

    expect(html).toContain('Your creator home');
    expect(html).toContain('data-testid="dashboard-signin-cta"');
    expect(html).not.toContain('api/preview/demo-login');
  });
});
