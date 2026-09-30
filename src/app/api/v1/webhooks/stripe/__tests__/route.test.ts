import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";
import { setStore } from "@/lib/server/store";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { GOLD_BOARD_FUNDING_ORIGIN } from "@/modules/banking/validation";

/**
 * POST /api/v1/webhooks/stripe — the funding webhook (money IN to the Gold
 * Board). Covers Stripe's OWN signature scheme (distinct from the Standard
 * Webhooks verifier the DSP webhook uses): unsigned bodies (401), an unset
 * STRIPE_WEBHOOK_SECRET (401 fail-closed), wrong signatures and stale
 * timestamps (403), malformed JSON after a VALID signature (400 — parse
 * happens only after the MAC verifies), non-funding event types and
 * non-Gold-Board origins acknowledged without posting, non-USD refused,
 * and a correctly signed payment_intent.succeeded posting exactly one
 * funding leg whose replay is acknowledged idempotently without
 * re-crediting the vault.
 */

const SECRET = "whsec_test_stripe_gold_board";
const EVENT_ID = "evt_stripe_test_1";

function fundingObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    amount: 25_000,
    currency: "usd",
    metadata: {
      payee_id: "c_1",
      payee_name: "Yeshua Throne",
      origin: GOLD_BOARD_FUNDING_ORIGIN,
    },
    ...overrides,
  };
}

function fundingPayload(object: Record<string, unknown> = fundingObject()): Record<string, unknown> {
  return {
    id: EVENT_ID,
    type: "payment_intent.succeeded",
    data: { object },
  };
}

/** Stripe's scheme: `t=<unix>,v1=<hex hmac of "<t>.<rawBody>">`. */
function stripeSignatureHeader(
  rawBody: string,
  secret: string = SECRET,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const mac = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

function webhookRequest(rawBody: string, headers: Record<string, string>): Request {
  return new Request("http://localhost/api/v1/webhooks/stripe", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

function signedRequest(payload: unknown): Request {
  const rawBody = JSON.stringify(payload);
  return webhookRequest(rawBody, { "stripe-signature": stripeSignatureHeader(rawBody) });
}

beforeEach(() => {
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setStore(null);
});

describe("POST /api/v1/webhooks/stripe — signature gate", () => {
  it("rejects an unsigned body with 401 before any store read", async () => {
    // No store injected: a gate bypass would surface as a 500, not a 401.
    const res = await POST(
      webhookRequest(JSON.stringify(fundingPayload()), {}) as never,
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("signature_missing");
  });

  it("fails closed with 401 when STRIPE_WEBHOOK_SECRET is unset", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const rawBody = JSON.stringify(fundingPayload());
    const res = await POST(
      webhookRequest(rawBody, { "stripe-signature": stripeSignatureHeader(rawBody) }) as never,
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("signature_not_configured");
    expect(body.error).toContain("STRIPE_WEBHOOK_SECRET");
  });

  it("rejects a wrong signature with 403", async () => {
    const rawBody = JSON.stringify(fundingPayload());
    const res = await POST(
      webhookRequest(rawBody, {
        "stripe-signature": stripeSignatureHeader(rawBody, "attacker-secret"),
      }) as never,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("signature_invalid");
  });

  it("rejects a stale timestamp (replay) with 403", async () => {
    const rawBody = JSON.stringify(fundingPayload());
    const stale = Math.floor(Date.now() / 1000) - 1000;
    const res = await POST(
      webhookRequest(rawBody, {
        "stripe-signature": stripeSignatureHeader(rawBody, SECRET, stale),
      }) as never,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("signature_invalid");
  });

  it("accepts a valid fresh signature", async () => {
    // Proben: a validly signed body must get PAST the gate — a funding
    // payload with a foreign origin proves the signed request reached the
    // handler (401/403 would prove the opposite).
    const res = await POST(signedRequest(fundingPayload(fundingObject({
      metadata: { payee_id: "c_1", payee_name: "Yeshua Throne", origin: "other" },
    }))) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handled).toBe(false);
  });
});

describe("POST /api/v1/webhooks/stripe — funding envelope", () => {
  it("rejects malformed JSON with 400 after a valid signature", async () => {
    const rawBody = "not-json";
    const res = await POST(
      webhookRequest(rawBody, { "stripe-signature": stripeSignatureHeader(rawBody) }) as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("malformed_body");
  });

  it("acknowledges a non-payment_intent event without posting", async () => {
    const res = await POST(
      signedRequest({ id: "evt_2", type: "charge.refunded", data: { object: {} } }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, handled: false, reason: "event_type_not_funding" });
  });

  it("acknowledges a funding event whose origin is not the Gold Board", async () => {
    const res = await POST(
      signedRequest(fundingPayload(fundingObject({
        metadata: { payee_id: "c_1", payee_name: "Yeshua Throne", origin: "some_other_product" },
      }))) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, handled: false, reason: "origin_not_gold_board" });
  });

  it("rejects a non-USD funding charge with 422", async () => {
    const res = await POST(
      signedRequest(fundingPayload(fundingObject({ currency: "eur" }))) as never,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("unsupported_currency");
  });

  it("rejects a funding object with missing metadata with 422", async () => {
    const res = await POST(
      signedRequest(fundingPayload({ amount: 25_000, currency: "usd" })) as never,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("invalid_funding_event");
  });
});

describe("POST /api/v1/webhooks/stripe — Gold Board posting", () => {
  it("credits the vault, posts the ledger row and the funding journal once", async () => {
    const store = new InMemoryStore();
    setStore(store);

    const res = await POST(signedRequest(fundingPayload()) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.handled).toBe(true);
    expect(body.funding).toMatchObject({
      payee_id: "c_1",
      amount_cents: 25_000,
    });
    expect(body.funding.vault_available_balance).toBe(25_000);

    // Exactly one journal carries the Stripe event as its ref.
    const journals = await store.listGlJournalsByRef("stripe_event", EVENT_ID);
    expect(journals).toHaveLength(1);
  });

  it("acknowledges a replayed event idempotently without re-crediting", async () => {
    const store = new InMemoryStore();
    setStore(store);

    const first = await POST(signedRequest(fundingPayload()) as never);
    const firstBody = await first.json();
    expect(firstBody.idempotent).toBeUndefined();
    expect(firstBody.funding.vault_available_balance).toBe(25_000);

    const replay = await POST(signedRequest(fundingPayload()) as never);
    const replayBody = await replay.json();
    expect(replayBody).toMatchObject({ ok: true, handled: true, idempotent: true });

    // The vault balance is unchanged and still exactly one journal exists.
    const res = await POST(
      signedRequest(fundingPayload(fundingObject({ amount: 1 }))) as never,
    );
    // A modified amount with the same event id still dedupes on the event id.
    const dedupeBody = await res.json();
    expect(dedupeBody).toMatchObject({ ok: true, handled: true, idempotent: true });
    const journals = await store.listGlJournalsByRef("stripe_event", EVENT_ID);
    expect(journals).toHaveLength(1);
  });
});
