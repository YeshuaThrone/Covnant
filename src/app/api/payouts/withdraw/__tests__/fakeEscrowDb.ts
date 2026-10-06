/**
 * Stateful fake of the escrow-side Supabase client, shared by the withdraw
 * route suites. It models the DB semantics the route now depends on
 * (migration 0058): the reserve RPC and the pending-intent read derive
 * their numbers from the SAME shared state, with the production pure math
 * (escrowBalanceForHolder) as the base pool. Reserves therefore serialize
 * (the second rpc sees the first's pending row and refuses) and a released
 * hold restores the funds — the observable behavior of the per-holder
 * advisory lock, without a database.
 *
 * Lifecycle helpers (forceSettle/forceRelease) model reconciliation by
 * hand; setInsertError lets a test arm the ledger-insert failure that the
 * audit's #5 scenario needs.
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
  seedIntents?: Array<{ id: string; amount_units: string; rights_holder_id?: string }>;
}

export function fakeEscrowDb(options: FakeEscrowDbOptions) {
  const inserts: Record<string, unknown>[] = [];
  const intents: FakeIntentRow[] = (options.seedIntents ?? []).map((seed) => ({
    id: seed.id,
    rights_holder_id: seed.rights_holder_id ?? options.rightsHolderId,
    amount_units: seed.amount_units,
    status: 'pending' as const,
    plaid_transfer_id: null,
    settled_at: null,
    released_at: null,
  }));
  let insertError = options.insertError ?? null;

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
        // fetchEscrowBalance reads this table via select; the payout write
        // lands via insert — the fake serves both, failing the STAMPED
        // attempt only when metadataColumnMissing is set.
        return {
          select: () => Promise.resolve({ data: options.ledgerData ?? [], error: null }),
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
            // so post-payout balance reads (and retries) see the debit. A
            // failed insert writes nothing, matching Postgres.
            if (!error) {
              (options.ledgerData as unknown[]).push({
                disbursements: payload.disbursements,
              });
            }
            return Promise.resolve({ error: error ?? null });
          },
        };
      }
      if (table === 'escrow_withdrawal_intents') {
        // Two chain shapes: the balance helper's
        //   select('amount_units').eq(holder).eq('status','pending')…
        // and the settle/release flips'
        //   update(payload).eq('id', id).eq('status','pending').select('id').
        return {
          select: (columns: string) => ({
            eq: (_c1: string, v1: unknown) => ({
              eq: (_c2: string, v2: unknown) =>
                Promise.resolve({
                  data: intents
                    .filter(
                      (i) =>
                        i.rights_holder_id === v1 && i.status === v2 && columns === 'amount_units',
                    )
                    .map((i) => ({ amount_units: i.amount_units })),
                  error: null,
                }),
            }),
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
