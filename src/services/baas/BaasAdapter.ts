import type { Store } from "@/lib/server/store";
import type { BaasProvider, SettlementRail } from "@/lib/don/types";
import type {
  AchTransferRequest,
  AdapterDeps,
  BaasAdapter,
  BaasTransferResult,
} from "./types";
import { liveFailure, processSandboxRail } from "./sandboxRail";

export abstract class BaseBaasAdapter implements BaasAdapter {
  abstract readonly provider: BaasProvider;
  readonly mode: "sandbox" | "live";
  protected readonly store: Store;
  private readonly processRail: NonNullable<AdapterDeps["processRail"]>;

  constructor(deps: AdapterDeps) {
    this.store = deps.store;
    this.mode = deps.mode;
    this.processRail = deps.processRail ?? processSandboxRail;
  }

  createAchTransfer(request: AchTransferRequest): Promise<BaasTransferResult> {
    return this.dispatch("ach", request);
  }

  createRtpPayment(request: AchTransferRequest): Promise<BaasTransferResult> {
    return this.dispatch("rtp", request);
  }

  private async dispatch(
    rail: SettlementRail,
    request: AchTransferRequest,
  ): Promise<BaasTransferResult> {
    if (this.mode === "live") {
      return liveFailure(this.provider);
    }
    return this.processRail(this.store, {
      ...request,
      provider: this.provider,
      rail,
    });
  }
}
