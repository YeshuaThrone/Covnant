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
// store.updateLedgerSettlement.
export type LedgerSettlementUpdate = {
  status: LedgerStatus;
  rail: SettlementRail | null;
  baas_provider: BaasProvider | null;
  baas_transfer_id: string | null;
  settled_at: string | null;
};

export type LedgerTransactionInsert = Omit<LedgerTransactionRecord, "id">;
export type PayoutReversalInsert = Omit<PayoutReversalRecord, "id">;
export type RecoupmentLedgerInsert = Omit<RecoupmentLedgerRecord, "id">;

// The last posted journal carries the chain head (foundation records keep
// sequence / prev_hash / entry_hash on the journal row).
export interface Store {
  // Sovereign vaults
  getVault(payeeId: string): SovereignVaultRecord | undefined;
  upsertVault(vault: SovereignVaultRecord): SovereignVaultRecord;
  sumInFlightPayoutHolds(payeeId: string): number;

  // Disputes — payee-level (vault) and work-level (catalog)
  getVaultDispute(payeeId: string): VaultDisputeRecord | undefined;
  getCatalogDispute(workId: string): CatalogDisputeRecord | undefined;

  // Ledger transactions
  insertLedgerTransaction(tx: LedgerTransactionInsert): LedgerTransactionRecord;
  getLedgerTransaction(id: string): LedgerTransactionRecord | undefined;
  updateLedgerSettlement(id: string, update: LedgerSettlementUpdate): void;

  // BaaS transfers and payout holds
  getBaasTransfer(transferId: string): BaasTransferRecord | undefined;
  updateBaasTransferStatus(transferId: string, status: BaasTransferStatus): void;
  getPayoutHold(transferId: string): PayoutHoldRecord | undefined;
  updatePayoutHoldStatus(transferId: string, status: PayoutHoldStatus): void;

  // Payout reversals
  getPayoutReversalByTransfer(transferId: string): PayoutReversalRecord | undefined;
  insertPayoutReversal(reversal: PayoutReversalInsert): PayoutReversalRecord;

  // GL journals — append-only, hash-chained
  getLastGlJournal(): GlJournalRecord | undefined;
  insertGlJournal(journal: GlJournalRecord, entries: GlEntryRecord[]): GlJournalRecord;

  // Recoupment
  getRecoupmentAdvance(creatorId: string): RecoupmentAdvanceRecord | undefined;
  upsertRecoupmentAdvance(advance: RecoupmentAdvanceRecord): RecoupmentAdvanceRecord;
  insertRecoupmentLedger(row: RecoupmentLedgerInsert): RecoupmentLedgerRecord;
}
