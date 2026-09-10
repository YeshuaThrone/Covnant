/**
 * Dashboard fixtures invariants — the shape contract that makes the live
 * swap a type-check, not a rewrite. Pins:
 *
 *  - the three account cards ARE the three vault buckets (available /
 *    pending / reserve), integer cents, non-negative;
 *  - every fixture journal balances — GL integrity (Σ debits = Σ credits,
 *    money moves) — and every leg uses canonical accounts;
 *  - display transactions carry the debit/credit PAIR (exactly one side
 *    non-zero), holder-scoped, newest first;
 *  - payout tiles speak the canonical sandbox-rail vocabulary (RTP instant,
 *    ACH +3 business days) over PayoutHoldRecord statuses;
 *  - the provider hands out FRESH data per call — a mutating consumer
 *    cannot corrupt another consumer's view.
 */

import { describe, expect, it } from 'vitest';

import {
  displayTransaction,
  displayTransactions,
  fixturesDashboardDataProvider,
  payoutTiles,
  type DashboardLedgerEntry,
} from '@/lib/don/dashboardFixtures';
import {
  GL_ACCOUNT_FBO_CASH,
  JOURNAL_KINDS,
  VAULT_BUCKETS,
  vaultGlAccount,
} from '@/modules/don/constants';
import { validateJournal } from '@/modules/ledger/journal';

const { getDashboardData } = fixturesDashboardDataProvider;

describe('dashboard fixtures — the vault buckets', () => {
  it('carries all three buckets as integer cents, non-negative', async () => {
    const { vault } = await getDashboardData();

    // The SovereignVaultRecord shape — the three account cards map 1:1.
    for (const bucket of ['available_balance', 'pending_balance', 'reserve_balance'] as const) {
      expect(vault, `bucket ${bucket} missing`).toHaveProperty(bucket);
      const cents = vault[bucket];
      expect(Number.isInteger(cents), `${bucket} must be integer cents, got ${cents}`).toBe(true);
      expect(cents, `${bucket} must not be negative`).toBeGreaterThanOrEqual(0);
    }
  });

  it('types the vault as a SovereignVaultRecord payee — holder-scoped data', async () => {
    const { vault, ledger, payouts } = await getDashboardData();
    expect(vault.payee_id).toBeTruthy();
    expect(vault.payee_name).toBeTruthy();
    // Everything is the same holder — the dashboard never mixes wallets.
    for (const { journal } of ledger) expect(journal.id).toBeTruthy();
    for (const { hold } of payouts) expect(hold.payee_id).toBe(vault.payee_id);
  });
});

describe('dashboard fixtures — the GL ledger', () => {
  it('builds every journal with balanced debit/credit legs and money that moves', async () => {
    const { ledger } = await getDashboardData();
    expect(ledger.length).toBeGreaterThan(0);

    for (const { journal, entries } of ledger) {
      // Canonical journal kind — no invented kinds.
      expect(JOURNAL_KINDS).toContain(journal.kind);
      // The merged GlEntryRecord shape: exactly one side carries the amount.
      for (const leg of entries) {
        expect(leg.journal_id).toBe(journal.id);
        const pair = [leg.debit_cents, leg.credit_cents];
        expect(pair.some((side) => side !== 0), `leg ${leg.id} must move money`).toBe(true);
        expect(
          pair.every((side) => side === 0 || Number.isInteger(side)),
          `leg ${leg.id} must be integer cents`,
        ).toBe(true);
      }
      // GL integrity — the engine's own validator on the fixture legs.
      const validity = validateJournal(
        entries.map((leg) => ({
          account: leg.account,
          debit_cents: leg.debit_cents,
          credit_cents: leg.credit_cents,
        })),
      );
      expect(validity.ok, `journal ${journal.id} must balance: ${JSON.stringify(validity)}`).toBe(true);
    }
  });

  it('posts legs only on canonical GL accounts (vault buckets + FBO cash)', async () => {
    const { ledger, vault } = await getDashboardData();
    const canonicalAccounts = new Set<string>([
      GL_ACCOUNT_FBO_CASH,
      ...VAULT_BUCKETS.map((bucket) => vaultGlAccount(vault.payee_id, bucket)),
    ]);
    for (const { entries } of ledger) {
      for (const leg of entries) {
        expect(canonicalAccounts.has(leg.account), `non-canonical account: ${leg.account}`).toBe(true);
      }
    }
  });

  it('exercises the payout flow end to end: hold from available, settled out of pending', async () => {
    const { ledger, vault } = await getDashboardData();
    const hold = ledger.find(({ journal }) => journal.kind === 'payout_hold');
    const settled = ledger.find(({ journal }) => journal.kind === 'payout_settled');
    expect(hold).toBeDefined();
    expect(settled).toBeDefined();
    // payout_hold: available → pending (the in-flight hold). payout_settled:
    // pending leaves through the rail via FBO cash.
    expect(
      hold!.entries.some(
        (e) => e.account === vaultGlAccount(vault.payee_id, 'available') && e.debit_cents > 0,
      ),
    ).toBe(true);
    expect(
      hold!.entries.some(
        (e) => e.account === vaultGlAccount(vault.payee_id, 'pending') && e.credit_cents > 0,
      ),
    ).toBe(true);
    expect(settled!.entries.some((e) => e.account === GL_ACCOUNT_FBO_CASH && e.credit_cents > 0)).toBe(true);
  });
});

describe('display transactions — debit/credit pairs on every row', () => {
  it('projects each journal onto one holder-facing row with an exact leg pair', async () => {
    const { ledger, vault } = await getDashboardData();
    const rows = displayTransactions(ledger, vault.payee_id);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const pair = [row.debit_cents, row.credit_cents];
      // Exactly one side non-zero, integer cents — the GlEntryRecord shape.
      expect(pair.filter((side) => side !== 0)).toHaveLength(1);
      expect(pair.every((side) => Number.isInteger(side))).toBe(true);
      // The signed display amount is DERIVED from the pair, never independent.
      expect(Math.abs(row.amount_cents)).toBe(Math.max(row.debit_cents, row.credit_cents));
      expect(row.amount_cents).not.toBe(0);
    }
  });

  it('signs inflows positive and outflows negative', async () => {
    const { ledger, vault } = await getDashboardData();
    const rows = displayTransactions(ledger, vault.payee_id);
    const kindOf = (id: string): string =>
      ledger.find(({ journal }) => journal.id === id)?.journal.kind ?? '';

    // royalty_ingest/pending_release → money in; payout_hold/settled → out.
    for (const row of rows) {
      const kind = kindOf(row.id);
      if (kind === 'royalty_ingest' || kind === 'pending_release') {
        expect(row.amount_cents, `${kind} must display as inflow`).toBeGreaterThan(0);
      }
      if (kind === 'payout_hold' || kind === 'payout_settled') {
        expect(row.amount_cents, `${kind} must display as outflow`).toBeLessThan(0);
      }
    }
  });

  it("is holder-scoped: journals without this payee's vault legs never render", () => {
    const otherPayeeLedger: DashboardLedgerEntry[] = [
      {
        journal: {
          id: 'fx_other',
          kind: 'royalty_ingest',
          ref_type: 'dsp_report',
          ref_id: 'x',
          created_at: '2026-09-01T00:00:00.000Z',
          sequence: 0,
          prev_hash: 'g',
          entry_hash: 'h',
          state: 'posted',
        },
        entries: [
          {
            id: 'l1',
            journal_id: 'fx_other',
            account: GL_ACCOUNT_FBO_CASH,
            debit_cents: 500,
            credit_cents: 0,
            created_at: '2026-09-01T00:00:00.000Z',
          },
          {
            id: 'l2',
            journal_id: 'fx_other',
            account: vaultGlAccount('rh_someone_else', 'pending'),
            debit_cents: 0,
            credit_cents: 500,
            created_at: '2026-09-01T00:00:00.000Z',
          },
        ],
      },
    ];
    // A ledger that never touches the holder's vault legs projects to nothing.
    expect(displayTransactions(otherPayeeLedger, 'rh_nova_reign_don')).toEqual([]);
    // The projection is driven by the payee under test, not the fixture's.
    expect(displayTransaction('rh_someone_else', otherPayeeLedger[0])).not.toBeNull();
  });

  it('sorts newest first deterministically', async () => {
    const { ledger, vault } = await getDashboardData();
    const rows = displayTransactions(ledger, vault.payee_id);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1].occurred_at >= rows[i].occurred_at).toBe(true);
    }
  });
});

describe('payout tiles — the sandbox rail vocabulary', () => {
  it('renders RTP as instant and ACH as +3 business days, over hold records', async () => {
    const { payouts } = await getDashboardData();
    const tiles = payoutTiles(payouts);

    expect(tiles.length).toBeGreaterThanOrEqual(2);
    const byRail = new Map(tiles.map((tile) => [tile.rail, tile]));
    expect(byRail.get('rtp')?.eta_label).toBe('Instant');
    expect(byRail.get('ach')?.eta_label).toBe('+3 business days');
    // Canonical hold vocabulary + integer cents.
    for (const tile of tiles) {
      expect(['in_flight', 'settled', 'reversed']).toContain(tile.status);
      expect(Number.isInteger(tile.amount_cents)).toBe(true);
      expect(tile.rail_label).toBe(tile.rail.toUpperCase());
    }
  });
});

describe('the provider seam', () => {
  it('serves fresh data per call — no shared mutable fixture references', async () => {
    const first = await getDashboardData();
    first.vault.available_balance = -1; // a hostile consumer
    const second = await getDashboardData();
    expect(second.vault.available_balance).toBeGreaterThan(0);
  });

  it('is the only data source the page needs — user, vault, ledger, payouts, readiness', async () => {
    const data = await getDashboardData();
    expect(data.user.stage_name).toBeTruthy();
    expect(data.user.initials).toBeTruthy();
    expect(data.readiness).toHaveProperty('kyc_status');
    expect(data.readiness).toHaveProperty('provisioning_status');
  });
});
