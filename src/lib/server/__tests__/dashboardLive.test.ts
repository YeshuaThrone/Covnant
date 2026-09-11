/**
 * The live aggregate — store reads through the REAL engines (postJournal,
 * releaseVaultPending, payoutFromVault) into the InMemoryStore fixture,
 * then asserts what the dashboard renders: holder-scoped GL windows,
 * payout joins with their rails, the zero state, and the readiness rows.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { aggregateDashboardData, initialsFromName, RECENT_JOURNAL_LIMIT } from '@/lib/server/dashboardLive';
import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { setStore } from '@/lib/server/store';
import { creditVault, payoutFromVault, releaseVaultPending } from '@/modules/vaults/engine';
import { postJournal } from '@/modules/ledger/engine';
import { fboDebit, vaultCredit } from '@/modules/ledger/journal';
import type { SessionCreator } from '@/lib/server/sessionCreator';

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
