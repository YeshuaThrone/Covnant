import {
  BACKUP_WITHHOLDING_BPS,
  BPS_DENOMINATOR,
  FORM_1099_THRESHOLD_CENTS,
} from "@/modules/don/constants";

export type TinStatus = {
  tin_verified: boolean;
  w9_on_file: boolean;
};

export type WithholdingComputation = {
  gross_cents: number;
  withheld_cents: number;
  net_cents: number;
  backup_withholding_applied: boolean;
  ytd_gross_cents: number;
  ytd_withheld_cents: number;
  requires_1099: boolean;
  crossed_1099_threshold: boolean;
};

export function isTinVerified(status: TinStatus): boolean {
  return status.tin_verified && status.w9_on_file;
}

export function backupWithholdingCents(grossCents: number): number {
  return Math.floor((grossCents * BACKUP_WITHHOLDING_BPS) / BPS_DENOMINATOR);
}

export function computeWithholding(
  grossCents: number,
  priorYtdGrossCents: number,
  priorYtdWithheldCents: number,
  status: TinStatus,
): WithholdingComputation {
  const verified = isTinVerified(status);
  const withheldCents = verified ? 0 : backupWithholdingCents(grossCents);
  const ytdGross = priorYtdGrossCents + grossCents;
  const ytdWithheld = priorYtdWithheldCents + withheldCents;
  const wasUnderThreshold = priorYtdGrossCents < FORM_1099_THRESHOLD_CENTS;
  return {
    gross_cents: grossCents,
    withheld_cents: withheldCents,
    net_cents: grossCents - withheldCents,
    backup_withholding_applied: withheldCents > 0,
    ytd_gross_cents: ytdGross,
    ytd_withheld_cents: ytdWithheld,
    requires_1099: ytdGross >= FORM_1099_THRESHOLD_CENTS,
    crossed_1099_threshold:
      wasUnderThreshold && ytdGross >= FORM_1099_THRESHOLD_CENTS,
  };
}
