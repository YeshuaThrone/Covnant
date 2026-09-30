import { randomUUID } from "node:crypto";
import type { Store } from "@/lib/server/store";
import { estimatedAchSettlement } from "./sandboxRail";
import type {
  AchTransferRequest,
  BaasAdapter,
  BaasTransferResult,
} from "./types";
import {
  createLithicAdapter,
  isLithicConfigured,
  lithicNotConfigured,
  readLithicEnv,
} from "@/services/banking/lithic";
import type { BankingTransport } from "@/services/banking/types";

const LITHIC_RTP_UNSUPPORTED_MESSAGE =
  "The Lithic rail supports ACH (CCD) transfers only; RTP settlement is not wired.";

export type LithicBaasAdapterDeps = {
  store: Store;
  /** Injectable transport for tests — defaults to the global fetch transport. */
  transport?: BankingTransport;
};

/**
 * Lithic BaaS adapter — the compliance-gated payout rail.
 *
 * Unlike the Column/Unit adapters it is NEVER selected by readBaasProvider:
 * the only path to a Lithic dispatch is the operator ACH endpoint, which runs
 * the fail-closed payout compliance gate first and hands this adapter to
 * payoutFromVault as an injected dispatcher. Money movement still posts
 * through the Don ledger contract — never around it.
 */
export class LithicAdapter implements BaasAdapter {
  readonly provider = "lithic" as const;
  readonly mode: "sandbox" | "live";

  private readonly store: Store;
  private readonly rail: ReturnType<typeof createLithicAdapter>;

  constructor(deps: LithicBaasAdapterDeps) {
    this.store = deps.store;
    this.mode = readLithicEnv() === "production" ? "live" : "sandbox";
    this.rail = createLithicAdapter({ transport: deps.transport });
  }

  async createAchTransfer(request: AchTransferRequest): Promise<BaasTransferResult> {
    if (!isLithicConfigured()) {
      return lithicNotConfigured();
    }
    if (!request.destination_bank_token) {
      return {
        ok: false,
        status: 422,
        code: "destination_required",
        message:
          "Lithic ACH dispatch requires the payee's tokenized Lithic external bank account (destination_bank_token).",
      };
    }
    const now = new Date();
    const dispatch = await this.rail.dispatchAch({
      destination: request.destination_bank_token,
      amountCents: request.amount_cents,
      idempotencyKey: request.idempotency_key ?? randomUUID(),
    });
    if (!dispatch.ok) {
      // Same {ok:false,status,code,message} failure shape — pass through.
      return dispatch;
    }
    const transfer = await this.store.insertBaasTransfer({
      provider: "lithic",
      rail: "ach",
      payee_id: request.payee_id,
      payee_name: request.payee_name,
      amount_cents: request.amount_cents,
      currency: request.currency,
      status: "submitted",
      ledger_transaction_id: request.ledger_transaction_id,
      created_at: now.toISOString(),
      estimated_settlement: estimatedAchSettlement(now),
    });
    return { ok: true, transfer, mode: this.mode };
  }

  async createRtpPayment(): Promise<BaasTransferResult> {
    return {
      ok: false,
      status: 501,
      code: "lithic_rtp_unsupported",
      message: LITHIC_RTP_UNSUPPORTED_MESSAGE,
    };
  }
}
