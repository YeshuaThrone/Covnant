// Test-only seeding helpers over the canonical async InMemoryStore
// (src/lib/server/inMemoryStore.ts, PR #49). These build record fixtures from
// the foundation's record shapes and persist them through the store's own
// methods — they are not a Store implementation. The store allocates ids for
// inserts (ledger transactions, BaaS transfers, GL rows), so tests capture the
// returned records rather than assuming fixed ids.
import type { BaasTransferRecord, LedgerTransactionRecord } from "@/lib/don/types";
import type {
  CatalogDisputeRecord,
  PayoutHoldRecord,
  RecoupmentAdvanceRecord,
  SovereignVaultRecord,
  VaultDisputeRecord,
} from "@/modules/don/records";
import type { InMemoryStore } from "@/lib/server/inMemoryStore";

const FIXED_TS = "2026-09-10T00:00:00.000Z";

export async function seedVault(
  store: InMemoryStore,
  payeeId: string,
  available_balance: number,
  pending_balance: number,
  reserve_balance: number,
  payeeName = `Payee ${payeeId}`,
): Promise<SovereignVaultRecord> {
  const vault: SovereignVaultRecord = {
    payee_id: payeeId,
    payee_name: payeeName,
    available_balance,
    pending_balance,
    reserve_balance,
    updated_at: FIXED_TS,
  };
  await store.upsertVault(vault);
  return vault;
}

export async function seedVaultDispute(
  store: InMemoryStore,
  payeeId: string,
  locked: 0 | 1,
): Promise<VaultDisputeRecord> {
  const dispute: VaultDisputeRecord = {
    payee_id: payeeId,
    locked,
    line_item_id: null,
    frozen_from_available: 0,
    frozen_from_pending: 0,
    updated_at: FIXED_TS,
  };
  await store.upsertVaultDispute(dispute);
  return dispute;
}

export async function seedCatalogDispute(
  store: InMemoryStore,
  workId: string,
  locked: 0 | 1,
): Promise<CatalogDisputeRecord> {
  const dispute: CatalogDisputeRecord = {
    work_id: workId,
    locked,
    updated_at: FIXED_TS,
  };
  await store.upsertCatalogDispute(dispute);
  return dispute;
}

export async function seedLedgerTransaction(
  store: InMemoryStore,
  overrides: Partial<Omit<LedgerTransactionRecord, "id">> = {},
): Promise<LedgerTransactionRecord> {
  return store.insertLedgerTransaction({
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
    created_at: FIXED_TS,
    settled_at: null,
    kind: "payout",
    ...overrides,
  });
}

export async function seedBaasTransfer(
  store: InMemoryStore,
  payeeId: string,
  overrides: Partial<Omit<BaasTransferRecord, "id">> = {},
): Promise<BaasTransferRecord> {
  const payeeName = (await store.getVault(payeeId))?.payee_name ?? `Payee ${payeeId}`;
  return store.insertBaasTransfer({
    provider: "column",
    rail: "ach",
    payee_id: payeeId,
    payee_name: payeeName,
    amount_cents: 1000,
    currency: "USD",
    status: "submitted",
    ledger_transaction_id: null,
    created_at: FIXED_TS,
    estimated_settlement: null,
    ...overrides,
  });
}

export async function seedPayoutHold(
  store: InMemoryStore,
  transferId: string,
  payeeId: string,
  amount_cents: number,
  status: PayoutHoldRecord["status"] = "in_flight",
): Promise<PayoutHoldRecord> {
  const hold: PayoutHoldRecord = {
    transfer_id: transferId,
    payee_id: payeeId,
    amount_cents,
    status,
    created_at: FIXED_TS,
  };
  await store.insertPayoutHold(hold);
  return hold;
}

export async function seedRecoupmentAdvance(
  store: InMemoryStore,
  creatorId: string,
  recoupment_target_cents: number,
  recoupment_current_cents = 0,
  recoupment_bps = 10_000,
): Promise<RecoupmentAdvanceRecord> {
  const advance: RecoupmentAdvanceRecord = {
    creator_id: creatorId,
    creator_name: `Creator ${creatorId}`,
    recoupment_target_cents,
    recoupment_current_cents,
    recoupment_bps,
    updated_at: FIXED_TS,
  };
  await store.upsertRecoupmentAdvance(advance);
  return advance;
}
