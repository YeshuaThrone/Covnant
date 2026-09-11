/**
 * GET /api/v1/dashboard — the dev-seed integration: the route resolved
 * through the REAL resolver (dev-seed identity → getStore()) over a store
 * seeded through the REAL engines (postJournal / releaseVaultPending /
 * payoutFromVault) — no mocks anywhere. This is the brief's "vitest route
 * tests against the in-memory store fixture" and pins the happy path:
 * 200, the three vault buckets, hash-chained holder-scoped GL rows with
 * the entry_hash short form on the display projection, payout holds
 * attributed to their rails, readiness rows.
 */

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET } from '../route';
import { bootDevSeedStore } from '@/lib/server/devSeed';

function dashboardRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/dashboard');
}

beforeAll(async () => {
  // The dev-seed boot — the same instrumentation path the e2e/preview use.
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
});

afterAll(() => {
  // Restore the process env AFTER the file's tests — per-test deletion made
  // every test after the first take the real-session path (401 envelope).
  delete process.env.DON_DEV_SEED;
});

describe('GET /api/v1/dashboard — dev-seed integration', () => {
  it('serves the seeded aggregate: buckets, hash-chained ledger, payouts, readiness', async () => {
    const response = await GET(dashboardRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;

    // The greeting voice — the dev-seed persona.
    const user = body.user as { stage_name: string; initials: string };
    expect(user.stage_name).toBe('Nova Reign');
    expect(user.initials).toBe('NR');

    // The three vault buckets — the engine math: 327_485 pending in, 150_000
    // released to available, 70_000 drained into in-flight payouts, 45_000
    // reserve.
    const vault = body.vault as Record<string, number | string>;
    expect(vault.payee_id).toBe('rh_nova_reign_don');
    expect(vault.available_balance).toBe(80_000);
    expect(vault.pending_balance).toBe(247_485);
    expect(vault.reserve_balance).toBe(45_000);
  });

  it('returns holder-scoped journals with balanced legs and the hash chain intact', async () => {
    const response = await GET(dashboardRequest());
    const body = (await response.json()) as {
      ledger: Array<{
        journal: {
          id: string;
          kind: string;
          prev_hash: string;
          entry_hash: string;
          created_at: string;
        };
        entries: Array<{ account: string; debit_cents: number; credit_cents: number }>;
      }>;
      transactions: Array<{ id: string; entry_hash_short: string; amount_cents: number }>;
    };

    expect(body.ledger.length).toBeGreaterThan(0);
    for (const { journal, entries } of body.ledger) {
      // Every journal belongs to this holder — a leg on the holder's vault
      // account (holder-scoping is the resolver's contract).
      expect(entries.some((entry) => entry.account.includes('rh_nova_reign_don'))).toBe(true);
      // GL integrity: debits equal credits on every returned journal.
      const debits = entries.reduce((sum, entry) => sum + entry.debit_cents, 0);
      const credits = entries.reduce((sum, entry) => sum + entry.credit_cents, 0);
      expect(debits).toBe(credits);
      expect(journal.entry_hash).toHaveLength(64);
    }
    // Newest first.
    for (let i = 1; i < body.ledger.length; i += 1) {
      // ISO timestamps order lexicographically.
      expect(body.ledger[i - 1].journal.created_at >= body.ledger[i].journal.created_at).toBe(true);
    }
  });

  it('carries entry_hash_short on every display transaction row', async () => {
    const response = await GET(dashboardRequest());
    const body = (await response.json()) as {
      ledger: Array<{ journal: { id: string; entry_hash: string } }>;
      transactions: Array<{ id: string; entry_hash_short: string }>;
    };

    expect(body.transactions.length).toBe(body.ledger.length);
    const hashes = new Map(body.ledger.map(({ journal }) => [journal.id, journal.entry_hash]));
    for (const row of body.transactions) {
      const full = hashes.get(row.id);
      expect(full).toBeDefined();
      expect(row.entry_hash_short).toBe(full!.slice(0, 12));
    }
  });

  it('attributes payout states to their sandbox rails', async () => {
    const response = await GET(dashboardRequest());
    const body = (await response.json()) as {
      payouts: Array<{
        hold: { amount_cents: number; status: string; payee_id: string };
        rail: string;
        provider: string;
      }>;
    };

    expect(body.payouts).toHaveLength(2);
    const byRail = new Map(body.payouts.map((payout) => [payout.rail, payout]));
    expect(byRail.get('rtp')?.hold.amount_cents).toBe(25_000);
    expect(byRail.get('ach')?.hold.amount_cents).toBe(45_000);
    for (const payout of body.payouts) {
      expect(payout.hold.status).toBe('in_flight');
      expect(payout.hold.payee_id).toBe('rh_nova_reign_don');
      // The sandbox rail stamps the adapter's provider field; sandbox is the MODE.
      expect(payout.provider).toBe('column');
    }
  });

  it('carries the readiness rows for the persona', async () => {
    const response = await GET(dashboardRequest());
    const body = (await response.json()) as {
      readiness: {
        kyc_status: string;
        tin_verified: number;
        w9_on_file: number;
        bank_account_linked: boolean;
        provisioning_status: string;
      };
    };

    expect(body.readiness).toEqual({
      kyc_status: 'APPROVED',
      tin_verified: 1,
      w9_on_file: 1,
      bank_account_linked: true,
      provisioning_status: 'PROVISIONED',
    });
  });
});
