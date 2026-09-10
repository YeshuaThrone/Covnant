/**
 * Pure validators for Don Engine wire payloads — Plaid KYC and UDR split
 * calculate. Accept `unknown` at the HTTP boundary and return either a
 * normalized typed value or `{code, message}` for the `{error, code}`
 * envelope. Lives next to the civic/artist validators but keeps its own
 * error-code union so ATXLive show payloads stay untouched.
 */

import {
  BAAS_WEBHOOK_EVENTS,
  DEFAULT_RECOUPMENT_BPS,
  DSP_WEBHOOK_EVENTS,
  type BaasWebhookEvent,
  type DspWebhookEvent,
} from "@/modules/don/constants";
import {
  BAAS_PROVIDERS,
  PAYEE_ROLES,
  PLAID_KYC_ACTIONS,
  PLAID_PRODUCTS,
  SETTLEMENT_RAILS,
  type BaasProvider,
  type CreateLinkTokenInput,
  type KycAddress,
  type KycIdentityPayload,
  type PayeeRole,
  type PlaidKycInput,
  type PlaidProduct,
  type RoyaltyLineItemInput,
  type SettlementRail,
  type SplitCalculateInput,
  type SplitPartyInput,
  type VerifyIdentityInput,
} from "./types";
import { BPS_DENOMINATOR, percentToBps, sumBps } from "./splitEngine";

export type DonValidationErrorCode =
  | "malformed_body"
  | "invalid_action"
  | "missing_creator_id"
  | "invalid_products"
  | "invalid_identity"
  | "invalid_date_of_birth"
  | "underage"
  | "invalid_email"
  | "invalid_phone"
  | "invalid_ssn_last_4"
  | "invalid_address"
  | "missing_source"
  | "invalid_currency"
  | "invalid_rail"
  | "invalid_line_items"
  | "invalid_amount"
  | "invalid_split_party"
  | "invalid_share"
  | "splits_do_not_balance"
  | "invalid_provider"
  | "invalid_payee"
  | "missing_ledger_transaction_id"
  | "missing_public_token"
  | "invalid_tax_year"
  | "missing_payee_id"
  | "invalid_vault_action"
  | "invalid_webhook_event"
  | "missing_transfer_id"
  | "invalid_recoupment"
  | "invalid_locked"
  | "missing_dispute_target"
  | "missing_split_run_id";

export type DonValidationSuccess<T> = { ok: true; value: T };
export type DonValidationFailure = {
  ok: false;
  code: DonValidationErrorCode;
  message: string;
};
export type DonValidationResult<T> =
  | DonValidationSuccess<T>
  | DonValidationFailure;

const ERROR_MESSAGES: Record<DonValidationErrorCode, string> = {
  malformed_body: "Request body must be a JSON object.",
  invalid_action:
    "action must be 'create_link_token' or 'verify_identity'.",
  missing_creator_id: "creator_id is required.",
  invalid_products: "products must be a non-empty list of 'auth' and/or 'identity'.",
  invalid_identity: "identity.legal_name is required.",
  invalid_date_of_birth: "identity.date_of_birth must be YYYY-MM-DD.",
  underage: "identity.date_of_birth must be 18 years or older.",
  invalid_email: "identity.email must be a valid email address.",
  invalid_phone: "identity.phone must be E.164 (e.g. +15125551234).",
  invalid_ssn_last_4: "identity.ssn_last_4 must be exactly 4 digits.",
  invalid_address:
    "identity.address requires street, city, region, postal_code, and country.",
  missing_source: "source (DSP / catalog) is required.",
  invalid_currency: "currency must be a 3-letter ISO code.",
  invalid_rail: "rail must be 'ach' or 'rtp'.",
  invalid_line_items: "line_items must be a non-empty array.",
  invalid_amount: "amount_cents must be a whole number of at least 1.",
  invalid_split_party:
    "each split requires payee_id, payee_name, role, and a share.",
  invalid_share: "share_percent (0–100) or share_bps (1–10000) is required.",
  splits_do_not_balance: "Party shares on a line item must sum to 100%.",
  invalid_provider: "provider must be 'column' or 'unit'.",
  invalid_payee: "payee_id and payee_name are required.",
  missing_ledger_transaction_id: "ledger_transaction_id must be a string when provided.",
  missing_public_token: "public_token is required.",
  invalid_tax_year: "tax_year must be a four-digit year.",
  missing_payee_id: "payee_id is required.",
  invalid_vault_action: "action must be 'release'.",
  invalid_webhook_event:
    "event must be a payout.* BaaS callback or a royalty.* DSP callback.",
  missing_transfer_id: "transfer_id is required.",
  invalid_recoupment: "recoupment_target_cents must be a whole number of at least 1.",
  invalid_locked: "locked must be a boolean.",
  missing_dispute_target: "payee_id or work_id is required.",
  missing_split_run_id: "split_run_id is required.",
};

function fail<T>(code: DonValidationErrorCode): DonValidationResult<T> {
  return { ok: false, code, message: ERROR_MESSAGES[code] };
}

function failMessage<T>(
  code: DonValidationErrorCode,
  message: string,
): DonValidationResult<T> {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const DOB_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CURRENCY_RE = /^[A-Za-z]{3}$/;

export function isAdult(dateOfBirth: string, now: Date = new Date()): boolean {
  const match = DOB_RE.exec(dateOfBirth);
  if (!match) {
    return false;
  }
  const born = new Date(
    `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`,
  );
  if (Number.isNaN(born.getTime())) {
    return false;
  }
  const eighteenth = new Date(born);
  eighteenth.setUTCFullYear(eighteenth.getUTCFullYear() + 18);
  return now.getTime() >= eighteenth.getTime();
}

function parseProducts(value: unknown): PlaidProduct[] | null {
  const raw = value === undefined ? [...PLAID_PRODUCTS] : value;
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const products: PlaidProduct[] = [];
  for (const item of raw) {
    if (item !== "auth" && item !== "identity") {
      return null;
    }
    if (!products.includes(item)) {
      products.push(item);
    }
  }
  return products;
}

function parseAddress(value: unknown): DonValidationResult<KycAddress | null> {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  if (!isRecord(value)) {
    return fail("invalid_address");
  }
  const street = value.street;
  const city = value.city;
  const region = value.region;
  const postalCode = value.postal_code;
  const country = value.country;
  if (
    !isNonEmptyString(street) ||
    !isNonEmptyString(city) ||
    !isNonEmptyString(region) ||
    !isNonEmptyString(postalCode) ||
    !isNonEmptyString(country)
  ) {
    return fail("invalid_address");
  }
  return {
    ok: true,
    value: {
      street: street.trim(),
      city: city.trim(),
      region: region.trim(),
      postal_code: postalCode.trim(),
      country: country.trim().toUpperCase(),
    },
  };
}

export function parseIdentity(
  value: unknown,
  now: Date = new Date(),
): DonValidationResult<KycIdentityPayload> {
  if (!isRecord(value)) {
    return fail("invalid_identity");
  }
  if (!isNonEmptyString(value.legal_name)) {
    return fail("invalid_identity");
  }
  if (typeof value.date_of_birth !== "string" || !DOB_RE.test(value.date_of_birth)) {
    return fail("invalid_date_of_birth");
  }
  const born = new Date(`${value.date_of_birth}T00:00:00.000Z`);
  if (Number.isNaN(born.getTime())) {
    return fail("invalid_date_of_birth");
  }
  if (!isAdult(value.date_of_birth, now)) {
    return fail("underage");
  }
  if (typeof value.email !== "string" || !EMAIL_RE.test(value.email.trim())) {
    return fail("invalid_email");
  }

  let phone: string | null = null;
  if (value.phone !== undefined && value.phone !== null && value.phone !== "") {
    if (typeof value.phone !== "string" || !E164_RE.test(value.phone.trim())) {
      return fail("invalid_phone");
    }
    phone = value.phone.trim();
  }

  let ssnLast4: string | null = null;
  if (
    value.ssn_last_4 !== undefined &&
    value.ssn_last_4 !== null &&
    value.ssn_last_4 !== ""
  ) {
    if (typeof value.ssn_last_4 !== "string" || !/^\d{4}$/.test(value.ssn_last_4)) {
      return fail("invalid_ssn_last_4");
    }
    ssnLast4 = value.ssn_last_4;
  }

  const address = parseAddress(value.address);
  if (!address.ok) {
    return address;
  }

  return {
    ok: true,
    value: {
      legal_name: value.legal_name.trim(),
      date_of_birth: value.date_of_birth,
      email: value.email.trim().toLowerCase(),
      phone,
      ssn_last_4: ssnLast4,
      address: address.value,
    },
  };
}

export function validatePlaidKycPayload(
  input: unknown,
  now: Date = new Date(),
): DonValidationResult<PlaidKycInput> {
  if (!isRecord(input)) {
    return fail("malformed_body");
  }
  const action = input.action;
  if (
    typeof action !== "string" ||
    !(PLAID_KYC_ACTIONS as readonly string[]).includes(action)
  ) {
    return fail("invalid_action");
  }
  if (!isNonEmptyString(input.creator_id)) {
    return fail("missing_creator_id");
  }
  const creatorId = input.creator_id.trim();

  if (action === "create_link_token") {
    const products = parseProducts(input.products);
    if (products === null) {
      return fail("invalid_products");
    }
    const value: CreateLinkTokenInput = {
      action,
      creator_id: creatorId,
      products,
    };
    return { ok: true, value };
  }

  const identity = parseIdentity(input.identity, now);
  if (!identity.ok) {
    return identity;
  }
  const publicToken =
    isNonEmptyString(input.public_token) ? input.public_token.trim() : null;
  const linkToken =
    isNonEmptyString(input.link_token) ? input.link_token.trim() : null;
  const value: VerifyIdentityInput = {
    action: "verify_identity",
    creator_id: creatorId,
    public_token: publicToken,
    link_token: linkToken,
    identity: identity.value,
  };
  return { ok: true, value };
}

function parseShare(raw: Record<string, unknown>): DonValidationResult<number> {
  if (raw.share_bps !== undefined && raw.share_bps !== null) {
    if (!isSafeInteger(raw.share_bps) || raw.share_bps < 1 || raw.share_bps > BPS_DENOMINATOR) {
      return fail("invalid_share");
    }
    return { ok: true, value: raw.share_bps };
  }
  if (raw.share_percent !== undefined && raw.share_percent !== null) {
    if (
      typeof raw.share_percent !== "number" ||
      !Number.isFinite(raw.share_percent) ||
      raw.share_percent <= 0 ||
      raw.share_percent > 100
    ) {
      return fail("invalid_share");
    }
    const bps = percentToBps(raw.share_percent);
    if (bps < 1 || bps > BPS_DENOMINATOR) {
      return fail("invalid_share");
    }
    return { ok: true, value: bps };
  }
  return fail("invalid_share");
}

function parseSplitParty(raw: unknown): DonValidationResult<SplitPartyInput> {
  if (!isRecord(raw)) {
    return fail("invalid_split_party");
  }
  if (!isNonEmptyString(raw.payee_id) || !isNonEmptyString(raw.payee_name)) {
    return fail("invalid_split_party");
  }
  if (
    typeof raw.role !== "string" ||
    !(PAYEE_ROLES as readonly string[]).includes(raw.role)
  ) {
    return fail("invalid_split_party");
  }
  const share = parseShare(raw);
  if (!share.ok) {
    return share;
  }
  return {
    ok: true,
    value: {
      payee_id: raw.payee_id.trim(),
      payee_name: raw.payee_name.trim(),
      role: raw.role as PayeeRole,
      share_bps: share.value,
    },
  };
}

function parseLineItem(raw: unknown): DonValidationResult<RoyaltyLineItemInput> {
  if (!isRecord(raw)) {
    return fail("invalid_line_items");
  }
  if (!isNonEmptyString(raw.work_id) || !isNonEmptyString(raw.work_title)) {
    return fail("invalid_line_items");
  }
  if (!isSafeInteger(raw.amount_cents) || raw.amount_cents < 1) {
    return fail("invalid_amount");
  }
  if (!Array.isArray(raw.splits) || raw.splits.length === 0) {
    return fail("invalid_split_party");
  }
  const splits: SplitPartyInput[] = [];
  for (const party of raw.splits) {
    const parsed = parseSplitParty(party);
    if (!parsed.ok) {
      return parsed;
    }
    splits.push(parsed.value);
  }
  if (sumBps(splits) !== BPS_DENOMINATOR) {
    return failMessage(
      "splits_do_not_balance",
      `Party shares must sum to 10000 bps (100%), got ${sumBps(splits)}.`,
    );
  }
  return {
    ok: true,
    value: {
      work_id: raw.work_id.trim(),
      work_title: raw.work_title.trim(),
      amount_cents: raw.amount_cents,
      splits,
    },
  };
}

export function validateSplitCalculatePayload(
  input: unknown,
): DonValidationResult<SplitCalculateInput> {
  if (!isRecord(input)) {
    return fail("malformed_body");
  }
  if (!isNonEmptyString(input.source)) {
    return fail("missing_source");
  }
  const currencyRaw =
    input.currency === undefined || input.currency === null
      ? "USD"
      : input.currency;
  if (typeof currencyRaw !== "string" || !CURRENCY_RE.test(currencyRaw.trim())) {
    return fail("invalid_currency");
  }
  const railRaw = input.rail === undefined || input.rail === null ? "rtp" : input.rail;
  if (
    typeof railRaw !== "string" ||
    !(SETTLEMENT_RAILS as readonly string[]).includes(railRaw)
  ) {
    return fail("invalid_rail");
  }
  if (!Array.isArray(input.line_items) || input.line_items.length === 0) {
    return fail("invalid_line_items");
  }
  const lineItems: RoyaltyLineItemInput[] = [];
  for (const item of input.line_items) {
    const parsed = parseLineItem(item);
    if (!parsed.ok) {
      return parsed;
    }
    lineItems.push(parsed.value);
  }
  const period =
    input.period === undefined || input.period === null || input.period === ""
      ? null
      : isNonEmptyString(input.period)
        ? input.period.trim()
        : null;
  if (input.period !== undefined && input.period !== null && input.period !== "" && period === null) {
    return fail("malformed_body");
  }
  return {
    ok: true,
    value: {
      source: input.source.trim(),
      period,
      currency: currencyRaw.trim().toUpperCase(),
      settle: input.settle === true,
      rail: railRaw as SettlementRail,
      line_items: lineItems,
    },
  };
}

export type BaasPayoutInput = {
  payee_id: string;
  payee_name: string;
  amount_cents: number;
  currency: string;
  ledger_transaction_id: string | null;
  provider: BaasProvider | null;
};

export function validateBaasPayoutPayload(
  input: unknown,
): DonValidationResult<BaasPayoutInput> {
  if (!isRecord(input)) {
    return fail("malformed_body");
  }
  if (!isNonEmptyString(input.payee_id) || !isNonEmptyString(input.payee_name)) {
    return fail("invalid_payee");
  }
  if (!isSafeInteger(input.amount_cents) || input.amount_cents < 1) {
    return fail("invalid_amount");
  }
  const currencyRaw =
    input.currency === undefined || input.currency === null
      ? "USD"
      : input.currency;
  if (typeof currencyRaw !== "string" || !CURRENCY_RE.test(currencyRaw.trim())) {
    return fail("invalid_currency");
  }
  let ledgerTransactionId: string | null = null;
  if (
    input.ledger_transaction_id !== undefined &&
    input.ledger_transaction_id !== null &&
    input.ledger_transaction_id !== ""
  ) {
    if (!isNonEmptyString(input.ledger_transaction_id)) {
      return fail("missing_ledger_transaction_id");
    }
    ledgerTransactionId = input.ledger_transaction_id.trim();
  }
  let provider: BaasProvider | null = null;
  if (input.provider !== undefined && input.provider !== null && input.provider !== "") {
    if (
      typeof input.provider !== "string" ||
      !(BAAS_PROVIDERS as readonly string[]).includes(input.provider)
    ) {
      return fail("invalid_provider");
    }
    provider = input.provider as BaasProvider;
  }
  return {
    ok: true,
    value: {
      payee_id: input.payee_id.trim(),
      payee_name: input.payee_name.trim(),
      amount_cents: input.amount_cents,
      currency: currencyRaw.trim().toUpperCase(),
      ledger_transaction_id: ledgerTransactionId,
      provider,
    },
  };
}

export type WithholdingPayload = {
  creator_id: string;
  gross_cents: number;
  tax_year: number | null;
  tin_verified?: boolean;
  w9_on_file?: boolean;
};

export function validateWithholdingPayload(
  input: unknown,
): DonValidationResult<WithholdingPayload> {
  if (!isRecord(input)) {
    return fail("malformed_body");
  }
  if (!isNonEmptyString(input.creator_id)) {
    return fail("missing_creator_id");
  }
  if (!isSafeInteger(input.gross_cents) || input.gross_cents < 1) {
    return fail("invalid_amount");
  }
  let taxYear: number | null = null;
  if (input.tax_year !== undefined && input.tax_year !== null) {
    if (!isSafeInteger(input.tax_year) || input.tax_year < 2000 || input.tax_year > 2100) {
      return fail("invalid_tax_year");
    }
    taxYear = input.tax_year;
  }
  const value: WithholdingPayload = {
    creator_id: input.creator_id.trim(),
    gross_cents: input.gross_cents,
    tax_year: taxYear,
  };
  if (typeof input.tin_verified === "boolean") {
    value.tin_verified = input.tin_verified;
  }
  if (typeof input.w9_on_file === "boolean") {
    value.w9_on_file = input.w9_on_file;
  }
  return { ok: true, value };
}

export type PlaidExchangePayload = {
  creator_id: string;
  public_token: string;
  processor: BaasProvider | null;
};

export function validatePlaidExchangePayload(
  input: unknown,
): DonValidationResult<PlaidExchangePayload> {
  if (!isRecord(input)) {
    return fail("malformed_body");
  }
  if (!isNonEmptyString(input.creator_id)) {
    return fail("missing_creator_id");
  }
  if (!isNonEmptyString(input.public_token)) {
    return fail("missing_public_token");
  }
  let processor: BaasProvider | null = null;
  if (input.processor !== undefined && input.processor !== null && input.processor !== "") {
    if (
      typeof input.processor !== "string" ||
      !(BAAS_PROVIDERS as readonly string[]).includes(input.processor)
    ) {
      return fail("invalid_provider");
    }
    processor = input.processor as BaasProvider;
  }
  return {
    ok: true,
    value: {
      creator_id: input.creator_id.trim(),
      public_token: input.public_token.trim(),
      processor,
    },
  };
}

export type VaultReleasePayload = {
  action: "release";
  payee_id: string;
  amount_cents: number | undefined;
};

export function validateVaultReleasePayload(
  input: unknown,
): DonValidationResult<VaultReleasePayload> {
  if (!isRecord(input)) {
    return fail("malformed_body");
  }
  if (input.action !== "release") {
    return fail("invalid_vault_action");
  }
  if (!isNonEmptyString(input.payee_id)) {
    return fail("missing_payee_id");
  }
  let amountCents: number | undefined;
  if (input.amount_cents !== undefined && input.amount_cents !== null) {
    if (!isSafeInteger(input.amount_cents) || input.amount_cents < 1) {
      return fail("invalid_amount");
    }
    amountCents = input.amount_cents;
  }
  return {
    ok: true,
    value: {
      action: "release",
      payee_id: input.payee_id.trim(),
      amount_cents: amountCents,
    },
  };
}

export type VaultPayoutPayload = {
  payee_id: string;
  amount_cents: number | undefined;
  rail: SettlementRail;
};

export function validateVaultPayoutPayload(
  input: unknown,
): DonValidationResult<VaultPayoutPayload> {
  if (!isRecord(input)) {
    return fail("malformed_body");
  }
  if (!isNonEmptyString(input.payee_id)) {
    return fail("missing_payee_id");
  }
  let amountCents: number | undefined;
  if (input.amount_cents !== undefined && input.amount_cents !== null) {
    if (!isSafeInteger(input.amount_cents) || input.amount_cents < 1) {
      return fail("invalid_amount");
    }
    amountCents = input.amount_cents;
  }
  const railRaw = input.rail === undefined || input.rail === null ? "rtp" : input.rail;
  if (
    typeof railRaw !== "string" ||
    !(SETTLEMENT_RAILS as readonly string[]).includes(railRaw)
  ) {
    return fail("invalid_rail");
  }
  return {
    ok: true,
    value: {
      payee_id: input.payee_id.trim(),
      amount_cents: amountCents,
      rail: railRaw as SettlementRail,
    },
  };
}

export type BaasWebhookPayload = {
  event: BaasWebhookEvent;
  transfer_id: string;
  event_id: string | undefined;
};

export function validateBaasWebhookPayload(
  input: unknown,
): DonValidationResult<BaasWebhookPayload> {
  if (!isRecord(input)) {
    return fail("malformed_body");
  }
  if (
    typeof input.event !== "string" ||
    !(BAAS_WEBHOOK_EVENTS as readonly string[]).includes(input.event)
  ) {
    return fail("invalid_webhook_event");
  }
  if (!isNonEmptyString(input.transfer_id)) {
    return fail("missing_transfer_id");
  }
  let eventId: string | undefined;
  if (input.event_id !== undefined && input.event_id !== null && input.event_id !== "") {
    if (!isNonEmptyString(input.event_id)) {
      return fail("malformed_body");
    }
    eventId = input.event_id.trim();
  }
  return {
    ok: true,
    value: {
      event: input.event as BaasWebhookEvent,
      transfer_id: input.transfer_id.trim(),
      event_id: eventId,
    },
  };
}

export type RecoupmentPayload = {
  creator_id: string;
  creator_name: string;
  recoupment_target_cents: number;
  recoupment_bps: number;
};

export function validateRecoupmentPayload(
  input: unknown,
): DonValidationResult<RecoupmentPayload> {
  if (!isRecord(input)) {
    return fail("malformed_body");
  }
  if (!isNonEmptyString(input.creator_id)) {
    return fail("missing_creator_id");
  }
  if (
    !isSafeInteger(input.recoupment_target_cents) ||
    input.recoupment_target_cents < 1
  ) {
    return fail("invalid_recoupment");
  }
  let bps = DEFAULT_RECOUPMENT_BPS;
  if (input.recoupment_bps !== undefined && input.recoupment_bps !== null) {
    if (
      !isSafeInteger(input.recoupment_bps) ||
      input.recoupment_bps < 1 ||
      input.recoupment_bps > BPS_DENOMINATOR
    ) {
      return fail("invalid_share");
    }
    bps = input.recoupment_bps;
  }
  const name = isNonEmptyString(input.creator_name)
    ? input.creator_name.trim()
    : input.creator_id.trim();
  return {
    ok: true,
    value: {
      creator_id: input.creator_id.trim(),
      creator_name: name,
      recoupment_target_cents: input.recoupment_target_cents,
      recoupment_bps: bps,
    },
  };
}

export type DisputeLockPayload = {
  payee_id: string | undefined;
  work_id: string | undefined;
  locked: boolean;
  line_item_id: string | undefined;
  amount_cents: number | undefined;
};

export function validateDisputeLockPayload(
  input: unknown,
): DonValidationResult<DisputeLockPayload> {
  if (!isRecord(input)) {
    return fail("malformed_body");
  }
  const payeeId = isNonEmptyString(input.payee_id)
    ? input.payee_id.trim()
    : undefined;
  const workId = isNonEmptyString(input.work_id)
    ? input.work_id.trim()
    : undefined;
  if (payeeId === undefined && workId === undefined) {
    return fail("missing_dispute_target");
  }
  if (typeof input.locked !== "boolean") {
    return fail("invalid_locked");
  }
  let lineItemId: string | undefined;
  if (
    input.line_item_id !== undefined &&
    input.line_item_id !== null &&
    input.line_item_id !== ""
  ) {
    if (!isNonEmptyString(input.line_item_id)) {
      return fail("malformed_body");
    }
    lineItemId = input.line_item_id.trim();
  }
  let amountCents: number | undefined;
  if (input.amount_cents !== undefined && input.amount_cents !== null) {
    if (!isSafeInteger(input.amount_cents) || input.amount_cents < 1) {
      return fail("invalid_amount");
    }
    amountCents = input.amount_cents;
  }
  return {
    ok: true,
    value: {
      payee_id: payeeId,
      work_id: workId,
      locked: input.locked,
      line_item_id: lineItemId,
      amount_cents: amountCents,
    },
  };
}

export type DspWebhookPayload = {
  event: DspWebhookEvent;
  event_id: string | undefined;
  source: string;
  period: string | null;
  currency: string;
  rail: SettlementRail;
  split_run_id: string | undefined;
  line_items: RoyaltyLineItemInput[];
};

function parseOptionalEventId(
  value: unknown,
): DonValidationResult<string | undefined> {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: undefined };
  }
  if (!isNonEmptyString(value)) {
    return fail("malformed_body");
  }
  return { ok: true, value: value.trim() };
}

export function validateDspWebhookPayload(
  input: unknown,
): DonValidationResult<DspWebhookPayload> {
  if (!isRecord(input)) {
    return fail("malformed_body");
  }
  if (
    typeof input.event !== "string" ||
    !(DSP_WEBHOOK_EVENTS as readonly string[]).includes(input.event)
  ) {
    return fail("invalid_webhook_event");
  }
  const event = input.event as DspWebhookEvent;
  const eventId = parseOptionalEventId(input.event_id);
  if (!eventId.ok) {
    return eventId;
  }

  if (event === "royalty.reversed") {
    if (!isNonEmptyString(input.split_run_id)) {
      return fail("missing_split_run_id");
    }
    const source = isNonEmptyString(input.source)
      ? input.source.trim()
      : "dsp";
    return {
      ok: true,
      value: {
        event,
        event_id: eventId.value,
        source,
        period: null,
        currency: "USD",
        rail: "rtp",
        split_run_id: input.split_run_id.trim(),
        line_items: [],
      },
    };
  }

  const split = validateSplitCalculatePayload({
    ...input,
    settle: false,
  });
  if (!split.ok) {
    return split;
  }
  return {
    ok: true,
    value: {
      event,
      event_id: eventId.value,
      source: split.value.source,
      period: split.value.period,
      currency: split.value.currency,
      rail: split.value.rail,
      split_run_id: undefined,
      line_items: split.value.line_items,
    },
  };
}

export type SplitReversePayload = {
  split_run_id: string;
};

export function validateSplitReversePayload(
  input: unknown,
): DonValidationResult<SplitReversePayload> {
  if (!isRecord(input)) {
    return fail("malformed_body");
  }
  if (!isNonEmptyString(input.split_run_id)) {
    return fail("missing_split_run_id");
  }
  return {
    ok: true,
    value: { split_run_id: input.split_run_id.trim() },
  };
}

export type UnifiedWebhookPayload =
  | { kind: "baas"; value: BaasWebhookPayload }
  | { kind: "dsp"; value: DspWebhookPayload };

export function validateUnifiedWebhookPayload(
  input: unknown,
): DonValidationResult<UnifiedWebhookPayload> {
  if (!isRecord(input)) {
    return fail("malformed_body");
  }
  if (typeof input.event !== "string") {
    return fail("invalid_webhook_event");
  }
  if ((BAAS_WEBHOOK_EVENTS as readonly string[]).includes(input.event)) {
    const parsed = validateBaasWebhookPayload(input);
    if (!parsed.ok) {
      return parsed;
    }
    return { ok: true, value: { kind: "baas", value: parsed.value } };
  }
  if ((DSP_WEBHOOK_EVENTS as readonly string[]).includes(input.event)) {
    const parsed = validateDspWebhookPayload(input);
    if (!parsed.ok) {
      return parsed;
    }
    return { ok: true, value: { kind: "dsp", value: parsed.value } };
  }
  return fail("invalid_webhook_event");
}