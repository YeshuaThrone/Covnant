/**
 * PATCH v2.6.4 display adapter — the founder's COVENANT TAX CONTROL BOARD
 * & COMPLIANCE ENGINE patch lands here as a presentation layer over the
 * tax stack of record. This module is an ADAPTER, not an engine:
 *
 *  - ZERO tax logic lives here. Withholding rates, form classification,
 *    and lock reasons come from CovnantTaxEngineSDK (the engine of record)
 *    through the src/lib/tax/withholding.ts selectors — nothing is
 *    re-computed, no rate is ever duplicated.
 *  - All money math runs on BigInt minor units (fixed-point.ts law); the
 *    only formatting edge is the shared formatCentsBigint.
 *  - The patch's vocabularies map onto canon at this boundary (C3/C4);
 *    the stored/CSV vocabulary stays canonical.
 *  - No class named CovenantTaxEngine may exist anywhere (C6 — the name is
 *    taken by the vendored, unmodifiable engine in
 *    src/engine/covenant-master-sdk.ts), so this integration is a module
 *    of pure functions.
 *
 * Pure functions only — no store, no clock, no I/O. The UI layer renders
 * these records; label wording (the "Released" voice for a cleared escrow
 * status, fees-incl-dust column labels) is applied at the section layer by
 * the follow-up UI task, never here.
 */

import { formatCentsBigint } from '@/lib/money/format';

import { rateToPlain } from './exportCsv';
import type { TaxLockState, TaxTinStatus } from './CovnantTaxComplianceSDK';
import type { TaxPayeeRowView, TaxTransactionRowView } from './withholding';

/**
 * C3 — TIN vocabulary map at the adapter boundary. The patch speaks
 * VALID / MISSING; the canon of record (TaxTinStatus, the payee profiles,
 * the CSV header) speaks VERIFIED / UNSUBMITTED. The map accepts either
 * vocabulary's token — the selectors' tinStatus field is typed string —
 * emits the canon union, and fails closed to UNSUBMITTED for anything
 * unrecognized (the payeeProfiles.ts law). Canon tokens pass through
 * untouched, so feeding it a selector view is an identity.
 */
export function tinStatusOf(status: string): TaxTinStatus {
  if (status === 'VALID') return 'VERIFIED'; // patch vocab → canon
  if (status === 'MISSING') return 'UNSUBMITTED'; // patch vocab → canon
  if (
    status === 'VERIFIED' ||
    status === 'PENDING' ||
    status === 'INVALID' ||
    status === 'UNSUBMITTED'
  ) {
    return status; // canon of record passes through
  }
  return 'UNSUBMITTED'; // fail-closed default for an unknown payee token
}

/**
 * C4 — the patch flattens escrow state + reason into one field; canon keeps
 * TaxLockState + lockReason as the state of record. This derived display
 * field carries the lockReason of record for a held payout — BOTH engine
 * lock reasons survive verbatim (the patch's own union would have dropped
 * UNVERIFIED_FOREIGN_PAYEE_MANDATORY_30_PERCENT_LOCK) — and the bare
 * 'CLEARED' token when clean. Data token, not label copy: rendering a
 * cleared payout as "Released" is a UI-label decision made later.
 */
export function escrowStatusOf(lockState: TaxLockState, lockReason: string | null): string {
  return lockState === 'HELD_IN_TAX_ESCROW' ? (lockReason ?? 'HELD_IN_TAX_ESCROW') : 'CLEARED';
}

/**
 * The patch's display tag over the forms of record. The corporate exemption
 * suppresses the 1099 forms (patch rule); otherwise the first form of
 * record rides the row, tagged "(PENDING)" while the payee's TIN
 * verification is pending. The forms of record themselves stay untouched on
 * the view — this is a display tag only.
 */
export function formTagOf(view: Pick<TaxPayeeRowView, 'forms' | 'tinStatus'>): string {
  if (view.forms.includes('EXEMPT_CORPORATE')) return 'EXEMPT_CORPORATE';
  const first = view.forms[0];
  if (first === undefined) {
    // Unreachable from the register (every resolved payout carries a form);
    // the vendored engine's no-form token keeps the impossible case honest.
    return 'NONE';
  }
  return tinStatusOf(view.tinStatus) === 'PENDING' ? `${first} (PENDING)` : first;
}

/** The patch's honest fallback for an absent identity tag. */
const NOT_ON_FILE = 'Not on file';

/** USD dollars of record → integer cents (the selectors' own fold pattern). */
function usdToCents(amount: number): bigint {
  return BigInt(Math.round(amount * 100));
}

/** The patch's display record for one withholding-register row (C3/C4/C5 applied). */
export interface FormattedWithholdingRow {
  payeeId: string;
  payeeName: string;
  uctId: string | null;
  /** Identity tags of record, or 'Not on file' when absent. */
  isni: string;
  ipi: string;
  jurisdiction: string | null;
  /** Canon TIN status of record — the boundary map normalized it (C3). */
  tinStatus: TaxTinStatus;
  /** The patch's display tag: EXEMPT_CORPORATE suppression + (PENDING) tag. */
  formTag: string;
  txns: number;
  /** Ledger-layer period figures, rendered from the single ledger fold. */
  grossPaid: string;
  withheld: string;
  net: string;
  /**
   * Lifetime cleared gross — the running YTD fold, a DIFFERENT source than
   * period grossPaid. Never copied from it (C5): the engine's form
   * thresholds consume the running YTD, not the period sum.
   */
  ytdGross: string;
  /** Combined effective rate as a 2-decimal percent (the CSV canon voice). */
  effectiveRate: string;
  /** Derived escrow status of record (C4) — data token, not label copy. */
  taxEscrowStatus: string;
}

/** Map one selector row onto the patch's display record. */
export function formatWithholdingRow(view: TaxPayeeRowView): FormattedWithholdingRow {
  return {
    payeeId: view.payeeId,
    payeeName: view.payeeName,
    uctId: view.uctId,
    isni: view.isni ?? NOT_ON_FILE,
    ipi: view.ipi ?? NOT_ON_FILE,
    jurisdiction: view.jurisdiction,
    tinStatus: tinStatusOf(view.tinStatus),
    formTag: formTagOf(view),
    txns: view.transactionCount,
    grossPaid: formatCentsBigint(view.grossMinor),
    withheld: formatCentsBigint(view.withheldMinor),
    net: formatCentsBigint(view.netMinor),
    ytdGross: formatCentsBigint(usdToCents(view.ytdClearedGrossUsd)),
    effectiveRate: rateToPlain(view.effectiveRate),
    taxEscrowStatus: escrowStatusOf(view.lockState, view.lockReason),
  };
}

/**
 * C2 — the unswept corner-dust remainder: recorded dust minus the dust the
 * engine swept into the stored fee. The sweep identity of record
 * (reconciliation.ts:106-115) stores ONE fee that already contains every
 * collected dust cent (finalFee = fee + dust), so the remainder is 0n today
 * and the summary's dust display reads as zero because nothing was left
 * unswept — a derived figure, never the banned display literal. If the
 * engine ever stores base fee and dust separately, this same expression
 * renders the real unswept remainder.
 */
export function cornerDustRemainder(
  dustCollectedMinor: bigint,
  dustSweptIntoFeesMinor: bigint,
): bigint {
  return dustCollectedMinor - dustSweptIntoFeesMinor;
}

/** The patch's cleared period summary — display strings over exact bigint folds. */
export interface FormattedPeriodSummary {
  txnsCount: number;
  gross: string;
  feeInclDust: string;
  withholding: string;
  netPayout: string;
  displayCornerDust: string;
}

/**
 * The patch's ClearinghouseSummaryEngine.reconcilePeriodSummary, as a pure
 * fold over the transaction register's rows. adjustedFee IS the stored
 * feeMinor — the dust is already inside it (C7; no synthetic baseFeeCents
 * exists anywhere). netPayout is the exact bigint identity
 * gross − adjustedFee − withheld (the identity reconcileRow audits), derived
 * rather than copied from the rows' stored nets.
 */
export function reconcilePeriodSummary(
  rows: readonly TaxTransactionRowView[],
): FormattedPeriodSummary {
  const gross = rows.reduce((sum, row) => sum + row.grossMinor, 0n);
  const adjustedFee = rows.reduce((sum, row) => sum + row.feeMinor, 0n);
  const withheld = rows.reduce((sum, row) => sum + row.withheldMinor, 0n);
  const dustCollected = rows.reduce((sum, row) => sum + row.dustMinor, 0n);
  // The sweep identity: every recorded dust cent lives inside the stored fee.
  const dustSweptIntoFees = dustCollected;
  return {
    txnsCount: rows.length,
    gross: formatCentsBigint(gross),
    feeInclDust: formatCentsBigint(adjustedFee),
    withholding: formatCentsBigint(withheld),
    netPayout: formatCentsBigint(gross - adjustedFee - withheld),
    displayCornerDust: formatCentsBigint(cornerDustRemainder(dustCollected, dustSweptIntoFees)),
  };
}
