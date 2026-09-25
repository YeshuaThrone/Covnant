export const FX_MICROS = 1_000_000;

/** Sandbox USD micros per 1 unit of source currency. Not a live FX feed. */
export const EXCHANGE_RATES_TO_USD_MICROS: Record<string, number> = {
  USD: 1_000_000,
  EUR: 1_085_000,
  GBP: 1_272_000,
  JPY: 6_700,
  CAD: 735_000,
  AUD: 655_000,
};

export type FxConvertOk = {
  ok: true;
  convertedAmountCents: number;
  fxRateMicros: number;
  sourceCurrency: string;
  targetCurrency: string;
  settlementTimestamp: string;
};

export type FxConvertErr = {
  ok: false;
  code: "unsupported_currency" | "invalid_amount";
  message: string;
};

export type FxConvertResult = FxConvertOk | FxConvertErr;

export class CovenantFXSettlementNode {
  constructor(private readonly clock: () => Date = () => new Date()) {}

  public convertToTargetCurrency(
    amountCents: number,
    sourceCurrency: string,
    targetCurrency = "USD",
  ): FxConvertResult {
    if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
      return {
        ok: false,
        code: "invalid_amount",
        message: "amountCents must be a whole number of at least 0.",
      };
    }
    const source = sourceCurrency.toUpperCase();
    const target = targetCurrency.toUpperCase();
    const srcRate = EXCHANGE_RATES_TO_USD_MICROS[source];
    const tgtRate = EXCHANGE_RATES_TO_USD_MICROS[target];
    if (srcRate === undefined || tgtRate === undefined) {
      return {
        ok: false,
        code: "unsupported_currency",
        message: `Unsupported sandbox FX pair ${source}->${target}.`,
      };
    }
    const convertedAmountCents = Math.floor(
      (amountCents * srcRate) / tgtRate,
    );
    return {
      ok: true,
      convertedAmountCents,
      fxRateMicros: Math.floor((srcRate * FX_MICROS) / tgtRate),
      sourceCurrency: source,
      targetCurrency: target,
      settlementTimestamp: this.clock().toISOString(),
    };
  }
}
