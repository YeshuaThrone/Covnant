/**
 * The dev-seed boot — the flag gate and the seeded content through the real
 * engines: deterministic balances, the hash-chained GL, in-flight payouts,
 * the tax profile, and the demo persona.
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  bootDevSeedStore,
  DEV_SEED_CREATOR,
  isDevSeedMode,
} from '@/lib/server/devSeed';
import { loadDashboardResolution, loadSessionDashboard } from '@/lib/server/dashboardLive';
import { getStore, setStore } from '@/lib/server/store';
import { InMemoryStore } from '@/lib/server/inMemoryStore';

// The boot replaces the process-wide store singleton — restore afterwards.
afterAll(() => {
  setStore(new InMemoryStore());
});

describe('isDevSeedMode — the explicit gate', () => {
  it('is on only for DON_DEV_SEED=1', () => {
    const original = process.env.DON_DEV_SEED;
    try {
      process.env.DON_DEV_SEED = '1';
      expect(isDevSeedMode()).toBe(true);
      process.env.DON_DEV_SEED = '0';
      expect(isDevSeedMode()).toBe(false);
      delete process.env.DON_DEV_SEED;
      expect(isDevSeedMode()).toBe(false);
      process.env.DON_DEV_SEED = 'true'; // not the documented value — off
      expect(isDevSeedMode()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.DON_DEV_SEED;
      else process.env.DON_DEV_SEED = original;
    }
  });
});

describe('isDevSeedMode — the Vercel preview door', () => {
  const originalDon = process.env.DON_DEV_SEED;
  const originalVercel = process.env.VERCEL_ENV;

  afterAll(() => {
    if (originalDon === undefined) delete process.env.DON_DEV_SEED;
    else process.env.DON_DEV_SEED = originalDon;
    if (originalVercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercel;
  });

  it('opens on Vercel preview deployments without DON_DEV_SEED — the demo renders under preview env', async () => {
    delete process.env.DON_DEV_SEED;
    process.env.VERCEL_ENV = 'preview';
    expect(isDevSeedMode()).toBe(true);

    // The resolver serves the seeded registered persona — the populated
    // dashboard renders immediately with zero user actions.
    const resolution = await loadSessionDashboard();
    expect(resolution.kind).toBe('registered');
    if (resolution.kind === 'registered') {
      expect(resolution.data.user.stage_name).toBe('Nova Reign');
    }

    // The PAGE door renders the same seeded persona as the demo view —
    // the seeded render IS the demo kind (exactly one badge rides on it).
    const pageResolution = await loadDashboardResolution();
    expect(pageResolution.kind).toBe('demo');
    if (pageResolution.kind === 'demo') {
      expect(pageResolution.data.user.stage_name).toBe('Nova Reign');
    }
  });

  it('opens the page-facing demo door in Vercel production — sessionless visitors see the seeded demo', async () => {
    delete process.env.DON_DEV_SEED;
    process.env.VERCEL_ENV = 'production';
    expect(isDevSeedMode()).toBe(false);

    // The API door stays fail-closed: no session → the anonymous gate,
    // exactly as the machine contract has always behaved.
    const apiResolution = await loadSessionDashboard();
    expect(apiResolution.kind === 'anonymous' || apiResolution.kind === 'unregistered').toBe(true);

    // The PAGE door is the demo door — VERCEL_ENV-agnostic: the sessionless
    // visitor lands straight on the populated seeded dashboard.
    const pageResolution = await loadDashboardResolution();
    expect(pageResolution.kind).toBe('demo');
    if (pageResolution.kind === 'demo') {
      expect(pageResolution.data.user.stage_name).toBe('Nova Reign');
      expect(pageResolution.data.vault.payee_id).toBe(DEV_SEED_CREATOR.payee_id);
    }
  });

  it('stays closed when both variables are unset — no demo outside preview', () => {
    delete process.env.DON_DEV_SEED;
    delete process.env.VERCEL_ENV;
    expect(isDevSeedMode()).toBe(false);
  });

  it('the explicit DON_DEV_SEED=1 switch still wins locally regardless of VERCEL_ENV', () => {
    process.env.DON_DEV_SEED = '1';
    process.env.VERCEL_ENV = 'production';
    expect(isDevSeedMode()).toBe(true);
  });
});

describe('bootDevSeedStore — the seeded content', () => {
  it('boots the seeded in-memory store through the real engines', async () => {
    await bootDevSeedStore();

    const store = getStore();
    expect(store).toBeInstanceOf(InMemoryStore);

    // The vault buckets — the engine math (327_485 pending in, 150_000
    // released, 70_000 paid out in flight, 45_000 reserve).
    const vault = await store.getVault(DEV_SEED_CREATOR.payee_id);
    expect(vault).toBeDefined();
    expect(vault!.available_balance).toBe(80_000);
    expect(vault!.pending_balance).toBe(247_485);
    expect(vault!.reserve_balance).toBe(45_000);

    // The GL: five royalty ingests + one release + two payout holds, all
    // posted — the hash chain links every journal to its predecessor.
    const journals = await store.listGlJournals();
    expect(journals).toHaveLength(8);
    const bySequence = [...journals].sort((a, b) => a.sequence - b.sequence);
    for (let i = 1; i < bySequence.length; i += 1) {
      expect(bySequence[i].prev_hash).toBe(bySequence[i - 1].entry_hash);
    }
    expect(bySequence.every((journal) => journal.state === 'posted')).toBe(true);
    expect(bySequence.filter((journal) => journal.kind === 'royalty_ingest')).toHaveLength(5);

    // The payout holds — two in-flight transfers on the sandbox rails.
    const transfers = (await store.listBaasTransfers()).filter(
      (transfer) => transfer.payee_id === DEV_SEED_CREATOR.payee_id,
    );
    expect(transfers).toHaveLength(2);
    const holds = await Promise.all(transfers.map((transfer) => store.getPayoutHold(transfer.id)));
    expect(holds.every((hold) => hold?.status === 'in_flight')).toBe(true);

    // The tax profile — the readiness rows read complete for the persona.
    const profile = await store.getCreatorTaxProfile(DEV_SEED_CREATOR.payee_id);
    expect(profile?.tin_verified).toBe(1);
    expect(profile?.w9_on_file).toBe(1);
  });

  it('seeds structurally deterministic — same ledger shape and balances per boot', async () => {
    await bootDevSeedStore();
    const first = await getStore().listGlJournals();
    const firstShape = first
      .map((journal) => `${journal.sequence}:${journal.kind}:${journal.ref_type}`)
      .sort();

    await bootDevSeedStore();
    const second = await getStore().listGlJournals();
    const secondShape = second
      .map((journal) => `${journal.sequence}:${journal.kind}:${journal.ref_type}`)
      .sort();

    // The payout-hold journals reference store-generated transfer ids, so
    // byte-identical hashes are not achievable through the real engines —
    // the promised determinism is the LEDGER SHAPE and the balances, and
    // the chain is valid within each boot (asserted above).
    expect(secondShape).toEqual(firstShape);
    const vault = await getStore().getVault(DEV_SEED_CREATOR.payee_id);
    expect(vault!.available_balance).toBe(80_000);
  });
});
