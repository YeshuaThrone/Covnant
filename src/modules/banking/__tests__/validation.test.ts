import { describe, expect, it } from "vitest";
import {
  GOLD_BOARD_FUNDING_ORIGIN,
  validateLithicAchDispatchPayload,
  validateLithicCardIssuePayload,
  validatePlaidBankAccountPayload,
  validateStripeEventEnvelope,
  validateStripeFundingObject,
} from "../validation";

/**
 * The banking payload validators — the value-level rules the route tests
 * exercise only through the whole handler. UUID idempotency, the vertical
 * enum, the compliance booleans, and the Stripe funding metadata contract.
 */

const UUID = "0e2d1a86-9c1b-4a7e-b8bd-3f5f7d2f9e01";

function lithicBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payee_id: "c_1",
    vertical: "music",
    operator_settlement_approved: true,
    idempotency_key: UUID,
    amount_cents: 25_000,
    destination: "bank_tok_xyz",
    ...overrides,
  };
}

describe("validateLithicAchDispatchPayload", () => {
  it("accepts a complete dispatch body", () => {
    const parsed = validateLithicAchDispatchPayload(lithicBody());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({
        payee_id: "c_1",
        vertical: "music",
        operator_settlement_approved: true,
        idempotency_key: UUID,
        amount_cents: 25_000,
        destination: "bank_tok_xyz",
        memo: undefined,
      });
    }
  });

  it("trims and defaults cleanly", () => {
    const parsed = validateLithicAchDispatchPayload(
      lithicBody({ payee_id: "  c_1  ", destination: " bank_tok_xyz ", memo: "  hi  " }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.payee_id).toBe("c_1");
      expect(parsed.value.destination).toBe("bank_tok_xyz");
      expect(parsed.value.memo).toBe("hi");
    }
  });

  it("rejects non-objects, missing fields, and bad types", () => {
    expect(validateLithicAchDispatchPayload("nope")).toMatchObject({
      ok: false,
      code: "malformed_body",
    });
    expect(validateLithicAchDispatchPayload(lithicBody({ payee_id: "" }))).toMatchObject({
      ok: false,
      code: "missing_payee_id",
    });
    expect(
      validateLithicAchDispatchPayload(lithicBody({ operator_settlement_approved: "yes" })),
    ).toMatchObject({ ok: false, code: "invalid_operator_settlement_approved" });
    expect(
      validateLithicAchDispatchPayload(lithicBody({ idempotency_key: "not-a-uuid" })),
    ).toMatchObject({ ok: false, code: "invalid_idempotency_key" });
    expect(validateLithicAchDispatchPayload(lithicBody({ amount_cents: 0 }))).toMatchObject({
      ok: false,
      code: "invalid_amount",
    });
    expect(
      validateLithicAchDispatchPayload(lithicBody({ amount_cents: 1.5 })),
    ).toMatchObject({ ok: false, code: "invalid_amount" });
    expect(
      validateLithicAchDispatchPayload(lithicBody({ destination: "" })),
    ).toMatchObject({ ok: false, code: "missing_destination" });
    expect(validateLithicAchDispatchPayload(lithicBody({ memo: null }))).toMatchObject({
      ok: false,
      code: "invalid_memo",
    });
  });

  it("rejects a vertical outside the gate's supported families", () => {
    expect(validateLithicAchDispatchPayload(lithicBody({ vertical: "vaporwave" }))).toMatchObject({
      ok: false,
      code: "invalid_vertical",
    });
    // Every founder-directed vertical validates.
    for (const vertical of [
      "music",
      "film",
      "podcast",
      "gaming",
      "livestream",
      "publishing",
      "merch",
      "ai",
      "art",
      "theater",
      "licensing",
      "nil",
      "spatial",
      "fitness",
      "culinary",
      "services",
      "software",
      "hardware",
      "resource",
    ]) {
      const parsed = validateLithicAchDispatchPayload(lithicBody({ vertical }));
      expect(parsed.ok).toBe(true);
    }
  });
});

describe("validateLithicCardIssuePayload", () => {
  it("accepts a body with an optional positive spend limit", () => {
    const withLimit = validateLithicCardIssuePayload(
      lithicBody({ spend_limit_cents: 100_000 }),
    );
    expect(withLimit.ok).toBe(true);
    if (withLimit.ok) {
      expect(withLimit.value.spend_limit_cents).toBe(100_000);
    }

    const withoutLimit = validateLithicCardIssuePayload(lithicBody());
    expect(withoutLimit.ok).toBe(true);
    if (withoutLimit.ok) {
      expect(withoutLimit.value.spend_limit_cents).toBeUndefined();
    }

    const nullLimit = validateLithicCardIssuePayload(
      lithicBody({ spend_limit_cents: null }),
    );
    expect(nullLimit.ok).toBe(true);
  });

  it("rejects a non-positive or fractional spend limit", () => {
    expect(
      validateLithicCardIssuePayload(lithicBody({ spend_limit_cents: 0 })),
    ).toMatchObject({ ok: false, code: "invalid_amount" });
    expect(
      validateLithicCardIssuePayload(lithicBody({ spend_limit_cents: 10.5 })),
    ).toMatchObject({ ok: false, code: "invalid_amount" });
  });
});

describe("validatePlaidBankAccountPayload", () => {
  it("accepts a public_token and rejects its absence", () => {
    const parsed = validatePlaidBankAccountPayload({ public_token: " tok " });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.public_token).toBe("tok");
    }
    expect(validatePlaidBankAccountPayload({})).toMatchObject({
      ok: false,
      code: "missing_public_token",
    });
    expect(validatePlaidBankAccountPayload("nope")).toMatchObject({
      ok: false,
      code: "malformed_body",
    });
  });
});

describe("validateStripeEventEnvelope + validateStripeFundingObject", () => {
  it("requires the Stripe event envelope shape", () => {
    expect(validateStripeEventEnvelope("nope")).toMatchObject({
      ok: false,
      code: "invalid_event",
    });
    expect(
      validateStripeEventEnvelope({ id: "e", type: "t" }),
    ).toMatchObject({ ok: false, code: "invalid_event" });
    const parsed = validateStripeEventEnvelope({
      id: " evt_1 ",
      type: " payment_intent.succeeded ",
      data: { object: { amount: 1 } },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.id).toBe("evt_1");
      expect(parsed.value.type).toBe("payment_intent.succeeded");
    }
  });

  it("requires the funding metadata contract and normalizes currency", () => {
    const funding = validateStripeFundingObject({
      amount: 25_000,
      currency: " USD ",
      metadata: {
        payee_id: "c_1",
        payee_name: "Yeshua Throne",
        origin: GOLD_BOARD_FUNDING_ORIGIN,
      },
    });
    expect(funding.ok).toBe(true);
    if (funding.ok) {
      expect(funding.value).toEqual({
        payee_id: "c_1",
        payee_name: "Yeshua Throne",
        amount_cents: 25_000,
        currency: "usd",
        origin: GOLD_BOARD_FUNDING_ORIGIN,
      });
    }

    expect(
      validateStripeFundingObject({ amount: 0, currency: "usd", metadata: {} }),
    ).toMatchObject({ ok: false, code: "invalid_funding_event" });
    expect(
      validateStripeFundingObject({ amount: 1, currency: "usd" }),
    ).toMatchObject({ ok: false, code: "invalid_funding_event" });
    expect(
      validateStripeFundingObject({ amount: 1, currency: "usd", metadata: {} }),
    ).toMatchObject({ ok: false, code: "invalid_funding_event" });
    expect(
      validateStripeFundingObject({
        amount: 1,
        currency: "usd",
        metadata: { payee_id: "c_1" },
      }),
    ).toMatchObject({ ok: false, code: "invalid_funding_event" });
  });
});
