/**
 * Stateful fake of the escrow-side Supabase client, shared by the withdraw
 * route suites and the reconciliation suites (webhook, sweep, reconciler
 * core). It models the DB semantics the routes depend on (migration 0058):
 * the reserve RPC and the pending-intent read derive their numbers from the
 * SAME shared state, with the production pure math (escrowBalanceForHolder)
 * as the base pool. Reserves therefore serialize (the second rpc sees the
 * first's pending row and refuses) and a released hold restores the funds —
 * the observable behavior of the per-holder advisory lock, without a
 * database.
 *
 * Lifecycle helpers (forceSettle/forceRelease) model reconciliation by
 * hand; setInsertError lets a test arm the ledger-insert failure that the
 * audit's #5 scenario needs — including code '23505', the unique-violation
 * the reconciler's deterministic ledger ids converge on.
 *
 * Chain shapes modeled (additive — each later surface only added shapes):
 * - rights_holders:        select().eq().maybeSingle()
 * - cbt_assets:            select() awaited
 * - universal_royalty_ledger: select() awaited bare (fetchEscrowBalance);
 *     select().eq('transaction_id', id) awaited (reconciler's deterministic
 *     reads); insert(payload) — full payload preserved on commit so the
 *     deterministic-id reads and the balance math see the same rows.
 * - escrow_withdrawal_intents:
 *     select('amount_units').eq(holder).eq('status','pending')  (balance)
 *     select(cols).eq(col, val) awaited          (reconciler/webhook/sweep)
 *     select(cols).eq(col, val).limit(n) awaited (sweep's bounded batch)
 *     update(payload).eq('id', id).eq('status','pending').select() (flips,
 *       the stamp, and every guard-first resolution)
 */
import type { TaxProfile } from '@/engine/covenant-master-sdk';
import { escrowBalanceForHolder } from '@/lib/escrow/balance';

export interface FakeIntentRow {
  id: string;
  rights_holder_id: string;
  amount_units: string;
  status: 'pending' | 'settled' | 'released';
  plaid_transfer_id: string | null;
  settled_at: string | null;
  released_at: string | null;
  created_at: string;
}

export interface FakeEscrowDbOptions {
  holderRow?: unknown;
  assetRows?: unknown[];
  ledgerData?: unknown[];
  /** Profile the base pool's tax math runs with (same one the route resolves). */
  taxProfile: TaxProfile;
  rightsHolderId: string;
  insertError?: { code?: string; message: string } | null;
  metadataColumnMissing?: boolean;
  /** Pre-seeded PENDING intents — e.g. a stuck hold from an earlier failure. */
  seedIntents?: Array<{
    id: string;
    amount_units: string;
    rights_holder_id?: string;
    created_at?: string;
    plaid_transfer_id?: string | null;
  }>;
  /**
   * The ledger row carrying this transaction_id is invisible to the FIRST
   * ledger select only — the find-then-insert race window whose closure is
   * the reconciler's UNIQUE-violation convergence path.
   */
  hideLedgerTransactionIdOnce?: string;
}

/** The partial row shape tests seed — the fake fills holder/status defaults. */
export type FakeIntentSeed = NonNullable<FakeEscrowDbOptions['seedIntents']>[number];

export function fakeEscrowDb(options: FakeEscrowDbOptions) {
  const inserts: Record<string, unknown>[] = [];
  const intents: FakeIntentRow[] = (options.seedIntents ?? []).map((seed) => ({
    id: seed.id,
    rights_holder_id: seed.rights_holder_id ?? options.rightsHolderId,
    amount_units: seed.amount_units,
    status: 'pending' as const,
    plaid_transfer_id: seed.plaid_transfer_id ?? null,
    settled_at: null,
    released_at: null,
    created_at: seed.created_at ?? new Date().toISOString(),
  }));
  let insertError = options.insertError ?? null;
  let hideOnceConsumed = false;

  // Recomputed per call so tests can push restored ledger rows and the
  // reserve math sees them — the base pool is the production pure math
  // over the fake's ledger rows; the fake adds ONLY the pending state.
  const baseNow = () =>
    escrowBalanceForHolder({
      disbursementsByRow: (options.ledgerData ?? []).map((row) =>
        row !== null && typeof row === 'object' && 'disbursements' in row
          ? (row as { disbursements: unknown[] }).disbursements
          : [],
      ),
      rightsHolderId: options.rightsHolderId,
      taxProfile: options.taxProfile,
    });

  const pendingUnitsFor = (holderId: string) =>
    intents
      .filter((i) => i.status === 'pending' && i.rights_holder_id === holderId)
      .reduce((sum, i) => sum + BigInt(i.amount_units), 0n);

  const ledgerRows = () => options.ledgerData ?? [];

  /** A supabase-js-style thenable builder over a row set: awaitable, with the chain methods the modeled queries use. */
  const rowBuilder = (rows: unknown[]) => {
    const settled = Promise.resolve({ data: rows, error: null });
    return {
      eq: (col: string, val: unknown) =>
        Promise.resolve({
          data: rows.filter((row) => (row as Record<string, unknown>)[col] === val),
          error: null,
        }),
      limit: (n: number) => rowBuilder(rows.slice(0, n)),
      maybeSingle: () => settled.then((r) => ({ data: r.data[0] ?? null, error: null })),
      then: settled.then.bind(settled),
      catch: settled.catch.bind(settled),
      finally: settled.finally.bind(settled),
    };
  };

  const db = {
    from: (table: string) => {
      if (table === 'rights_holders') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: options.holderRow ?? null, error: null }),
            }),
          }),
        };
      }
      if (table === 'cbt_assets') {
        return {
          select: () =>
            Promise.resolve({
              data: (options.assetRows ?? []).map((rights_holders) => ({ rights_holders })),
              error: null,
            }),
        };
      }
      if (table === 'universal_royalty_ledger') {
        // fetchEscrowBalance reads this table via a bare select; the
        // reconciler's deterministic reads filter by transaction_id; the
        // payout/reversal writes land via insert — the fake serves all
        // three, failing the STAMPED attempt only when
        // metadataColumnMissing is set and any attempt when insertError is
        // armed (code '23505' = the UNIQUE convergence case).
        return {
          select: () => {
            let rows = ledgerRows();
            const hidden = options.hideLedgerTransactionIdOnce;
            if (hidden && !hideOnceConsumed) {
              hideOnceConsumed = true;
              rows = rows.filter((row) => (row as { transaction_id?: unknown }).transaction_id !== hidden);
            }
            return rowBuilder(rows);
          },
          insert: (payload: Record<string, unknown>) => {
            inserts.push(payload);
            const missingColumn = options.metadataColumnMissing === true && 'metadata' in payload;
            const error = missingColumn
              ? {
                  code: 'PGRST204',
                  message:
                    "Could not find the 'metadata' column of 'universal_royalty_ledger' in the schema cache",
                }
              : insertError;
            // A committed insert lands in the table — the fake mirrors that
            // (FULL payload, so deterministic-id reads see the same row the
            // balance math does). A failed insert writes nothing, matching
            // Postgres.
            if (!error) {
              // The ledger's UNIQUE(transaction_id) — the constraint the
              // deterministic reconciliation ids converge on. A duplicate
              // commits nothing, exactly like Postgres.
              const transactionId = (payload as { transaction_id?: unknown }).transaction_id;
              const duplicate =
                typeof transactionId === 'string' &&
                ledgerRows().some((row) => (row as { transaction_id?: unknown }).transaction_id === transactionId);
              if (duplicate) {
                return Promise.resolve({
                  error: {
                    code: '23505',
                    message: 'duplicate key value violates unique constraint on transaction_id',
                  },
                });
              }
              (options.ledgerData as unknown[]).push({ ...payload });
            }
            return Promise.resolve({ error: error ?? null });
          },
        };
      }
      if (table === 'escrow_withdrawal_intents') {
        // Chain shapes: the balance helper's two-eq select, the
        // reconciliation surfaces' one-eq selects (awaited directly or
        // after .limit), and the guard-first update chains.
        return {
          select: (columns: string) => ({
            eq: (c1: string, v1: unknown) => {
              const firstPass = intents.filter((i) => i[c1 as keyof FakeIntentRow] === v1);
              // The balance helper's two-eq shape maps its rows down to the
              // amount_units column it selected; the one-eq surfaces read
              // whole rows.
              if (columns === 'amount_units') {
                return {
                  eq: (_c2: string, v2: unknown) =>
                    Promise.resolve({
                      data: firstPass
                        .filter((i) => i.status === v2)
                        .map((i) => ({ amount_units: i.amount_units })),
                      error: null,
                    }),
                };
              }
              return rowBuilder(firstPass);
            },
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: (_c1: string, v1: unknown) => ({
              eq: (_c2: string, v2: unknown) => ({
                select: () => {
                  const row = intents.find((i) => i.id === v1 && i.status === v2);
                  if (row) Object.assign(row, payload);
                  return Promise.resolve({ data: row ? [{ id: row.id }] : [], error: null });
                },
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn !== 'reserve_escrow_withdrawal') throw new Error(`unexpected rpc ${fn}`);
      const holderId = String(args.p_rights_holder_id);
      const amount = BigInt(String(args.p_amount_units));
      const available = baseNow().availableUnits - pendingUnitsFor(holderId);
      if (amount > available) {
        return Promise.resolve({
          data: { reserved: false, available_units: available.toString() },
          error: null,
        });
      }
      intents.push({
        id: String(args.p_intent_id),
        rights_holder_id: holderId,
        amount_units: amount.toString(),
        status: 'pending',
        plaid_transfer_id: null,
        settled_at: null,
        released_at: null,
        created_at: new Date().toISOString(),
      });
      return Promise.resolve({
        data: { reserved: true, available_units: available.toString() },
        error: null,
      });
    },
  };

  return {
    db: db as never,
    inserts,
    intents,
    /** Simulate reconciliation: the stuck hold is released by hand. */
    forceRelease: (id: string) => {
      const row = intents.find((i) => i.id === id);
      if (row) {
        row.status = 'released';
        row.released_at = new Date().toISOString();
      }
    },
    /** Simulate reconciliation: the ledger row was restored, the hold settles. */
    forceSettle: (id: string, plaidTransferId: string | null = null) => {
      const row = intents.find((i) => i.id === id);
      if (row) {
        row.status = 'settled';
        row.plaid_transfer_id = plaidTransferId;
        row.settled_at = new Date().toISOString();
      }
    },
    setInsertError: (err: { code?: string; message: string } | null) => {
      insertError = err;
    },
  };
}

export type FakeEscrowDb = ReturnType<typeof fakeEscrowDb>;
