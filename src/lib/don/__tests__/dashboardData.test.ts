/**
 * The display model — invariants carried from the fixtures era onto live
 * store data: every row speaks the GL shape (exactly one live side of the
 * debit/credit pair, signed amount DERIVED from the pair), holder-scoped
 * journals only, newest first, and every row carries the journal's
 * entry_hash short form for auditability.
 */

import { describe, expect, it } from 'vitest';

import {
  displayTransaction,
  displayTransactions,
  payoutTiles,
  type DashboardLedgerEntry,
  type DashboardPayout,
} from '@/lib/don/dashboardData';
import { GL_ACCOUNT_FBO_CASH, vaultGlAccount } from '@/modules/don/constants';

const PAYEE = 'rh_nova_reign_don';

/** A royalty_ingest journal with its legs — money in, holder's pending. */
function royaltyEntry(
  id: string,
  sequence: number,
  createdAt: string,
  amountCents: number,
  payee = PAYEE,
): DashboardLedgerEntry {
  return {
    journal: {
      id,
      kind: 'royalty_ingest',
      ref_type: 'dsp_report',
      ref_id: `dsp_${id}`,
      created_at: createdAt,
      sequence,
      prev_hash: '0'.repeat(64),
      entry_hash: 'a'.repeat(64),
      state: 'posted',
    },
    entries: [
      {
        id: `${id}_fbo`,
        journal_id: id,
        account: GL_ACCOUNT_FBO_CASH,
        debit_cents: amountCents,
        credit_cents: 0,
        created_at: createdAt,
      },
      {
        id: `${id}_vault`,
        journal_id: id,
        account: vaultGlAccount(payee, 'pending'),
        debit_cents: 0,
        credit_cents: amountCents,
        created_at: createdAt,
      },
    ],
  };
}

/** A payout_hold journal — money out, the holder's available drained. */
function payoutEntry(
  id: string,
  sequence: number,
  createdAt: string,
  amountCents: number,
  payee = PAYEE,
): DashboardLedgerEntry {
  return {
    journal: {
      id,
      kind: 'payout_hold',
      ref_type: 'baas_transfer',
      ref_id: `tx_${id}`,
      created_at: createdAt,
      sequence,
      prev_hash: '0'.repeat(64),
      entry_hash: 'b'.repeat(64),
      state: 'posted',
    },
    entries: [
      {
        id: `${id}_avail`,
        journal_id: id,
        account: vaultGlAccount(payee, 'available'),
        debit_cents: amountCents,
        credit_cents: 0,
        created_at: createdAt,
      },
      {
        id: `${id}_fbo`,
        journal_id: id,
        account: GL_ACCOUNT_FBO_CASH,
        debit_cents: 0,
        credit_cents: amountCents,
        created_at: createdAt,
      },
    ],
  };
}

describe('display transactions — the GL projection', () => {
  it('projects holder-scoped journals onto rows with exact debit/credit pairs', () => {
    const ledger = [royaltyEntry('j1', 1, '2026-09-01T00:00:00.000Z', 12_990)];
    const rows = displayTransactions(ledger, PAYEE);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe('j1');
    // Exactly one live side, integer cents, the signed amount derived.
    expect([row.debit_cents, row.credit_cents].filter((side) => side !== 0)).toHaveLength(1);
    expect(row.debit_cents).toBe(0);
    expect(row.credit_cents).toBe(12_990);
    expect(row.amount_cents).toBe(12_990);
  });

  it('carries the journal entry_hash short form on every row (auditability)', () => {
    const ledger = [royaltyEntry('j1', 1, '2026-09-01T00:00:00.000Z', 12_990)];
    const rows = displayTransactions(ledger, PAYEE);

    expect(rows[0].entry_hash_short).toBe('a'.repeat(12));
    expect(rows[0].entry_hash_short.length).toBe(12);
  });

  it('signs inflows positive and outflows negative', () => {
    const ledger = [
      royaltyEntry('j_in', 1, '2026-09-01T00:00:00.000Z', 12_990),
      payoutEntry('j_out', 2, '2026-09-02T00:00:00.000Z', 25_000),
    ];
    const rows = displayTransactions(ledger, PAYEE);
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get('j_in')?.amount_cents).toBeGreaterThan(0);
    expect(byId.get('j_out')?.amount_cents).toBeLessThan(0);
    expect(Math.abs(byId.get('j_out')!.amount_cents)).toBe(25_000);
  });

  it("is holder-scoped: journals without this payee's vault legs never render", () => {
    const otherPayeeLedger: DashboardLedgerEntry[] = [
      royaltyEntry('fx_other', 1, '2026-09-01T00:00:00.000Z', 500, 'rh_someone_else'),
    ];
    // A ledger that never touches the holder's vault legs projects to nothing.
    expect(displayTransactions(otherPayeeLedger, PAYEE)).toEqual([]);
    // The projection is driven by the payee under test.
    expect(displayTransaction('rh_someone_else', otherPayeeLedger[0])).not.toBeNull();
  });

  it('sorts newest first deterministically', () => {
    const ledger = [
      royaltyEntry('j_old', 1, '2026-09-01T00:00:00.000Z', 12_990),
      payoutEntry('j_new', 2, '2026-09-02T00:00:00.000Z', 25_000),
      royaltyEntry('j_mid', 3, '2026-09-01T12:00:00.000Z', 4_750),
    ];
    const rows = displayTransactions(ledger, PAYEE);

    expect(rows.map((row) => row.id)).toEqual(['j_new', 'j_mid', 'j_old']);
  });
});

describe('payout tiles — the sandbox rail vocabulary', () => {
  it('renders RTP as instant and ACH as +3 business days, over hold records', () => {
    const payouts: DashboardPayout[] = [
      {
        hold: {
          transfer_id: 'tx_rtp',
          payee_id: PAYEE,
          amount_cents: 25_000,
          status: 'in_flight',
          created_at: '2026-09-08T14:00:00.000Z',
        },
        rail: 'rtp',
        provider: 'column', // the transfer record's adapter field (sandbox MODE, not a provider name)
      },
      {
        hold: {
          transfer_id: 'tx_ach',
          payee_id: PAYEE,
          amount_cents: 45_000,
          status: 'in_flight',
          created_at: '2026-09-08T14:05:00.000Z',
        },
        rail: 'ach',
        provider: 'column',
      },
    ];
    const tiles = payoutTiles(payouts);

    expect(tiles).toHaveLength(2);
    const byRail = new Map(tiles.map((tile) => [tile.rail, tile]));
    expect(byRail.get('rtp')?.eta_label).toBe('Instant');
    expect(byRail.get('ach')?.eta_label).toBe('+3 business days');
    for (const tile of tiles) {
      expect(['in_flight', 'settled', 'reversed']).toContain(tile.status);
      expect(Number.isInteger(tile.amount_cents)).toBe(true);
      expect(tile.rail_label).toBe(tile.rail.toUpperCase());
    }
  });
});
