import {
  BPS_DENOMINATOR,
  COMPANY_VARIANCE_PAYEE_ID,
} from "@/modules/don/constants";
import { allocateCovenantPayouts } from "./splits";
import { CovenantFXSettlementNode } from "./fx";
import type { UniversalWorkManifest } from "./types";
import type { MatchingResult } from "./universal-blackbox-sweeper";

/** Standard 10% admin fee in basis points. Taken off the top to platform. */
export const DEFAULT_ADMIN_FEE_BPS = 1_000;

export type LedgerPayoutEntry = {
  entryId: string;
  workId: string;
  partyId: string;
  partyName: string;
  grossAmountCents: number;
  adminFeeDeductionCents: number;
  netPayoutAmountCents: number;
  currency: string;
  payoutAccount: string;
  timestamp: string;
};

export type SplitLedgerOk = {
  ok: true;
  entries: LedgerPayoutEntry[];
  convertedGrossCents: number;
  adminFeeCents: number;
  companyDustCents: number;
  variancePayeeId: typeof COMPANY_VARIANCE_PAYEE_ID;
};

export type SplitLedgerErr = {
  ok: false;
  code: "unsupported_currency" | "invalid_amount" | "splits_do_not_balance";
  message: string;
};

export type SplitLedgerResult = SplitLedgerOk | SplitLedgerErr;

/**
 * FX → admin skim → Don Engine dust allocation.
 * Does not use floating-point remainder-to-last-party.
 */
export class CovenantSplitLedgerNode {
  private readonly fxNode: CovenantFXSettlementNode;
  private readonly clock: () => Date;

  constructor(options: { fxNode?: CovenantFXSettlementNode; clock?: () => Date } = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.fxNode = options.fxNode ?? new CovenantFXSettlementNode(this.clock);
  }

  public calculatePayoutLedger(
    work: UniversalWorkManifest,
    match: MatchingResult,
    adminFeeBps: number = DEFAULT_ADMIN_FEE_BPS,
    targetPayoutCurrency = "USD",
  ): SplitLedgerResult {
    if (
      !Number.isSafeInteger(adminFeeBps) ||
      adminFeeBps < 0 ||
      adminFeeBps >= BPS_DENOMINATOR
    ) {
      return {
        ok: false,
        code: "invalid_amount",
        message: "adminFeeBps must be an integer in [0, 10000).",
      };
    }
    const fx = this.fxNode.convertToTargetCurrency(
      match.recoveredAmountCents,
      match.currency,
      targetPayoutCurrency,
    );
    if (!fx.ok) {
      return fx;
    }
    const convertedGrossCents = fx.convertedAmountCents;
    const adminFeeCents = Math.floor(
      (convertedGrossCents * adminFeeBps) / BPS_DENOMINATOR,
    );
    const distributableCents = convertedGrossCents - adminFeeCents;
    if (distributableCents < 1) {
      return {
        ok: true,
        entries: [],
        convertedGrossCents,
        adminFeeCents,
        companyDustCents: 0,
        variancePayeeId: COMPANY_VARIANCE_PAYEE_ID,
      };
    }
    const allocated = allocateCovenantPayouts(distributableCents, work.splits);
    if (!allocated.ok) {
      return allocated;
    }
    const timestamp = this.clock().toISOString();
    const entries: LedgerPayoutEntry[] = allocated.lines.map((line) => {
      const partyGrossCents = Math.floor(
        (convertedGrossCents * line.shareBps) / BPS_DENOMINATOR,
      );
      const partyAdminCents = Math.floor(
        (partyGrossCents * adminFeeBps) / BPS_DENOMINATOR,
      );
      return {
        entryId: `LDG_${match.recordId}_${line.partyId}`,
        workId: work.workId,
        partyId: line.partyId,
        partyName: line.name,
        grossAmountCents: partyGrossCents,
        adminFeeDeductionCents: partyAdminCents,
        netPayoutAmountCents: line.payoutAmountCents,
        currency: targetPayoutCurrency,
        payoutAccount:
          work.splits.find((party) => party.partyId === line.partyId)
            ?.payoutWalletOrBank ?? "",
        timestamp,
      };
    });
    return {
      ok: true,
      entries,
      convertedGrossCents,
      adminFeeCents,
      companyDustCents: allocated.companyDustCents,
      variancePayeeId: COMPANY_VARIANCE_PAYEE_ID,
    };
  }
}
