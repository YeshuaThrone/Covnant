// In-memory Store for engine tests — implements the staging Store interface
// structurally. Seeded through the public maps/arrays; engines see an
// ordinary Store.

import type {
  BaasTransferRecord,
  LedgerTransactionRecord,
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
import {
  type BaasTransferStatus,
  type LedgerSettlementUpdate,
  type LedgerTransactionInsert,
  type PayoutHoldStatus,
  type PayoutReversalInsert,
  type RecoupmentLedgerInsert,
  type Store,
} from "@/modules/don/storeStub";

export class InMemoryStore implements Store {
  readonly vaults = new Map<string, SovereignVaultRecord>();
  readonly vaultDisputes = new Map<string, VaultDisputeRecord>();
  readonly catalogDisputes = new Map<string, CatalogDisputeRecord>();
  readonly ledgerTransactions: LedgerTransactionRecord[] = [];
  readonly baasTransfers = new Map<string, BaasTransferRecord>();
  readonly payoutHolds = new Map<string, PayoutHoldRecord>();
  readonly payoutReversals: PayoutReversalRecord[] = [];
  readonly glJournals: GlJournalRecord[] = [];
  readonly glEntries: GlEntryRecord[] = [];
  readonly recoupmentAdvances = new Map<string, RecoupmentAdvanceRecord>();
  readonly recoupmentLedger: RecoupmentLedgerRecord[] = [];

  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${String(this.seq).padStart(4, "0")}`;
  }

  // ---- test seeding helpers ----

  seedVault(
    payeeId: string,
    available_balance: number,
    pending_balance: number,
    reserve_balance: number,
    payeeName = `Payee ${payeeId}`,
  ): SovereignVaultRecord {
    const vault: SovereignVaultRecord = {
      payee_id: payeeId,
      payee_name: payeeName,
      available_balance,
      pending_balance,
      reserve_balance,
      updated_at: "2026-09-10T00:00:00.000Z",
    };
    this.vaults.set(payeeId, vault);
    return vault;
  }

  seedVaultDispute(payeeId: string, locked: 0 | 1): VaultDisputeRecord {
    const dispute: VaultDisputeRecord = {
      payee_id: payeeId,
      locked,
      line_item_id: null,
      frozen_from_available: 0,
      frozen_from_pending: 0,
      updated_at: "2026-09-10T00:00:00.000Z",
    };
    this.vaultDisputes.set(payeeId, dispute);
    return dispute;
  }

  seedCatalogDispute(workId: string, locked: 0 | 1): CatalogDisputeRecord {
    const dispute: CatalogDisputeRecord = {
      work_id: workId,
      locked,
      updated_at: "2026-09-10T00:00:00.000Z",
    };
    this.catalogDisputes.set(workId, dispute);
    return dispute;
  }

  seedLedgerTransaction(
    overrides: Partial<LedgerTransactionRecord> = {},
  ): LedgerTransactionRecord {
    const record: LedgerTransactionRecord = {
      id: this.nextId("ltx"),
      split_run_id: "",
      line_item_id: "",
      payee_id: "c1",
      payee_name: "Creator One",
      role: "other",
      share_bps: 0,
      amount_cents: 1000,
      currency: "USD",
      status: "submitted",
      rail: "ach",
      baas_provider: "column",
      baas_transfer_id: null,
      created_at: "2026-09-10T00:00:00.000Z",
      settled_at: null,
      kind: "payout",
      ...overrides,
    };
    this.ledgerTransactions.push(record);
    return record;
  }

  seedBaasTransfer(
    transferId: string,
    payeeId: string,
    overrides: Partial<BaasTransferRecord> = {},
  ): BaasTransferRecord {
    const transfer: BaasTransferRecord = {
      id: transferId,
      provider: "column",
      rail: "ach",
      payee_id: payeeId,
      payee_name: this.vaults.get(payeeId)?.payee_name ?? `Payee ${payeeId}`,
      amount_cents: 1000,
      currency: "USD",
      status: "submitted",
      ledger_transaction_id: null,
      created_at: "2026-09-10T00:00:00.000Z",
      estimated_settlement: null,
      ...overrides,
    };
    this.baasTransfers.set(transferId, transfer);
    return transfer;
  }

  seedPayoutHold(
    transferId: string,
    payeeId: string,
    amount_cents: number,
    status: PayoutHoldStatus = "in_flight",
  ): PayoutHoldRecord {
    const hold: PayoutHoldRecord = {
      transfer_id: transferId,
      payee_id: payeeId,
      amount_cents,
      status,
      created_at: "2026-09-10T00:00:00.000Z",
    };
    this.payoutHolds.set(transferId, hold);
    return hold;
  }

  seedRecoupmentAdvance(
    creatorId: string,
    recoupment_target_cents: number,
    recoupment_current_cents = 0,
    recoupment_bps = 10_000,
  ): RecoupmentAdvanceRecord {
    const advance: RecoupmentAdvanceRecord = {
      creator_id: creatorId,
      creator_name: `Creator ${creatorId}`,
      recoupment_target_cents,
      recoupment_current_cents,
      recoupment_bps,
      updated_at: "2026-09-10T00:00:00.000Z",
    };
    this.recoupmentAdvances.set(creatorId, advance);
    return advance;
  }

  // ---- Store implementation (async per the Store PR contract) ----

  async getVault(payeeId: string): Promise<SovereignVaultRecord | undefined> {
    return this.vaults.get(payeeId);
  }

  async upsertVault(vault: SovereignVaultRecord): Promise<SovereignVaultRecord> {
    this.vaults.set(vault.payee_id, vault);
    return vault;
  }

  async sumInFlightPayoutHolds(payeeId: string): Promise<number> {
    let sum = 0;
    for (const hold of this.payoutHolds.values()) {
      if (hold.payee_id === payeeId && hold.status === "in_flight") {
        sum += hold.amount_cents;
      }
    }
    return sum;
  }

  async getVaultDispute(payeeId: string): Promise<VaultDisputeRecord | undefined> {
    return this.vaultDisputes.get(payeeId);
  }

  async getCatalogDispute(workId: string): Promise<CatalogDisputeRecord | undefined> {
    return this.catalogDisputes.get(workId);
  }

  async insertLedgerTransaction(tx: LedgerTransactionInsert): Promise<LedgerTransactionRecord> {
    const record: LedgerTransactionRecord = { ...tx, id: this.nextId("ltx") };
    this.ledgerTransactions.push(record);
    return record;
  }

  async getLedgerTransaction(id: string): Promise<LedgerTransactionRecord | undefined> {
    return this.ledgerTransactions.find((tx) => tx.id === id);
  }

  async updateLedgerSettlement(id: string, update: LedgerSettlementUpdate): Promise<void> {
    const record = await this.getLedgerTransaction(id);
    if (record) {
      Object.assign(record, update);
    }
  }

  async getBaasTransfer(transferId: string): Promise<BaasTransferRecord | undefined> {
    return this.baasTransfers.get(transferId);
  }

  async updateBaasTransferStatus(transferId: string, status: BaasTransferStatus): Promise<void> {
    const transfer = this.baasTransfers.get(transferId);
    if (transfer) {
      transfer.status = status;
    }
  }

  async getPayoutHold(transferId: string): Promise<PayoutHoldRecord | undefined> {
    return this.payoutHolds.get(transferId);
  }

  async updatePayoutHoldStatus(transferId: string, status: PayoutHoldStatus): Promise<void> {
    const hold = this.payoutHolds.get(transferId);
    if (hold) {
      hold.status = status;
    }
  }

  async getPayoutReversalByTransfer(transferId: string): Promise<PayoutReversalRecord | undefined> {
    return this.payoutReversals.find((reversal) => reversal.transfer_id === transferId);
  }

  async insertPayoutReversal(reversal: PayoutReversalInsert): Promise<PayoutReversalRecord> {
    const record: PayoutReversalRecord = { ...reversal, id: this.nextId("rev") };
    this.payoutReversals.push(record);
    return record;
  }

  async getLastGlJournal(): Promise<GlJournalRecord | undefined> {
    if (this.glJournals.length === 0) {
      return undefined;
    }
    return this.glJournals[this.glJournals.length - 1];
  }

  async insertGlJournal(journal: GlJournalRecord, entries: GlEntryRecord[]): Promise<GlJournalRecord> {
    this.glJournals.push(journal);
    this.glEntries.push(...entries);
    return journal;
  }

  async getRecoupmentAdvance(creatorId: string): Promise<RecoupmentAdvanceRecord | undefined> {
    return this.recoupmentAdvances.get(creatorId);
  }

  async upsertRecoupmentAdvance(advance: RecoupmentAdvanceRecord): Promise<RecoupmentAdvanceRecord> {
    this.recoupmentAdvances.set(advance.creator_id, advance);
    return advance;
  }

  async insertRecoupmentLedger(row: RecoupmentLedgerInsert): Promise<RecoupmentLedgerRecord> {
    const record: RecoupmentLedgerRecord = { ...row, id: this.nextId("rcl") };
    this.recoupmentLedger.push(record);
    return record;
  }
}
