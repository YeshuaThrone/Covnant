import type {
  BaasProvider,
  BaasTransferRecord,
  SettlementRail,
} from "@/lib/don/types";
import type { Store } from "@/lib/server/store";

export type AchTransferRequest = {
  payee_id: string;
  payee_name: string;
  amount_cents: number;
  currency: string;
  ledger_transaction_id: string | null;
};

export type RtpPaymentRequest = AchTransferRequest;

export type BaasTransferSuccess = {
  ok: true;
  transfer: BaasTransferRecord;
  mode: "sandbox";
};

export type BaasTransferFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type BaasTransferResult = BaasTransferSuccess | BaasTransferFailure;

export interface BaasAdapter {
  readonly provider: BaasProvider;
  readonly mode: "sandbox" | "live";
  createAchTransfer(request: AchTransferRequest): Promise<BaasTransferResult>;
  createRtpPayment(request: RtpPaymentRequest): Promise<BaasTransferResult>;
}

export type SandboxRailProcessor = (
  store: Store,
  input: AchTransferRequest & { provider: BaasProvider; rail: SettlementRail },
  now?: Date,
) => Promise<BaasTransferSuccess>;

export type AdapterDeps = {
  store: Store;
  mode: "sandbox" | "live";
  processRail?: SandboxRailProcessor;
};
