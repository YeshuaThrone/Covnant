import type { Store } from "@/lib/server/store";
import type {
  AchTransferRequest,
  BaasTransferSuccess,
  SandboxRailProcessor,
} from "./types";
import type { BaasProvider, SettlementRail } from "@/lib/don/types";

const ACH_SETTLEMENT_DAYS = 3;

export function estimatedAchSettlement(now: Date = new Date()): string {
  const eta = new Date(now);
  eta.setUTCDate(eta.getUTCDate() + ACH_SETTLEMENT_DAYS);
  return eta.toISOString();
}

export function isBaasLiveConfigured(provider: BaasProvider): boolean {
  const key =
    provider === "column"
      ? process.env.COLUMN_API_KEY
      : process.env.UNIT_API_KEY;
  return typeof key === "string" && key.trim() !== "";
}

export function liveFailure(provider: BaasProvider): {
  ok: false;
  status: number;
  code: string;
  message: string;
} {
  if (!isBaasLiveConfigured(provider)) {
    return {
      ok: false,
      status: 503,
      code: "baas_not_configured",
      message: `${provider} live credentials are not configured. Sandbox ACH/RTP remains available.`,
    };
  }
  return {
    ok: false,
    status: 501,
    code: "baas_live_not_implemented",
    message: `${provider} production settlement is not wired yet — use sandbox mode.`,
  };
}

export const processSandboxRail: SandboxRailProcessor = (
  store: Store,
  input: AchTransferRequest & { provider: BaasProvider; rail: SettlementRail },
  now: Date = new Date(),
): BaasTransferSuccess => {
  const createdAt = now.toISOString();
  const instant = input.rail === "rtp";
  const transfer = store.insertBaasTransfer({
    provider: input.provider,
    rail: input.rail,
    payee_id: input.payee_id,
    payee_name: input.payee_name,
    amount_cents: input.amount_cents,
    currency: input.currency,
    status: instant ? "settled" : "submitted",
    ledger_transaction_id: input.ledger_transaction_id,
    created_at: createdAt,
    estimated_settlement: instant ? createdAt : estimatedAchSettlement(now),
  });
  return { ok: true, transfer, mode: "sandbox" };
};
