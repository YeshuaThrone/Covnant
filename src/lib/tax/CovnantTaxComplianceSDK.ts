/**
 * @covnant/tax-sdk — CovnantTaxComplianceSDK (founder code drop, 2026-09-21).
 *
 * The TAX ENGINE OF RECORD for payout tax resolution: withholding, treaty
 * and statutory rates, state nexus taxes, 1099 classifications, and the
 * cleared / tax-escrow-held lock state of every payout. The /admin Tax tab
 * and its CSV export resolve every payee payout through THIS engine — the
 * Don ledger's own withholding stays the ledger layer of record and is
 * never modified here (two honest layers, shown side by side).
 *
 * Money discipline: every resolution runs in integer cents (the platform's
 * money space), so net = gross − withholding − state tax holds exactly —
 * never a float subtraction. Thresholds compare cumulative cleared gross
 * plus the current payout, so a form triggers on real running totals.
 *
 * KNOWN TYPE BUG FIXED CONSCIOUSLY (founder's original draft carried
 * `payee.formType === 'UNSUBMITTED'` in the foreign branch — a TS2367 dead
 * comparison: 'UNSUBMITTED' is a tinStatus value, never a TaxFormClassification).
 * The founder's intent — route an unverified foreign payee to the mandatory
 * 30 percent lock — is fully covered by the `tinStatus !== 'VERIFIED'`
 * branch below, so the dead clause is dropped and the intent preserved.
 */

/** The payee's tax form classification of record. */
export type TaxFormClassification =
  | '1099_MISC'
  | '1099_NEC'
  | 'W8_BEN'
  | 'W8_BEN_E'
  | 'EXEMPT_CORPORATE';

/** TIN verification state of record for a payee. */
export type TaxTinStatus = 'VERIFIED' | 'PENDING' | 'INVALID' | 'UNSUBMITTED';

/** The payout flow the money rides: royalty flows vs crew or contractor flows. */
export type TaxPayoutType = 'ROYALTY' | 'SERVICE';

/** The payout's release state: clean, or held in the tax escrow pending resolution. */
export type TaxLockState = 'CLEARED' | 'HELD_IN_TAX_ESCROW';

export interface PayeeTaxProfile {
  payeeId: string;
  payeeName: string;
  /** ISO-2 tax residence country of record (the W-8/W-9 compliance layer). */
  countryCode: string;
  /** US state nexus of record, when the payee carries one (e.g. 'TX'). */
  stateJurisdiction?: string;
  tinStatus: TaxTinStatus;
  formType: TaxFormClassification;
  usResident: boolean;
  treatyClaimActive: boolean;
  /** Cleared gross USD year to date BEFORE the payout being resolved. */
  ytdClearedGrossUSD: number;
}

export interface TaxPayoutInput {
  transactionId: string;
  /** The payout's gross in USD — for the tax tab, the ledger's own stored figure. */
  grossAmountUSD: number;
  payee: PayeeTaxProfile;
  payoutType: TaxPayoutType;
  /** The event's US state jurisdiction when the record carries one (state nexus). */
  eventState?: string | null;
}

export interface TaxResolutionResult {
  transactionId: string;
  grossAmountUSD: number;
  payeeId: string;
  withholdingTaxUSD: number;
  stateSalesTaxUSD: number;
  netClearingPayoutUSD: number;
  /** Combined effective rate (withholding plus state tax) over the gross. */
  effectiveWithholdingRate: number;
  formTriggered: TaxFormClassification;
  lockState: TaxLockState;
  lockReason?: string;
}

/** Statutory royalty form threshold — 1099-MISC, USD (2026 canon). */
const MISC_ROYALTY_THRESHOLD = 10.0;
/** Founder-stated 2026 OBBBA service form threshold — 1099-NEC, USD. */
const NEC_SERVICE_THRESHOLD = 2000.0;
/** US backup withholding rate for unverified or invalid TINs. */
const BACKUP_WITHHOLDING_RATE = 0.24;
/** Mandatory withholding for a foreign payee without a verified TIN. */
const FOREIGN_UNVERIFIED_RATE = 0.3;
/** Statutory fallback when no treaty rate covers the residence country. */
const TREATY_FALLBACK_RATE = 0.3;

/** Founder canon: US state tax rates (state nexus on the payout event). */
const STATE_TAX_RATES: Record<string, number> = {
  TX: 0.0625,
  CA: 0.0725,
  NY: 0.04,
};

/**
 * Founder canon: treaty royalty rates by ISO-2 residence. Royalty flows
 * only — a treaty's royalty article does not reach a service payout.
 */
const TREATY_ROYALTY_RATES: Record<string, number> = {
  GB: 0.0,
  DE: 0.0,
  CA: 0.0,
  JP: 0.0,
  FR: 0.0,
  MX: 0.1,
  AU: 0.05,
  IN: 0.15,
};

/** USD cents from a dollars figure (the resolution's integer space). */
function usdCents(amount: number): number {
  return Math.round(amount * 100);
}

export class CovnantTaxEngineSDK {
  /** Founder canon thresholds and rates, exposed for tests and surfaces. */
  static readonly MISC_ROYALTY_THRESHOLD = MISC_ROYALTY_THRESHOLD;
  static readonly NEC_SERVICE_THRESHOLD = NEC_SERVICE_THRESHOLD;
  static readonly BACKUP_WITHHOLDING_RATE = BACKUP_WITHHOLDING_RATE;
  static readonly TREATY_FALLBACK_RATE = TREATY_FALLBACK_RATE;
  static readonly STATE_TAX_RATES = STATE_TAX_RATES;
  static readonly TREATY_ROYALTY_RATES = TREATY_ROYALTY_RATES;

  /** Federal withholding rate for a payout, before state nexus. */
  private static withholdingRateCentsPerDollar(input: TaxPayoutInput): {
    rate: number;
    lockReason: string | null;
  } {
    const { payee, payoutType } = input;
    if (!payee.usResident) {
      // Founder's dead `formType === 'UNSUBMITTED'` clause lived here — the
      // tinStatus branch below carries the full intent (see header note).
      if (payee.tinStatus !== 'VERIFIED') {
        return {
          rate: FOREIGN_UNVERIFIED_RATE,
          lockReason: 'UNVERIFIED_FOREIGN_PAYEE_MANDATORY_30_PERCENT_LOCK',
        };
      }
      const treatyRate =
        payoutType === 'ROYALTY' && payee.treatyClaimActive
          ? TREATY_ROYALTY_RATES[payee.countryCode]
          : undefined;
      if (treatyRate !== undefined) return { rate: treatyRate, lockReason: null };
      return { rate: TREATY_FALLBACK_RATE, lockReason: null };
    }
    if (payee.tinStatus !== 'VERIFIED') {
      return {
        rate: BACKUP_WITHHOLDING_RATE,
        lockReason: 'INVALID_OR_MISSING_TIN_BACKUP_WITHHOLDING',
      };
    }
    return { rate: 0, lockReason: null };
  }

  /** The 1099/W-8 classification this payout triggers. */
  private static formTriggeredFor(input: TaxPayoutInput): TaxFormClassification {
    const { payee, payoutType } = input;
    if (!payee.usResident) return payee.formType;
    if (payee.formType === 'EXEMPT_CORPORATE') return 'EXEMPT_CORPORATE';
    const cumulativeCents = usdCents(payee.ytdClearedGrossUSD) + usdCents(input.grossAmountUSD);
    const thresholdCents =
      payoutType === 'ROYALTY'
        ? usdCents(MISC_ROYALTY_THRESHOLD)
        : usdCents(NEC_SERVICE_THRESHOLD);
    if (cumulativeCents < thresholdCents) return 'EXEMPT_CORPORATE';
    return payoutType === 'ROYALTY' ? '1099_MISC' : '1099_NEC';
  }

  /**
   * Resolve one payout: gross in, tax resolution out. Pure — no store, no
   * clock, no I/O; the caller owns the records and the layering (the Don
   * ledger net is the PRE-TAX distributable; this engine's net is the
   * final clean clearing yield before the 50/35/15 release).
   */
  public processPayout(input: TaxPayoutInput): TaxResolutionResult {
    const grossCents = usdCents(input.grossAmountUSD);
    const { rate, lockReason } = CovnantTaxEngineSDK.withholdingRateCentsPerDollar(input);
    const withholdingCents = Math.round(grossCents * rate);
    const stateRate = input.eventState ? (STATE_TAX_RATES[input.eventState] ?? 0) : 0;
    const stateTaxCents = Math.round(grossCents * stateRate);
    const netCents = grossCents - withholdingCents - stateTaxCents;
    return {
      transactionId: input.transactionId,
      grossAmountUSD: input.grossAmountUSD,
      payeeId: input.payee.payeeId,
      withholdingTaxUSD: withholdingCents / 100,
      stateSalesTaxUSD: stateTaxCents / 100,
      netClearingPayoutUSD: netCents / 100,
      effectiveWithholdingRate: grossCents > 0 ? (withholdingCents + stateTaxCents) / grossCents : 0,
      formTriggered: CovnantTaxEngineSDK.formTriggeredFor(input),
      lockState: lockReason === null ? 'CLEARED' : 'HELD_IN_TAX_ESCROW',
      ...(lockReason === null ? {} : { lockReason }),
    };
  }
}
