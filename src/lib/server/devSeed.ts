/**
 * The dev-seed boot — deterministic seeded dev data for the live dashboard,
 * gated behind DON_DEV_SEED=1 (local dev, the e2e harness, and preview
 * deployments of this branch; production NEVER sets it).
 *
 * Why: the live dashboard reads the session-bound Don store, but the e2e
 * harness runs the production build with no database and no session server.
 * With DON_DEV_SEED=1 the server boots the InMemoryStore (the designed test
 * swap, store.ts setStore()) and seeds it through the REAL engine paths —
 * postJournal for the GL chain (real sha256 hash chaining), payoutFromVault
 * for the payouts (real hold/balance/journal writes) — so the e2e and the
 * minted preview exercise the genuine live resolver, store reads, and
 * display model end to end. Nothing here is reachable without the flag.
 *
 * The persona: Nova Reign (nova@example.com, rightsHolderId
 * rh_nova_reign_don) — the dashboard's demo holder since the fixtures era.
 * The seeded identity exists ONLY in this mode; production identity always
 * resolves from the real session (sessionCreator.ts).
 */

import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { setStore } from '@/lib/server/store';
import {
  creditVault,
  payoutFromVault,
  releaseVaultPending,
} from '@/modules/vaults/engine';
import { postJournal } from '@/modules/ledger/engine';
import { fboDebit, vaultCredit } from '@/modules/ledger/journal';
import type { SessionCreator } from '@/lib/server/sessionCreator';

/** The env flag — explicit, off by default, documented in .env.example. */
export function isDevSeedMode(): boolean {
  return process.env.DON_DEV_SEED === '1';
}

/** The dev-seed persona — the dashboard's demo holder. */
export const DEV_SEED_CREATOR: SessionCreator = {
  payee_id: 'rh_nova_reign_don',
  stage_name: 'Nova Reign',
  kyc_status: 'APPROVED',
  bank_account_linked: true,
  provisioning_status: 'PROVISIONED',
};

/** Deterministic seed dates — the seeded ledger's timeline (ascending). */
const SEED_INSTANTS = {
  spotify_aug: '2026-08-20T12:00:00.000Z',
  youtube_aug: '2026-08-29T12:00:00.000Z',
  amazon_aug: '2026-08-30T12:00:00.000Z',
  release: '2026-09-01T09:00:00.000Z',
  spotify_sep: '2026-09-06T14:00:00.000Z',
  bandcamp: '2026-09-07T16:30:00.000Z',
  payout_rtp: '2026-09-08T14:00:00.000Z',
  payout_ach: '2026-09-08T14:05:00.000Z',
} as const;

/**
 * Boots the seeded in-memory store. Idempotent per server boot: a fresh
 * InMemoryStore is seeded through the real engine paths every time. AWAITS
 * the full seed — instrumentation's register() awaits this, so no request
 * can observe a half-seeded store.
 */
let devSeedStore: InMemoryStore | null = null;

export async function bootDevSeedStore(): Promise<void> {
  const store = new InMemoryStore();
  setStore(store);
  devSeedStore = store;
  try {
    await seedStore(store);
  } catch (error) {
    // A failed seed must never look like a working dashboard — fail loud.
    devSeedStore = null;
    console.error('dev-seed: seeding failed:', error);
    throw error;
  }
  console.error('dev-seed: The Don dashboard store seeded (DON_DEV_SEED=1).');
}

/**
 * The dev-seed store for READ paths. Kept in THIS module rather than the
 * store.ts singleton because the instrumentation bundle and the SSR bundle
 * each compile their own copy of the store module — a store injected into
 * the singleton at boot never crosses that bundle boundary. This accessor
 * boots lazily per copy instead; the seed is deterministic, so multiple
 * booted copies agree on every displayed figure.
 */
export async function getSeededStore(): Promise<InMemoryStore> {
  if (devSeedStore === null) {
    await bootDevSeedStore();
  }
  if (devSeedStore === null) {
    // bootDevSeedStore() either leaves a seeded store or throws — unreachable.
    throw new Error('dev-seed: store failed to boot');
  }
  return devSeedStore;
}

async function seedStore(store: InMemoryStore): Promise<void> {
  const payee = DEV_SEED_CREATOR;

  // The reserve bucket starts provisioned; royalties land in pending,
  // releases move them to available, payouts drain available in flight.
  await store.upsertVault({
    payee_id: payee.payee_id,
    payee_name: payee.stage_name,
    available_balance: 0,
    pending_balance: 0,
    reserve_balance: 45_000,
    updated_at: SEED_INSTANTS.spotify_aug,
  });
  await store.upsertCreatorTaxProfile({
    creator_id: payee.payee_id,
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: SEED_INSTANTS.release,
  });

  // Royalty ingests — fbo cash in, the holder's pending bucket credited,
  // posted through the real hash-chained GL (postJournal computes the
  // sha256 entry_hash and links prev_hash → the audit line is real).
  const royalties: Array<{ refId: string; amountCents: number; at: string }> = [
    { refId: 'dsp_spotify_2026_08', amountCents: 200_000, at: SEED_INSTANTS.spotify_aug },
    { refId: 'dsp_youtube_2026_08', amountCents: 88_405, at: SEED_INSTANTS.youtube_aug },
    { refId: 'dsp_amazon_2026_08', amountCents: 21_340, at: SEED_INSTANTS.amazon_aug },
    { refId: 'dsp_spotify_2026_09', amountCents: 12_990, at: SEED_INSTANTS.spotify_sep },
    { refId: 'dsp_bandcamp_2026_09', amountCents: 4_750, at: SEED_INSTANTS.bandcamp },
  ];
  for (const royalty of royalties) {
    // The real split-flow pair (mirrors udrSplits): creditVault moves the
    // bucket balance, postJournal posts the matching GL legs — the hash
    // chain (sha256 entry_hash, linked prev_hash) makes the audit line real.
    await creditVault(
      store,
      payee.payee_id,
      payee.stage_name,
      royalty.amountCents,
      'pending',
      new Date(royalty.at),
    );
    const posted = await postJournal(
      store,
      {
        kind: 'royalty_ingest',
        ref_type: 'dsp_report',
        ref_id: royalty.refId,
        legs: [fboDebit(royalty.amountCents), vaultCredit(payee.payee_id, 'pending', royalty.amountCents)],
      },
      new Date(royalty.at),
    );
    if (!posted.ok) {
      throw new Error(`dev-seed: royalty ingest journal failed: ${posted.message}`);
    }
  }

  // One pending release — the real engine path (posts the pending_release
  // journal with the vault ref and moves the balances).
  const released = await releaseVaultPending(store, payee.payee_id, 150_000, new Date(SEED_INSTANTS.release));
  if (!released.ok) {
    throw new Error(`dev-seed: pending release failed: ${JSON.stringify(released)}`);
  }

  // Two in-flight payouts on the sandbox rail — the real payout engine
  // (balances move available → pending, the hold lands, the journal posts).
  const payouts: Array<{ rail: 'rtp' | 'ach'; amountCents: number; at: string }> = [
    { rail: 'rtp', amountCents: 25_000, at: SEED_INSTANTS.payout_rtp },
    { rail: 'ach', amountCents: 45_000, at: SEED_INSTANTS.payout_ach },
  ];
  for (const payout of payouts) {
    const result = await payoutFromVault(
      store,
      { payee_id: payee.payee_id, amount_cents: payout.amountCents, rail: payout.rail },
      new Date(payout.at),
    );
    if (!result.ok) {
      throw new Error(`dev-seed: payout failed: ${result.code}`);
    }
  }
}
