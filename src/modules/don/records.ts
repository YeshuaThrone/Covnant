export type CompanyDustRecord = {
  id: string;
  split_run_id: string;
  line_item_id: string;
  amount_cents: number;
  variance_account_id: string;
  created_at: string;
};

export type CreatorTaxProfile = {
  creator_id: string;
  tin_verified: number;
  w9_on_file: number;
  updated_at: string;
};

export type CreatorYtdEarnings = {
  creator_id: string;
  tax_year: number;
  gross_cents: number;
  withheld_cents: number;
  updated_at: string;
};

export type TaxEscrowRecord = {
  id: string;
  creator_id: string;
  tax_year: number;
  gross_cents: number;
  withheld_cents: number;
  net_cents: number;
  tin_verified: number;
  w9_on_file: number;
  requires_1099: number;
  crossed_1099_threshold: number;
  created_at: string;
};

export type SovereignVaultRecord = {
  payee_id: string;
  payee_name: string;
  available_balance: number;
  pending_balance: number;
  reserve_balance: number;
  updated_at: string;
};

export type PlaidProcessorTokenRecord = {
  id: string;
  creator_id: string;
  public_token: string;
  processor: "column" | "unit";
  processor_token: string;
  account_id: string;
  created_at: string;
};

export type RecoupmentAdvanceRecord = {
  creator_id: string;
  creator_name: string;
  recoupment_target_cents: number;
  recoupment_current_cents: number;
  recoupment_bps: number;
  updated_at: string;
};

export type VaultDisputeRecord = {
  payee_id: string;
  locked: number;
  line_item_id: string | null;
  frozen_from_available: number;
  frozen_from_pending: number;
  updated_at: string;
};

export type PayoutHoldRecord = {
  transfer_id: string;
  payee_id: string;
  amount_cents: number;
  status: "in_flight" | "settled" | "reversed";
  created_at: string;
};

export type BaasWebhookEventRecord = {
  id: string;
  event_id: string;
  event: string;
  transfer_id: string;
  payload_json: string;
  reversal_id: string | null;
  created_at: string;
};

export type PayoutReversalRecord = {
  id: string;
  transfer_id: string;
  payee_id: string;
  amount_cents: number;
  reason: "payout.returned" | "payout.failed";
  ledger_transaction_id: string | null;
  journal_id: string;
  created_at: string;
};

export type GlJournalRecord = {
  id: string;
  kind: string;
  ref_type: string;
  ref_id: string;
  created_at: string;
  sequence: number;
  prev_hash: string;
  entry_hash: string;
  state: "posted";
};

export type GlEntryRecord = {
  id: string;
  journal_id: string;
  account: string;
  debit_cents: number;
  credit_cents: number;
  created_at: string;
};

export type RecoupmentLedgerRecord = {
  id: string;
  creator_id: string;
  split_run_id: string;
  incoming_cents: number;
  recouped_cents: number;
  excess_cents: number;
  recoupment_current_cents: number;
  created_at: string;
};

export type CatalogDisputeRecord = {
  work_id: string;
  locked: number;
  updated_at: string;
};

export type DspWebhookEventRecord = {
  id: string;
  event_id: string;
  event: string;
  source: string;
  split_run_id: string | null;
  payload_json: string;
  created_at: string;
};

export type SplitReversalRecord = {
  id: string;
  split_run_id: string;
  journal_id: string;
  created_at: string;
};
