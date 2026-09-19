/**
 * The dev-seed boot — the flag gate and the seeded content through the real
 * engines: deterministic balances, the hash-chained GL, in-flight payouts,
 * the tax profile, and the demo persona.
 *
 * THE FOUNDER'S INTEGRITY TEST (rendered here as store-level assertions):
 * the portfolio amounts are CONSTRUCTED through the real settlement engine
 * and read back from the store —
 *   reserve   100,000,000,000 — Σ 24% backup withholding credited to the
 *               creator's reserve bucket by calculateUdrSplits (no verified
 *               TIN/W-9 → locked semantic #4; the YTD and tax-escrow rows
 *               are the engine's own receipts).
 *   pending      65,000,000 — the two in-flight payout holds (payouts move
 *               available → pending; payout.settled clears pending).
 *   available   330,000,000 — the released residual after four payout holds.
 * No display string anywhere produces these numbers.
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  bootDevSeedStore,
  DEV_SEED_CREATOR,
  DEV_SEED_TARGETS,
  DEV_SEED_UCT,
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
      expect(resolution.data.user.stage_name).toBe('Yeshua Throne');
    }

    // The PAGE door renders the same seeded persona as the demo view —
    // the seeded render IS the demo kind (exactly one badge rides on it).
    const pageResolution = await loadDashboardResolution();
    expect(pageResolution.kind).toBe('demo');
    if (pageResolution.kind === 'demo') {
      expect(pageResolution.data.user.stage_name).toBe('Yeshua Throne');
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
      expect(pageResolution.data.user.stage_name).toBe('Yeshua Throne');
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

    // THE PORTFOLIO — the founder's three targets, produced by the real
    // settlement/payout engine paths and read back from the store:
    //   available   330,000,000   pending   65,000,000   reserve 100,000,000,000
    const vault = await store.getVault(DEV_SEED_CREATOR.payee_id);
    expect(vault).toBeDefined();
    expect(vault!.available_balance).toBe(DEV_SEED_TARGETS.available_cents);
    expect(vault!.pending_balance).toBe(DEV_SEED_TARGETS.pending_cents);
    expect(vault!.reserve_balance).toBe(DEV_SEED_TARGETS.reserve_cents);

    // The withholding receipts — the engine's own records of the reserve
    // construction: YTD gross is Σ creator allocations (416,666,666,668) and
    // YTD withheld is the reserve itself (100,000,000,000 at 24%).
    const ytd = await store.getCreatorYtd(DEV_SEED_CREATOR.payee_id, 2026);
    expect(ytd).toBeDefined();
    expect(ytd!.gross_cents).toBe(416_666_666_668);
    expect(ytd!.withheld_cents).toBe(DEV_SEED_TARGETS.reserve_cents);

    // The tax-escrow rows — one per seeded settlement run, summing to the
    // same reserve total (the per-run receipts behind the YTD rollup).
    const escrows = await store.listTaxEscrowByCreator(DEV_SEED_CREATOR.payee_id, 2026);
    expect(escrows).toHaveLength(5);
    const escrowedTotal = escrows.reduce((sum, row) => sum + row.withheld_cents, 0);
    expect(escrowedTotal).toBe(DEV_SEED_TARGETS.reserve_cents);

    // The GL: five royalty ingests + one release + four payout holds +
    // two payout settlements, all posted — the hash chain links every
    // journal to its predecessor.
    const journals = await store.listGlJournals();
    expect(journals).toHaveLength(12);
    const bySequence = [...journals].sort((a, b) => a.sequence - b.sequence);
    for (let i = 1; i < bySequence.length; i += 1) {
      expect(bySequence[i].prev_hash).toBe(bySequence[i - 1].entry_hash);
    }
    expect(bySequence.every((journal) => journal.state === 'posted')).toBe(true);
    expect(bySequence.filter((journal) => journal.kind === 'royalty_ingest')).toHaveLength(5);
    expect(bySequence.filter((journal) => journal.kind === 'pending_release')).toHaveLength(1);
    expect(bySequence.filter((journal) => journal.kind === 'payout_hold')).toHaveLength(4);
    expect(bySequence.filter((journal) => journal.kind === 'payout_settled')).toHaveLength(2);

    // The payout holds — two historical (settled) and two in-flight on the
    // sandbox rails; the in-flight pair IS the pending bucket.
    const transfers = (await store.listBaasTransfers()).filter(
      (transfer) => transfer.payee_id === DEV_SEED_CREATOR.payee_id,
    );
    expect(transfers).toHaveLength(4);
    const holds = await Promise.all(transfers.map((transfer) => store.getPayoutHold(transfer.id)));
    expect(holds.filter((hold) => hold?.status === 'in_flight')).toHaveLength(2);
    expect(holds.filter((hold) => hold?.status === 'settled')).toHaveLength(2);

    // The tax profile — UNVERIFIED on purpose: it is what drives the 24%
    // backup withholding that builds the $1,000,000,000 reserve (locked
    // semantic #4). The readiness panel honestly shows the TODO.
    const profile = await store.getCreatorTaxProfile(DEV_SEED_CREATOR.payee_id);
    expect(profile?.tin_verified).toBe(0);
    expect(profile?.w9_on_file).toBe(0);

    // The persona's identity tag — the seeded UCT the identity surfaces read.
    const uct = await store.getCreatorUct(DEV_SEED_CREATOR.payee_id);
    expect(uct?.uctNumber).toBe(DEV_SEED_UCT);
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
    expect(vault!.available_balance).toBe(DEV_SEED_TARGETS.available_cents);
  });
});
