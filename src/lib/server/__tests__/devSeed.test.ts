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
