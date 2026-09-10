import type { Store } from "@/lib/server/store";
import type { SettlementRail } from "@/lib/don/types";
import { ColumnAdapter } from "./ColumnAdapter";
import { UnitAdapter } from "./UnitAdapter";
import type { BaasAdapter, BaasTransferResult } from "./types";

export { ColumnAdapter } from "./ColumnAdapter";
export { UnitAdapter } from "./UnitAdapter";
export { processSandboxRail, isBaasLiveConfigured } from "./sandboxRail";
export type {
  AchTransferRequest,
  AdapterDeps,
  BaasAdapter,
  BaasTransferFailure,
  BaasTransferResult,
  BaasTransferSuccess,
  RtpPaymentRequest,
} from "./types";

export function readBaasMode(): "sandbox" | "live" {
  return process.env.BAAS_MODE === "live" ? "live" : "sandbox";
}

export function readBaasProvider(): "column" | "unit" {
  return process.env.BAAS_PROVIDER === "unit" ? "unit" : "column";
}

let adapterOverride: BaasAdapter | null = null;

export function getBaasAdapter(store: Store): BaasAdapter {
  if (adapterOverride !== null) {
    return adapterOverride;
  }
  const deps = { store, mode: readBaasMode() };
  return readBaasProvider() === "unit"
    ? new UnitAdapter(deps)
    : new ColumnAdapter(deps);
}

export function setBaasAdapter(adapter: BaasAdapter | null): void {
  adapterOverride = adapter;
}

export async function settleLedgerThroughBaas(
  store: Store,
  adapter: BaasAdapter,
  ledgerId: string,
  rail: SettlementRail,
): Promise<BaasTransferResult> {
  const row = store.getLedgerTransaction(ledgerId);
  if (row === undefined) {
    return {
      ok: false,
      status: 404,
      code: "ledger_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  const request = {
    payee_id: row.payee_id,
    payee_name: row.payee_name,
    amount_cents: row.amount_cents,
    currency: row.currency,
    ledger_transaction_id: row.id,
  };
  const result =
    rail === "rtp"
      ? await adapter.createRtpPayment(request)
      : await adapter.createAchTransfer(request);
  if (!result.ok) {
    store.updateLedgerSettlement(row.id, {
      status: "failed",
      rail,
      baas_provider: adapter.provider,
      baas_transfer_id: null,
      settled_at: null,
    });
    return result;
  }
  const settled = result.transfer.status === "settled";
  store.updateLedgerSettlement(row.id, {
    status: settled ? "settled" : "submitted",
    rail,
    baas_provider: adapter.provider,
    baas_transfer_id: result.transfer.id,
    settled_at: settled ? result.transfer.created_at : null,
  });
  return result;
}
