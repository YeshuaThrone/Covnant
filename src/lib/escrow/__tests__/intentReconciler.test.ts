
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaxProfile } from '@/engine/covenant-master-sdk';
import {
  escrowPayoutReversalTransactionId,
  escrowPayoutTransactionId,
  findIntentByTransferId,
  findTransferIdForIntent,
  reconcileTransferOutcome,
} from '../intentReconciler';
import { fetchEscrowBalance } from '../balance';
import {
  fakeEscrowDb,
  type FakeEscrowDb,
  type FakeIntentSeed,
} from '@/app/api/payouts/withdraw/__tests__/fakeEscrowDb';

/**
 * The reconciliation core, against the shared stateful escrow fake: the
 * guard-first settle/release resolutions, the deterministic ledger ids, and
 * the exact release math (a released hold restores available to its
 * pre-reserve level — never more, never less).
 */

const HOLDER = 'rh_1';
const INTENT_ID = 'wi_race_target';
const TRANSFER_ID = 'tr_recon_1';

/** Ledger gross of 2.00 for rh_1 → 24% tax 0.48 → available 1.52 (152M units). */
const grossLedgerRows = [{ disbursements: [{ rightsHolderId: HOLDER, grossShare: 2.0 }] }];
const ONE_DOLLAR_UNITS = 100_000_000n;
const PRE_RESERVE_AVAILABLE = 152_000_000n;

function unverifiedUsProfile(): TaxProfile {
  return {
    taxFormType: 'W9_US_PERSON',
    taxIdentifierEncrypted: 'test-identifier',
    usTaxResident: true,
    isBackupWithholdingRequired: false,
    isVerified: false,
  };
}

/** The debit row a completed payout wrote — deterministic id, string units. */
function payoutDebitRow(intentId: string, plaidTransferId: string) {
  return {
    transaction_id: escrowPayoutTransactionId(intentId),
    transaction_type: 'DISBURSEMENT',
    currency: 'USD',
    disbursements: [
      {
        type: 'DISBURSEMENT',
        rightsHolderId: HOLDER,
        payoutAmount: ONE_DOLLAR_UNITS.toString(),
        amountPaid: '76000000',
        taxWithheld: '24000000',
        plaidTransferId,
        timestamp: 1,
      },
    ],
  };
}

function makeDb(
  seedIntents: FakeIntentSeed[] = [],
  ledgerData: unknown[] = [...grossLedgerRows],
  extra: { hideLedgerTransactionIdOnce?: string } = {},
) {
  return fakeEscrowDb({
    holderRow: { plaid_access_token: 'access-sandbox-token', plaid_account_id: 'acc_1', method: 'ACH' },
    // The reconciler re-derives the holder's tax split from cbt_assets at
    // completion time — seed rh_1 so the derivation resolves the same
    // profile the explicit balance reads pass.
    assetRows: [
      [
        {
          id: HOLDER,
          name: 'Holder One',
          role: 'COMPOSER',
          splitPercentage: 100,
          taxProfile: unverifiedUsProfile(),
          confirmedByArtist: true,
        },
      ],
    ],
    ledgerData,
    taxProfile: unverifiedUsProfile(),
    rightsHolderId: HOLDER,
    seedIntents,
    ...extra,
  });
}

describe('reconcileTransferOutcome — settle', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('completes the ledger debit (deterministic id) then settles the hold', async () => {
    const fake = makeDb();
    fake.intents.push({
      id: INTENT_ID,
      rights_holder_id: HOLDER,
      amount_units: ONE_DOLLAR_UNITS.toString(),
      status: 'pending',
      plaid_transfer_id: TRANSFER_ID,
      settled_at: null,
      released_at: null,
      created_at: new Date().toISOString(),
    });

    const resolution = await reconcileTransferOutcome(fake.db, {
      intentId: INTENT_ID,
      plaidTransferId: TRANSFER_ID,
      outcome: 'settle',
    });

    expect(resolution).toEqual({
      intentId: INTENT_ID,
      outcome: 'settle',
      resolved: true,
      alreadyResolved: false,
      ledger: 'debit_completed',
    });
    expect(fake.intents[0]).toMatchObject({ status: 'settled', settled_at: expect.any(String) });
    // Exactly one ledger write — the completing debit under the route's
    // deterministic id, holding the payout split the balance math reads.
    expect(fake.inserts).toHaveLength(1);
    const row = fake.inserts[0] as { transaction_id: string; disbursements: unknown[] };
    expect(row.transaction_id).toBe(escrowPayoutTransactionId(INTENT_ID));
    expect(row.disbursements[0]).toMatchObject({
      type: 'DISBURSEMENT',
      rightsHolderId: HOLDER,
      payoutAmount: ONE_DOLLAR_UNITS.toString(),
      amountPaid: '76000000',
      taxWithheld: '24000000',
      plaidTransferId: TRANSFER_ID,
    });
    // Balance-neutral conversion: pending subtraction became payout
    // subtraction — available is unchanged by the settlement itself.
    const balance = await fetchEscrowBalance(fake.db, HOLDER, unverifiedUsProfile());
    expect(balance.availableUnits).toBe(52_000_000n);
  });

  it('replays a settled intent as an acknowledged no-op with no ledger writes', async () => {
    const fake = makeDb([{ id: INTENT_ID, amount_units: ONE_DOLLAR_UNITS.toString() }]);
    fake.forceSettle(INTENT_ID, TRANSFER_ID);

    const resolution = await reconcileTransferOutcome(fake.db, {
      intentId: INTENT_ID,
      plaidTransferId: TRANSFER_ID,
      outcome: 'settle',
    });

    expect(resolution).toMatchObject({ resolved: false, alreadyResolved: true, ledger: 'none' });
    expect(fake.inserts).toHaveLength(0);
  });

  it('converges when the debit row already exists (settle-flip-failed case)', async () => {
    const fake = makeDb([], [...grossLedgerRows, payoutDebitRow(INTENT_ID, TRANSFER_ID)]);
    fake.intents.push({
      id: INTENT_ID,
      rights_holder_id: HOLDER,
      amount_units: ONE_DOLLAR_UNITS.toString(),
      status: 'pending',
      plaid_transfer_id: TRANSFER_ID,
      settled_at: null,
      released_at: null,
      created_at: new Date().toISOString(),
    });

    const resolution = await reconcileTransferOutcome(fake.db, {
      intentId: INTENT_ID,
      plaidTransferId: TRANSFER_ID,
      outcome: 'settle',
    });

    expect(resolution).toMatchObject({ resolved: true, ledger: 'debit_already_present' });
    expect(fake.inserts).toHaveLength(0);
    expect(fake.intents[0]).toMatchObject({ status: 'settled' });
  });

  it('converges on a 23505 unique race instead of writing twice', async () => {
    // The concurrent writer's debit row commits between this resolver's
    // read (hidden once — the race window) and its insert: the UNIQUE
    // violation IS the convergence signal, and the hold settles once.
    const fake = makeDb([], [...grossLedgerRows, payoutDebitRow(INTENT_ID, TRANSFER_ID)], {
      hideLedgerTransactionIdOnce: escrowPayoutTransactionId(INTENT_ID),
    });
    fake.intents.push({
      id: INTENT_ID,
      rights_holder_id: HOLDER,
      amount_units: ONE_DOLLAR_UNITS.toString(),
      status: 'pending',
      plaid_transfer_id: TRANSFER_ID,
      settled_at: null,
      released_at: null,
      created_at: new Date().toISOString(),
    });

    const resolution = await reconcileTransferOutcome(fake.db, {
      intentId: INTENT_ID,
      plaidTransferId: TRANSFER_ID,
      outcome: 'settle',
    });

    // The concurrent writer's row is the record of truth; this attempt's
    // insert lost the race and the hold still settles exactly once.
    expect(resolution).toMatchObject({ resolved: true, ledger: 'debit_already_present' });
    expect(fake.intents[0]).toMatchObject({ status: 'settled' });
    const balance = await fetchEscrowBalance(fake.db, HOLDER, unverifiedUsProfile());
    expect(balance.availableUnits).toBe(52_000_000n);
  });

  it('records the posted-after-release pathology: completes the debit, never flips', async () => {
    const fake = makeDb([{ id: INTENT_ID, amount_units: ONE_DOLLAR_UNITS.toString() }]);
    fake.forceRelease(INTENT_ID);

    const resolution = await reconcileTransferOutcome(fake.db, {
      intentId: INTENT_ID,
      plaidTransferId: TRANSFER_ID,
      outcome: 'settle',
    });

    expect(resolution).toMatchObject({ resolved: false, alreadyResolved: true, ledger: 'debit_completed' });
    expect(fake.intents[0]).toMatchObject({ status: 'released' });
    expect(fake.inserts).toHaveLength(1);
    // The money moved — the ledger must say so; the operator review flag is
    // the reconciler's contract for this divergence.
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('RELEASED'));
  });

  it('stays pending when the ledger write fails for a non-race reason', async () => {
    const fake = makeDb();
    fake.setInsertError({ code: '42P01', message: 'relation "universal_royalty_ledger" does not exist' });
    fake.intents.push({
      id: INTENT_ID,
      rights_holder_id: HOLDER,
      amount_units: ONE_DOLLAR_UNITS.toString(),
      status: 'pending',
      plaid_transfer_id: TRANSFER_ID,
      settled_at: null,
      released_at: null,
      created_at: new Date().toISOString(),
    });

    await expect(
      reconcileTransferOutcome(fake.db, {
        intentId: INTENT_ID,
        plaidTransferId: TRANSFER_ID,
        outcome: 'settle',
      }),
    ).rejects.toThrow();
    expect(fake.intents[0]).toMatchObject({ status: 'pending' });
  });
});

describe('reconcileTransferOutcome — release', () => {
  it('releases a clean hold with NO ledger writes and restores available exactly', async () => {
    const fake = makeDb();
    fake.intents.push({
      id: INTENT_ID,
      rights_holder_id: HOLDER,
      amount_units: ONE_DOLLAR_UNITS.toString(),
      status: 'pending',
      plaid_transfer_id: TRANSFER_ID,
      settled_at: null,
      released_at: null,
      created_at: new Date().toISOString(),
    });
    const held = await fetchEscrowBalance(fake.db, HOLDER, unverifiedUsProfile());
    expect(held.availableUnits).toBe(PRE_RESERVE_AVAILABLE - ONE_DOLLAR_UNITS);

    const resolution = await reconcileTransferOutcome(fake.db, {
      intentId: INTENT_ID,
      plaidTransferId: TRANSFER_ID,
      outcome: 'release',
    });

    expect(resolution).toEqual({
      intentId: INTENT_ID,
      outcome: 'release',
      resolved: true,
      alreadyResolved: false,
      ledger: 'none',
    });
    expect(fake.inserts).toHaveLength(0);
    const restored = await fetchEscrowBalance(fake.db, HOLDER, unverifiedUsProfile());
    // EXACT restoration: the released hold returns every held unit —
    // available returns to the pre-reserve level, never above.
    expect(restored.availableUnits).toBe(PRE_RESERVE_AVAILABLE);
    expect(restored.availableUnits - held.availableUnits).toBe(ONE_DOLLAR_UNITS);
  });

  it('unwinds the erroneous debit with a deterministic reversal before releasing', async () => {
    // The route's debit landed but its settle flip failed (#5), then the
    // rail failed the transfer: the pool currently double-counts the
    // payout AND the pending hold.
    const fake = makeDb([], [...grossLedgerRows, payoutDebitRow(INTENT_ID, TRANSFER_ID)]);
    fake.intents.push({
      id: INTENT_ID,
      rights_holder_id: HOLDER,
      amount_units: ONE_DOLLAR_UNITS.toString(),
      status: 'pending',
      plaid_transfer_id: TRANSFER_ID,
      settled_at: null,
      released_at: null,
      created_at: new Date().toISOString(),
    });
    const stuck = await fetchEscrowBalance(fake.db, HOLDER, unverifiedUsProfile());
    expect(stuck.availableUnits).toBe(152_000_000n - 2n * ONE_DOLLAR_UNITS);

    const resolution = await reconcileTransferOutcome(fake.db, {
      intentId: INTENT_ID,
      plaidTransferId: TRANSFER_ID,
      outcome: 'release',
    });

    expect(resolution).toMatchObject({ resolved: true, ledger: 'reversal_written' });
    // The compensating entry mirrors the debit's split NEGATED — never an
    // absolute-total write — under the deterministic reversal id.
    expect(fake.inserts).toHaveLength(1);
    const row = fake.inserts[0] as { transaction_id: string; disbursements: Array<{ payoutAmount: string; amountPaid: string; taxWithheld: string }> };
    expect(row.transaction_id).toBe(escrowPayoutReversalTransactionId(INTENT_ID));
    expect(row.disbursements[0]).toMatchObject({
      payoutAmount: `-${ONE_DOLLAR_UNITS.toString()}`,
      amountPaid: '-76000000',
      taxWithheld: '-24000000',
    });
    const restored = await fetchEscrowBalance(fake.db, HOLDER, unverifiedUsProfile());
    expect(restored.availableUnits).toBe(PRE_RESERVE_AVAILABLE);
  });

  it('replays a released intent as an acknowledged no-op', async () => {
    const fake = makeDb([{ id: INTENT_ID, amount_units: ONE_DOLLAR_UNITS.toString() }]);
    fake.forceRelease(INTENT_ID);

    const resolution = await reconcileTransferOutcome(fake.db, {
      intentId: INTENT_ID,
      plaidTransferId: TRANSFER_ID,
      outcome: 'release',
    });

    expect(resolution).toMatchObject({ resolved: false, alreadyResolved: true, ledger: 'none' });
    expect(fake.inserts).toHaveLength(0);
  });

  it('reverses a settled conversion but keeps the intent settled', async () => {
    const fake = makeDb([{ id: INTENT_ID, amount_units: ONE_DOLLAR_UNITS.toString() }], [
      ...grossLedgerRows,
      payoutDebitRow(INTENT_ID, TRANSFER_ID),
    ]);
    fake.forceSettle(INTENT_ID, TRANSFER_ID);
    const converted = await fetchEscrowBalance(fake.db, HOLDER, unverifiedUsProfile());
    expect(converted.availableUnits).toBe(52_000_000n);

    const resolution = await reconcileTransferOutcome(fake.db, {
      intentId: INTENT_ID,
      plaidTransferId: TRANSFER_ID,
      outcome: 'release',
    });

    // No hold left to flip — the reversal entry alone restores the pool.
    expect(resolution).toMatchObject({ resolved: false, ledger: 'reversal_written' });
    expect(fake.intents[0]).toMatchObject({ status: 'settled' });
    const restored = await fetchEscrowBalance(fake.db, HOLDER, unverifiedUsProfile());
    expect(restored.availableUnits).toBe(PRE_RESERVE_AVAILABLE);
  });
});

describe('reconcileTransferOutcome — concurrent resolvers', () => {
  it('admits exactly one settlement when the webhook and the sweep race', async () => {
    const ledgerRows: unknown[] = [...grossLedgerRows];
    const fake = makeDb([], ledgerRows);
    fake.intents.push({
      id: INTENT_ID,
      rights_holder_id: HOLDER,
      amount_units: ONE_DOLLAR_UNITS.toString(),
      status: 'pending',
      plaid_transfer_id: TRANSFER_ID,
      settled_at: null,
      released_at: null,
      created_at: new Date().toISOString(),
    });

    const [webhook, sweep] = await Promise.all([
      reconcileTransferOutcome(fake.db, { intentId: INTENT_ID, plaidTransferId: TRANSFER_ID, outcome: 'settle' }),
      reconcileTransferOutcome(fake.db, { intentId: INTENT_ID, plaidTransferId: TRANSFER_ID, outcome: 'settle' }),
    ]);

    const winners = [webhook, sweep].filter((r) => r.resolved);
    expect(winners).toHaveLength(1);
    expect(fake.intents[0]).toMatchObject({ status: 'settled' });
    // Exactly one committed debit row, whatever the loser's insert raced to.
    expect(fake.inserts.length - (ledgerRows.length - 1)).toBeLessThanOrEqual(1);
    expect(ledgerRows.filter((row) => (row as { transaction_id?: string }).transaction_id === escrowPayoutTransactionId(INTENT_ID))).toHaveLength(1);
  });

  it('admits exactly one resolution when settle and release race on the same intent', async () => {
    const fake = makeDb();
    fake.intents.push({
      id: INTENT_ID,
      rights_holder_id: HOLDER,
      amount_units: ONE_DOLLAR_UNITS.toString(),
      status: 'pending',
      plaid_transfer_id: TRANSFER_ID,
      settled_at: null,
      released_at: null,
      created_at: new Date().toISOString(),
    });

    const [settle, release] = await Promise.all([
      reconcileTransferOutcome(fake.db, { intentId: INTENT_ID, plaidTransferId: TRANSFER_ID, outcome: 'settle' }),
      reconcileTransferOutcome(fake.db, { intentId: INTENT_ID, plaidTransferId: TRANSFER_ID, outcome: 'release' }),
    ]);

    const resolutions = [settle, release];
    expect(resolutions.filter((r) => r.resolved)).toHaveLength(1);
    // Terminal either way — no resolver can leave the hold pending.
    expect(['settled', 'released']).toContain(fake.intents[0].status);
  });
});

describe('intent lookup helpers', () => {
  it('findIntentByTransferId prefers the pending hold over a terminal row', async () => {
    const fake = makeDb([{ id: 'wi_old', amount_units: ONE_DOLLAR_UNITS.toString() }]);
    fake.forceSettle('wi_old', 'tr_same');
    fake.intents.push({
      id: INTENT_ID,
      rights_holder_id: HOLDER,
      amount_units: ONE_DOLLAR_UNITS.toString(),
      status: 'pending',
      plaid_transfer_id: 'tr_same',
      settled_at: null,
      released_at: null,
      created_at: new Date().toISOString(),
    });

    const intent = await findIntentByTransferId(fake.db, 'tr_same');
    expect(intent?.id).toBe(INTENT_ID);
    expect(intent?.status).toBe('pending');
  });

  it('findIntentByTransferId falls back to the terminal row and nulls on nothing', async () => {
    const fake = makeDb([{ id: 'wi_done', amount_units: ONE_DOLLAR_UNITS.toString() }]);
    fake.forceSettle('wi_done', 'tr_done');
    expect((await findIntentByTransferId(fake.db, 'tr_done'))?.id).toBe('wi_done');
    expect(await findIntentByTransferId(fake.db, 'tr_missing')).toBeNull();
  });

  it('findTransferIdForIntent recovers the id from the deterministic debit row', async () => {
    const fake = makeDb([], [...grossLedgerRows, payoutDebitRow(INTENT_ID, 'tr_from_ledger')]);
    expect(await findTransferIdForIntent(fake.db, INTENT_ID)).toBe('tr_from_ledger');
    expect(await findTransferIdForIntent(fake.db, 'wi_no_row')).toBeNull();
  });
});
