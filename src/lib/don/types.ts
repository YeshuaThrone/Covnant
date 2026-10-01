export const PLAID_PRODUCTS = ["auth", "identity"] as const;
export type PlaidProduct = (typeof PLAID_PRODUCTS)[number];

export const KYC_STATUSES = ["pending", "verified", "failed"] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const PLAID_KYC_ACTIONS = ["create_link_token", "verify_identity"] as const;
export type PlaidKycAction = (typeof PLAID_KYC_ACTIONS)[number];

export type KycAddress = {
  street: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
};

export type KycIdentityPayload = {
  legal_name: string;
  date_of_birth: string;
  email: string;
  phone: string | null;
  ssn_last_4: string | null;
  address: KycAddress | null;
};

export type CreateLinkTokenInput = {
  action: "create_link_token";
  creator_id: string;
  products: PlaidProduct[];
};

export type VerifyIdentityInput = {
  action: "verify_identity";
  creator_id: string;
  public_token: string | null;
  link_token: string | null;
  identity: KycIdentityPayload;
};

export type PlaidKycInput = CreateLinkTokenInput | VerifyIdentityInput;

export type PlaidLinkTokenRecord = {
  id: string;
  creator_id: string;
  link_token: string;
  public_token: string;
  access_token: string;
  expiration: string;
  products: string;
  created_at: string;
};

export type KycVerificationRecord = {
  id: string;
  creator_id: string;
  plaid_link_token: string | null;
  plaid_public_token: string | null;
  status: KycStatus;
  identity_json: string;
  failure_reason: string | null;
  created_at: string;
  verified_at: string | null;
};

export const PAYEE_ROLES = [
  "creator",
  "label",
  "publisher",
  "producer",
  "other",
] as const;
export type PayeeRole = (typeof PAYEE_ROLES)[number];

export const SETTLEMENT_RAILS = ["ach", "rtp"] as const;
export type SettlementRail = (typeof SETTLEMENT_RAILS)[number];

export const LEDGER_STATUSES = [
  "pending_settlement",
  "submitted",
  "settled",
  "failed",
  // Unclaimed royalty holding (PR 7): recon-identified unallocated funds sit
  // in holding until identity AND splits are fully verified. A held row's
  // kind is 'unclaimed_holding'; release settles it through the normal
  // clearance-gated settlement path (status → 'settled' + release journal).
  "unclaimed_holding",
  // Film waterfall escrow (PR 9): a film distributor's receipt locks in
  // escrow until the statement line items are cross-referenced against the
  // signed deal memo and CAMA agreement; the verified release settles the
  // row (status → 'settled') and routes the money into the waterfall.
  "escrow_waterfall_pending",
  // Gaming cashout pending (PR 13): funds entering from a game platform's
  // payout program hold until Astra cross-references the platform payout
  // batch against verified studio contracts and store statements AND the
  // batch's fiat settlement has completed. A locked row's kind is
  // 'virtual_currency_cashout_pending'; the verified release settles it
  // through the normal clearance-gated settlement path (status → 'settled'
  // + release journal).
  "virtual_currency_cashout_pending",
  // Esports prize pool pending (PR 14): a tournament organizer's prize-pool
  // remittance locked into the batch's waterfall escrow until the verified
  // release runs the sequential recoupment waterfall (status → 'settled').
  "esports_prize_pool_pending",
] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export const LEDGER_KINDS = [
  "royalty",
  "payout",
  "payout_failed_reversal",
  // Banking-rails funding (PR 4): verified Stripe webhook receipts post the
  // money-IN leg. Never written by charge creation — only the signed
  // payment_intent.succeeded webhook posts it.
  "funding_received",
  // Unclaimed royalty holding (PR 7): a recon-sourced credit parked in
  // holding. Kind marks WHAT the row is for its whole life (status carries
  // the state machine), the same division 'payout_failed_reversal' uses.
  "unclaimed_holding",
  // Film waterfall escrow (PR 9): a film distributor's receipt locked in
  // escrow for the waterfall. Kind marks WHAT the row is for its whole life
  // (a released receipt stays kind 'escrow_waterfall_pending' with status
  // 'settled'), the same division PR 7 uses.
  "escrow_waterfall_pending",
  // Gaming cashout pending (PR 13): a game platform's fiat payout batch
  // locked until the cross-reference (studio contracts + store statements)
  // and the batch's fiat settlement verify. Kind marks WHAT the row is for
  // its whole life (a released receipt stays kind
  // 'virtual_currency_cashout_pending' with status 'settled'), the same
  // division PR 7 and PR 9 use.
  "virtual_currency_cashout_pending",
  // Esports prize pool pending (PR 14): a tournament's prize-pool receipt,
  // locked per batch until the verified waterfall release. Kind marks WHAT
  // the row is for its whole life (a released receipt stays kind
  // 'esports_prize_pool_pending' with status 'settled'), the same division
  // PR 7, PR 9, and PR 13 use.
  "esports_prize_pool_pending",
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const BAAS_PROVIDERS = ["column", "unit", "lithic"] as const;
export type BaasProvider = (typeof BAAS_PROVIDERS)[number];

export type SplitPartyInput = {
  payee_id: string;
  payee_name: string;
  role: PayeeRole;
  share_bps: number;
};

export type RoyaltyLineItemInput = {
  work_id: string;
  work_title: string;
  amount_cents: number;
  splits: SplitPartyInput[];
};

export type SplitCalculateInput = {
  source: string;
  period: string | null;
  currency: string;
  settle: boolean;
  rail: SettlementRail;
  line_items: RoyaltyLineItemInput[];
  /**
   * Optional saga replay key (audit H3): a retried calculate presenting a key
   * that already produced a split run is refused with 409 instead of
   * double-running the multi-write saga. Absent = unkeyed (null).
   */
  idempotency_key?: string | null;
};

export type AllocatedSplit = SplitPartyInput & { amount_cents: number };

export type AllocatedLineItem = {
  work_id: string;
  work_title: string;
  amount_cents: number;
  splits: AllocatedSplit[];
  company_dust_cents: number;
};

export type SplitRunRecord = {
  id: string;
  source: string;
  period: string | null;
  currency: string;
  gross_cents: number;
  line_item_count: number;
  variance_account_cents: number;
  created_at: string;
  status: "posted" | "reversed";
  /**
   * The saga idempotency key (migration 0009) — unique when present. The
   * split_runs insert is the split-calculation saga's first write, so this
   * key is the replay lock: a retried calculate with a used key is rejected
   * before any line item, ledger row, or vault credit exists. Null for
   * unkeyed runs (today's semantics).
   */
  idempotency_key: string | null;
};

export type RoyaltyLineItemRecord = {
  id: string;
  split_run_id: string;
  work_id: string;
  work_title: string;
  amount_cents: number;
  splits_json: string;
  created_at: string;
};

export type LedgerTransactionRecord = {
  id: string;
  split_run_id: string;
  line_item_id: string;
  payee_id: string;
  payee_name: string;
  role: PayeeRole;
  share_bps: number;
  amount_cents: number;
  currency: string;
  status: LedgerStatus;
  rail: SettlementRail | null;
  baas_provider: BaasProvider | null;
  baas_transfer_id: string | null;
  created_at: string;
  settled_at: string | null;
  kind: LedgerKind;
};

export type BaasTransferRecord = {
  id: string;
  provider: BaasProvider;
  rail: SettlementRail;
  payee_id: string;
  payee_name: string;
  amount_cents: number;
  currency: string;
  status: "submitted" | "settled" | "failed" | "returned";
  ledger_transaction_id: string | null;
  created_at: string;
  estimated_settlement: string | null;
};
