/**
 * The live aggregate — store reads through the REAL engines (postJournal,
 * releaseVaultPending, payoutFromVault) into the InMemoryStore fixture,
 * then asserts what the dashboard renders: holder-scoped GL windows,
 * payout joins with their rails, the zero state, and the readiness rows.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { aggregateDashboardData, initialsFromName, RECENT_JOURNAL_LIMIT, loadDashboardResolution } from '@/lib/server/dashboardLive';
import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { getStore, setStore } from '@/lib/server/store';
import { creditVault, payoutFromVault, releaseVaultPending } from '@/modules/vaults/engine';
import { postJournal } from '@/modules/ledger/engine';
import { fboDebit, vaultCredit } from '@/modules/ledger/journal';
import { resolveSessionCreator, type SessionCreator } from '@/lib/server/sessionCreator';

// The session resolver — mocked per test so the door logic (not Supabase)
// is what's under test. The real resolver has its own suite.
vi.mock('@/lib/server/sessionCreator', () => ({
  resolveSessionCreator: vi.fn(),
}));

const NOVA: SessionCreator = {
  payee_id: 'rh_nova_reign_don',
  stage_name: 'Nova Reign',
  kyc_status: 'APPROVED',
  bank_account_linked: true,
  provisioning_status: 'PROVISIONED',
};

const OTHER: SessionCreator = {
  payee_id: 'rh_someone_else',
  stage_name: 'Someone Else',
  kyc_status: 'PENDING',
  bank_account_linked: false,
  provisioning_status: 'PENDING',
};

async function seedEngines(store: InMemoryStore, creator: SessionCreator): Promise<void> {
  await store.upsertVault({
    payee_id: creator.payee_id,
    payee_name: creator.stage_name,
    available_balance: 0,
    pending_balance: 0,
    reserve_balance: 0,
    updated_at: '2026-09-01T00:00:00.000Z',
  });
  // The real split-flow pair (mirrors udrSplits): creditVault moves the
  // bucket, postJournal posts the GL legs.
  await creditVault(store, creator.payee_id, creator.stage_name, 12_990, 'pending', new Date('2026-09-02T00:00:00.000Z'));
  await postJournal(
    store,
    {
      kind: 'royalty_ingest',
      ref_type: 'dsp_report',
      ref_id: `dsp_${creator.payee_id}`,
      legs: [fboDebit(12_990), vaultCredit(creator.payee_id, 'pending', 12_990)],
    },
    new Date('2026-09-02T00:00:00.000Z'),
  );
  await releaseVaultPending(store, creator.payee_id, 10_000, new Date('2026-09-03T00:00:00.000Z'));
  await payoutFromVault(
    store,
    { payee_id: creator.payee_id, amount_cents: 5_000, rail: 'rtp' },
    new Date('2026-09-04T00:00:00.000Z'),
  );
}

describe('aggregateDashboardData — the store-read half', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
    setStore(store);
  });

  it('aggregates vault buckets, holder-scoped ledger, payouts, and readiness', async () => {
    await seedEngines(store, NOVA);
    // Another holder's activity — must NEVER appear in Nova's aggregate.
    await postJournal(
      store,
      {
        kind: 'royalty_ingest',
        ref_type: 'dsp_report',
        ref_id: 'dsp_other',
        legs: [fboDebit(999_00), vaultCredit(OTHER.payee_id, 'pending', 999_00)],
      },
      new Date('2026-09-05T00:00:00.000Z'),
    );

    const data = await aggregateDashboardData(store, NOVA);

    // The buckets reflect the engine math: 12_990 pending in, 10_000
    // released, the 5_000 payout hold moving available → pending.
    expect(data.vault.available_balance).toBe(10_000 - 5_000);
    expect(data.vault.pending_balance).toBe(12_990 - 10_000 + 5_000);
    expect(data.vault.reserve_balance).toBe(0);

    // Holder-scoped: only Nova's journals (ingest + release + payout hold).
    expect(data.ledger).toHaveLength(3);
    expect(data.ledger.every(({ entries }) =>
      entries.some((entry) => entry.account.startsWith(`vault:${NOVA.payee_id}:`)),
    )).toBe(true);

    // Newest first (payout hold > release > ingest).
    expect(data.ledger[0].journal.kind).toBe('payout_hold');
    expect(data.ledger[1].journal.kind).toBe('pending_release');
    expect(data.ledger[2].journal.kind).toBe('royalty_ingest');

    // The payout tile: the hold joined with its sandbox-rail transfer (the
    // adapter stamps its provider field; sandbox is the MODE, not a provider).
    expect(data.payouts).toHaveLength(1);
    expect(data.payouts[0].rail).toBe('rtp');
    expect(data.payouts[0].provider).toBe('column');
    expect(data.payouts[0].hold.status).toBe('in_flight');
    expect(data.payouts[0].hold.payee_id).toBe(NOVA.payee_id);

    // The greeting voice.
    expect(data.user).toEqual({ stage_name: 'Nova Reign', initials: 'NR' });
  });

  it('bounds the ledger window to the recent limit, newest first', async () => {
    await store.upsertVault({
      payee_id: NOVA.payee_id,
      payee_name: NOVA.stage_name,
      available_balance: 0,
      pending_balance: 0,
      reserve_balance: 0,
      updated_at: '2026-09-01T00:00:00.000Z',
    });
    for (let i = 0; i < RECENT_JOURNAL_LIMIT + 4; i += 1) {
      await postJournal(
        store,
        {
          kind: 'royalty_ingest',
          ref_type: 'dsp_report',
          ref_id: `dsp_${i}`,
          legs: [fboDebit(100), vaultCredit(NOVA.payee_id, 'pending', 100)],
        },
        new Date(Date.UTC(2026, 8, 1, 0, i)),
      );
    }

    const data = await aggregateDashboardData(store, NOVA);
    expect(data.ledger).toHaveLength(RECENT_JOURNAL_LIMIT);
    for (let i = 1; i < data.ledger.length; i += 1) {
      // ISO timestamps order lexicographically.
      expect(data.ledger[i - 1].journal.created_at >= data.ledger[i].journal.created_at).toBe(true);
    }
  });

  it('renders the honest zero state when no vault exists yet', async () => {
    const data = await aggregateDashboardData(store, NOVA);

    expect(data.vault).toMatchObject({
      payee_id: NOVA.payee_id,
      available_balance: 0,
      pending_balance: 0,
      reserve_balance: 0,
    });
    expect(data.ledger).toEqual([]);
    expect(data.payouts).toEqual([]);
  });

  it('carries the readiness rows from the creator + tax profile', async () => {
    await store.upsertCreatorTaxProfile({
      creator_id: NOVA.payee_id,
      tin_verified: 1,
      w9_on_file: 0,
      updated_at: '2026-09-01T00:00:00.000Z',
    });

    const data = await aggregateDashboardData(store, NOVA);
    expect(data.readiness).toEqual({
      kyc_status: 'APPROVED',
      tin_verified: 1,
      w9_on_file: 0,
      bank_account_linked: true,
      provisioning_status: 'PROVISIONED',
    });
  });

  it('defaults missing readiness rows honestly (no fabrication)', async () => {
    const data = await aggregateDashboardData(store, OTHER);

    expect(data.readiness).toEqual({
      kyc_status: 'PENDING',
      tin_verified: 0,
      w9_on_file: 0,
      bank_account_linked: false,
      provisioning_status: 'PENDING',
    });
  });
});

describe('the demo door — the page-facing resolution (loadDashboardResolution)', () => {
  let store: InMemoryStore;
  const mockResolve = vi.mocked(resolveSessionCreator);
  const originalDon = process.env.DON_DEV_SEED;
  const originalVercel = process.env.VERCEL_ENV;

  beforeEach(() => {
    // Production mode: neither door flag set — the demo door's anonymous
    // branch is what fires (the dev-seed branch has its own suite).
    delete process.env.DON_DEV_SEED;
    delete process.env.VERCEL_ENV;
    store = new InMemoryStore();
    setStore(store);
  });

  afterEach(() => {
    if (originalDon === undefined) delete process.env.DON_DEV_SEED;
    else process.env.DON_DEV_SEED = originalDon;
    if (originalVercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercel;
  });

  it('renders the seeded demo to a sessionless production visitor — zero actions, no wall', async () => {
    mockResolve.mockResolvedValue({ kind: 'anonymous' });

    const resolution = await loadDashboardResolution();

    // The anonymous session resolution lands on the demo door: the seeded
    // persona over the dedicated demo store — never the anonymous wall.
    expect(resolution.kind).toBe('demo');
    if (resolution.kind === 'demo') {
      expect(resolution.data.user.stage_name).toBe('Nova Reign');
      // The seeded buckets (available 80_000) — NOT the singleton's state.
      expect(resolution.data.vault.payee_id).toBe('rh_nova_reign_don');
      expect(resolution.data.vault.available_balance).toBe(80_000);
    }
  });

  it('fail-closed invariant: no real user\u2019s data renders without a session', async () => {
    // A REAL holder's data sits in the session-bound store (the singleton) —
    // distinctive balance, real payee id.
    await store.upsertVault({
      payee_id: OTHER.payee_id,
      payee_name: OTHER.stage_name,
      available_balance: 777_777,
      pending_balance: 0,
      reserve_balance: 0,
      updated_at: '2026-09-01T00:00:00.000Z',
    });
    mockResolve.mockResolvedValue({ kind: 'anonymous' });

    const resolution = await loadDashboardResolution();

    // The sessionless render is the DEMO — the seeded persona over the
    // dedicated demo store. A sessionless request has no identity, so there
    // is no real user whose data could leak: the door never reads the
    // session-bound store for them.
    expect(resolution.kind).toBe('demo');
    if (resolution.kind === 'demo') {
      expect(resolution.data.vault.payee_id).not.toBe(OTHER.payee_id);
      expect(resolution.data.vault.available_balance).not.toBe(777_777);
      expect(resolution.data.vault.available_balance).toBe(80_000); // the seed
    }
  });

  it('a signed-in session keeps its session-bound data — the demo door never hijacks it', async () => {
    await seedEngines(store, NOVA); // the real store holds Nova's engine data
    mockResolve.mockResolvedValue({ kind: 'registered', creator: NOVA });

    const resolution = await loadDashboardResolution();

    expect(resolution.kind).toBe('registered');
    if (resolution.kind === 'registered') {
      // The session-bound aggregate (12_990 pending in, 10_000 released,
      // 5_000 payout hold) — NOT the seeded demo's 80_000.
      expect(resolution.data.vault.available_balance).toBe(5_000);
      expect(resolution.data.user.stage_name).toBe('Nova Reign');
    }
  });

  it('an unregistered session stays honest — no persona, no demo', async () => {
    mockResolve.mockResolvedValue({ kind: 'unregistered', reason: 'profile_not_found' });

    const resolution = await loadDashboardResolution();

    expect(resolution).toEqual({ kind: 'unregistered', reason: 'profile_not_found' });
  });

  it('the demo store never swaps the persistence seam — concurrent renders reuse one instance', async () => {
    mockResolve.mockResolvedValue({ kind: 'anonymous' });

    const [first, second] = await Promise.all([loadDashboardResolution(), loadDashboardResolution()]);

    expect(first.kind).toBe('demo');
    expect(second.kind).toBe('demo');
    // The singleton is EXACTLY the test's store — the demo door booted its
    // own instance and left the seam untouched for real sessions.
    expect(getStore()).toBe(store);
  });
});

describe('initialsFromName — the avatar chip', () => {
  it('takes up to two word-initial letters', () => {
    expect(initialsFromName('Nova Reign')).toBe('NR');
    expect(initialsFromName('joan of arc')).toBe('JO');
    expect(initialsFromName('Single')).toBe('S');
  });

  it('renders the honest placeholder for an empty name', () => {
    expect(initialsFromName('')).toBe('?');
    expect(initialsFromName('   ')).toBe('?');
  });
});
