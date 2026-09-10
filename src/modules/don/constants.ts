export const BPS_DENOMINATOR = 10_000;
export const COMPANY_VARIANCE_PAYEE_ID = "platform";
export const COMPANY_VARIANCE_PAYEE_NAME = "Don Engine Variance";
export const BACKUP_WITHHOLDING_BPS = 2_400;
export const FORM_1099_THRESHOLD_CENTS = 60_000;
export const PLAID_TOKEN_ENC_PREFIX = "enc:v1:";
export const DEFAULT_RECOUPMENT_BPS = 10_000;

export const BAAS_WEBHOOK_EVENTS = [
  "payout.settled",
  "payout.returned",
  "payout.failed",
] as const;
export type BaasWebhookEvent = (typeof BAAS_WEBHOOK_EVENTS)[number];

export const DSP_WEBHOOK_EVENTS = [
  "royalty.report",
  "royalty.adjusted",
  "royalty.reversed",
] as const;
export type DspWebhookEvent = (typeof DSP_WEBHOOK_EVENTS)[number];

export const GL_ACCOUNT_FBO_CASH = "fbo_cash";
export const GL_GENESIS_HASH = "don-engine/gl/genesis";
export const GL_RECOUPMENT_ACCOUNT = "recoupment_ledger";

export const JOURNAL_KINDS = [
  "royalty_ingest",
  "pending_release",
  "payout_hold",
  "payout_settled",
  "payout_failed_reversal",
  "dispute_lock",
  "dispute_unlock",
  "royalty_reversal",
] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export const VAULT_BUCKETS = ["available", "pending", "reserve"] as const;
export type VaultBucket = (typeof VAULT_BUCKETS)[number];

export function vaultGlAccount(payeeId: string, bucket: VaultBucket): string {
  return `vault:${payeeId}:${bucket}`;
}
