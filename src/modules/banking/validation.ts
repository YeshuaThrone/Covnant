import {
  ASSET_VERTICALS,
  type AssetVertical,
} from "@/modules/compliance/payoutGate";
import { LITHIC_IDEMPOTENCY_KEY_REGEX } from "@/services/banking/lithic";

/**
 * Hand-rolled payload validators for the banking-rails routes, following the
 * lib/don/validation.ts house style (isRecord / fail(code), no zod in this
 * layer). Every banking route body passes through one of these before any
 * store read or outbound call.
 */

export type BankingValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

function fail<T>(code: string, message: string): BankingValidationResult<T> {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** Lithic honors UUID idempotency keys (card + financial-account creation today). */
const UUID_REGEX = LITHIC_IDEMPOTENCY_KEY_REGEX;

export const GOLD_BOARD_FUNDING_ORIGIN = "covnant_gold_board_funding";

/** Shared fields every Lithic dispatch/issuance body carries. */
type LithicComplianceFields = {
  payee_id: string;
  vertical: AssetVertical;
  operator_settlement_approved: boolean;
  idempotency_key: string;
  memo: string | undefined;
};

/**
 * The compliance fields are REQUIRED and validated here so the gate below
 * never guesses: operator_settlement_approved must be a real boolean (the
 * gate refuses `false` with the compliance envelope — validation only
 * refuses a non-boolean with 422).
 */
function validateLithicComplianceFields(
  input: Record<string, unknown>,
): BankingValidationResult<
  Omit<LithicComplianceFields, "memo"> & { memo: string | undefined }
> {
  if (!isNonEmptyString(input.payee_id)) {
    return fail("missing_payee_id", "payee_id is required.");
  }
  if (
    typeof input.vertical !== "string" ||
    !(ASSET_VERTICALS as readonly string[]).includes(input.vertical)
  ) {
    return fail(
      "invalid_vertical",
      `vertical must be one of: ${ASSET_VERTICALS.join(", ")}.`,
    );
  }
  if (typeof input.operator_settlement_approved !== "boolean") {
    return fail(
      "invalid_operator_settlement_approved",
      "operator_settlement_approved must be a boolean.",
    );
  }
  if (!isNonEmptyString(input.idempotency_key)) {
    return fail("missing_idempotency_key", "idempotency_key is required (UUID — reuse it to replay the same logical dispatch).");
  }
  if (!UUID_REGEX.test(input.idempotency_key.trim())) {
    return fail("invalid_idempotency_key", "idempotency_key must be a UUID.");
  }
  if (input.memo !== undefined && !isNonEmptyString(input.memo)) {
    return fail("invalid_memo", "memo must be a non-empty string when present.");
  }
  return {
    ok: true,
    value: {
      payee_id: input.payee_id.trim(),
      vertical: input.vertical as AssetVertical,
      operator_settlement_approved: input.operator_settlement_approved,
      idempotency_key: input.idempotency_key.trim(),
      memo: input.memo === undefined ? undefined : input.memo.trim(),
    },
  };
}

export type LithicAchDispatchPayload = LithicComplianceFields & {
  amount_cents: number;
  destination: string;
};

export function validateLithicAchDispatchPayload(
  input: unknown,
): BankingValidationResult<LithicAchDispatchPayload> {
  if (!isRecord(input)) {
    return fail("malformed_body", "Request body must be a JSON object.");
  }
  const base = validateLithicComplianceFields(input);
  if (!base.ok) {
    return base;
  }
  if (!isSafeInteger(input.amount_cents) || input.amount_cents < 1) {
    return fail("invalid_amount", "amount_cents must be a positive integer.");
  }
  if (!isNonEmptyString(input.destination)) {
    return fail(
      "missing_destination",
      "destination is required — the payee's tokenized Lithic external bank account.",
    );
  }
  return {
    ok: true,
    value: {
      ...base.value,
      amount_cents: input.amount_cents,
      destination: input.destination.trim(),
    },
  };
}

export type LithicCardIssuePayload = LithicComplianceFields & {
  spend_limit_cents: number | undefined;
};

export function validateLithicCardIssuePayload(
  input: unknown,
): BankingValidationResult<LithicCardIssuePayload> {
  if (!isRecord(input)) {
    return fail("malformed_body", "Request body must be a JSON object.");
  }
  const base = validateLithicComplianceFields(input);
  if (!base.ok) {
    return base;
  }
  let spendLimitCents: number | undefined;
  if (input.spend_limit_cents !== undefined && input.spend_limit_cents !== null) {
    if (!isSafeInteger(input.spend_limit_cents) || input.spend_limit_cents < 1) {
      return fail("invalid_amount", "spend_limit_cents must be a positive integer.");
    }
    spendLimitCents = input.spend_limit_cents;
  }
  return {
    ok: true,
    value: { ...base.value, spend_limit_cents: spendLimitCents },
  };
}

export type PlaidBankAccountPayload = {
  public_token: string;
};

export function validatePlaidBankAccountPayload(
  input: unknown,
): BankingValidationResult<PlaidBankAccountPayload> {
  if (!isRecord(input)) {
    return fail("malformed_body", "Request body must be a JSON object.");
  }
  if (!isNonEmptyString(input.public_token)) {
    return fail("missing_public_token", "public_token is required.");
  }
  return { ok: true, value: { public_token: input.public_token.trim() } };
}

export type StripeEventEnvelope = {
  id: string;
  type: string;
  object: Record<string, unknown>;
};

export function validateStripeEventEnvelope(
  input: unknown,
): BankingValidationResult<StripeEventEnvelope> {
  if (!isRecord(input)) {
    return fail("invalid_event", "The Stripe event must be a JSON object.");
  }
  if (!isNonEmptyString(input.id)) {
    return fail("invalid_event", "The Stripe event is missing its id.");
  }
  if (!isNonEmptyString(input.type)) {
    return fail("invalid_event", "The Stripe event is missing its type.");
  }
  if (!isRecord(input.data) || !isRecord(input.data.object)) {
    return fail("invalid_event", "The Stripe event is missing data.object.");
  }
  return {
    ok: true,
    value: { id: input.id.trim(), type: input.type.trim(), object: input.data.object },
  };
}

export type StripeFundingObject = {
  payee_id: string;
  payee_name: string;
  amount_cents: number;
  currency: string;
  origin: string;
};

/**
 * The payment_intent payload the Gold Board funding webhook accepts. The
 * `origin` metadata gates WHICH charges post funding: only intents created
 * through the Gold Board funding seam (origin === covnant_gold_board_funding)
 * move money; anything else is acknowledged unhandled.
 */
export function validateStripeFundingObject(
  object: Record<string, unknown>,
): BankingValidationResult<StripeFundingObject> {
  const amount = object.amount;
  if (!isSafeInteger(amount) || amount < 1) {
    return fail("invalid_funding_event", "The payment intent's amount must be a positive integer.");
  }
  if (typeof object.currency !== "string" || object.currency.trim().length === 0) {
    return fail("invalid_funding_event", "The payment intent is missing its currency.");
  }
  if (!isRecord(object.metadata)) {
    return fail("invalid_funding_event", "The payment intent is missing its metadata.");
  }
  const metadata = object.metadata;
  if (!isNonEmptyString(metadata.payee_id)) {
    return fail("invalid_funding_event", "The payment intent metadata is missing payee_id.");
  }
  if (!isNonEmptyString(metadata.payee_name)) {
    return fail("invalid_funding_event", "The payment intent metadata is missing payee_name.");
  }
  if (!isNonEmptyString(metadata.origin)) {
    return fail("invalid_funding_event", "The payment intent metadata is missing origin.");
  }
  return {
    ok: true,
    value: {
      payee_id: metadata.payee_id.trim(),
      payee_name: metadata.payee_name.trim(),
      amount_cents: amount,
      currency: object.currency.trim().toLowerCase(),
      origin: metadata.origin.trim(),
    },
  };
}
