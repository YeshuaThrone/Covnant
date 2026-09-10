// STAGING-ONLY Store type — narrow structural stub, do not extend.
//
// The real Store contract belongs to the migration/SupabaseStore PR, which
// lands `src/lib/server/store.ts` (Cursor's full interface plus the
// SupabaseStore implementation over the 0006 migration). Until that merges,
// the Don engine files typecheck against this stub, which carries exactly the
// methods the dropped engines call — no invented methods, no invented
// signatures. Every method name and parameter shape below is lifted from a
// Cursor call site (vaults/engine.ts, ledger/engine.ts, recoupment/engine.ts,
// the Phase 3/4 engines).
//
// When the Store PR merges: repoint the engine imports at
// "@/lib/server/store", delete this file, and re-align the in-memory test
// store if any signature differs.
//
// ASYNC CONTRACT: the Store PR ruled that every Store method is
// Promise-wrapped (Cursor's sync canonical cannot be implemented over the
// async Supabase client). This stub mirrors that contract — same method
// names and parameter shapes, Promise returns.

import type {
  BaasProvider,
  BaasTransferRecord,
  LedgerStatus,
  LedgerTransactionRecord,
  SettlementRail,
} from "@/lib/don/types";
import type {
  CatalogDisputeRecord,
  GlEntryRecord,
  GlJournalRecord,
  PayoutHoldRecord,
  PayoutReversalRecord,
  RecoupmentAdvanceRecord,
  RecoupmentLedgerRecord,
  SovereignVaultRecord,
  VaultDisputeRecord,
} from "@/modules/don/records";

export type BaasTransferStatus = BaasTransferRecord["status"];
export type PayoutHoldStatus = PayoutHoldRecord["status"];

// The exact settlement-update shape every dropped call site passes to
// store.updateLedgerSettlement (canonical: Pick over the record's settlement
// fields).
export type LedgerSettlementUpdate = Pick<
  LedgerTransactionRecord,
  "status" | "rail" | "baas_provider" | "baas_transfer_id" | "settled_at"
>;

export type LedgerTransactionInsert = Omit<LedgerTransactionRecord, "id">;
export type PayoutReversalInsert = Omit<PayoutReversalRecord, "id">;
export type RecoupmentLedgerInsert = Omit<RecoupmentLedgerRecord, "id">;

// The last posted journal carries the chain head (foundation records keep
// sequence / prev_hash / entry_hash on the journal row).
export interface Store {
  // Sovereign vaults
  getVault(payeeId: string): Promise<SovereignVaultRecord | undefined>;
  upsertVault(vault: SovereignVaultRecord): Promise<SovereignVaultRecord>;
  sumInFlightPayoutHolds(payeeId: string): Promise<number>;

  // Disputes — payee-level (vault) and work-level (catalog)
  getVaultDispute(payeeId: string): Promise<VaultDisputeRecord | undefined>;
  getCatalogDispute(workId: string): Promise<CatalogDisputeRecord | undefined>;

  // Ledger transactions
  insertLedgerTransaction(tx: LedgerTransactionInsert): Promise<LedgerTransactionRecord>;
  getLedgerTransaction(id: string): Promise<LedgerTransactionRecord | undefined>;
  // Canonical return shapes: mutations hand back the updated row (or undefined
  // when the target does not exist) so callers can surface them if needed.
  updateLedgerSettlement(
    id: string,
    update: LedgerSettlementUpdate,
  ): Promise<LedgerTransactionRecord | undefined>;

  // BaaS transfers and payout holds
  getBaasTransfer(transferId: string): Promise<BaasTransferRecord | undefined>;
  updateBaasTransferStatus(
    transferId: string,
    status: BaasTransferStatus,
  ): Promise<BaasTransferRecord | undefined>;
  getPayoutHold(transferId: string): Promise<PayoutHoldRecord | undefined>;
  updatePayoutHoldStatus(
    transferId: string,
    status: PayoutHoldStatus,
  ): Promise<PayoutHoldRecord | undefined>;

  // Payout reversals
  getPayoutReversalByTransfer(transferId: string): Promise<PayoutReversalRecord | undefined>;
  insertPayoutReversal(reversal: PayoutReversalInsert): Promise<PayoutReversalRecord>;

  // GL journals — append-only, hash-chained. The engine (ledger/chain.ts +
  // postJournal) supplies the chain state; omitted chain fields take the
  // canonical defaults (sequence 0, prev/entry hash '', state 'posted') and
  // the store allocates ids.
  getLatestGlJournal(): Promise<GlJournalRecord | undefined>;
  insertGlJournal(
    row: Omit<
      GlJournalRecord,
      "id" | "sequence" | "prev_hash" | "entry_hash" | "state"
    > & {
      sequence?: number;
      prev_hash?: string;
      entry_hash?: string;
      state?: GlJournalRecord["state"];
    },
  ): Promise<GlJournalRecord>;
  insertGlEntry(row: Omit<GlEntryRecord, "id">): Promise<GlEntryRecord>;

  // Recoupment
  getRecoupmentAdvance(creatorId: string): Promise<RecoupmentAdvanceRecord | undefined>;
  upsertRecoupmentAdvance(advance: RecoupmentAdvanceRecord): Promise<RecoupmentAdvanceRecord>;
  insertRecoupmentLedger(row: RecoupmentLedgerInsert): Promise<RecoupmentLedgerRecord>;
}
