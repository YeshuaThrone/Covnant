import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LITHIC_CARDS_PATH,
  LITHIC_PAYMENTS_PATH,
  createLithicAdapter,
  lithicBaseUrl,
} from "../lithic";
import { STRIPE_PAYMENT_INTENTS_PATH, createStripeAdapter } from "../stripe";
import {
  PLAID_AUTH_GET_PATH,
  PLAID_LINK_TOKEN_CREATE_PATH,
  PLAID_PUBLIC_TOKEN_EXCHANGE_PATH,
  createPlaidAdapter,
} from "../plaid";
import type { BankingTransport } from "../types";

/**
 * Adapter seam tests — prove the EXACT wire shape Stripe, Lithic, and Plaid
 * will receive (method, URL, headers, body) through the injected transport,
 * and the not-configured canon: with credentials absent, every entry point
 * returns the structured 503 envelope and ZERO outbound calls happen.
 */

/** Records every call; replies from a scripted queue. */
function mockTransport(
  responses: { status: number; body: string }[] = [{ status: 200, body: "{}" }],
) {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] =
    [];
  const queue = [...responses];
  const transport: BankingTransport = vi.fn(async (url, init) => {
    calls.push({ url, init });
    return queue.shift() ?? { status: 500, body: "{}" };
  });
  return { transport, calls };
}

const LITHIC_ENV = {
  LITHIC_API_KEY: "sk_sandbox_test_key",
  LITHIC_ENV: "sandbox",
  LITHIC_FINANCIAL_ACCOUNT_TOKEN: "fa_test_1",
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Lithic adapter — not-configured canon", () => {
  it("returns the structured 503 envelope with zero outbound calls when credentials are absent", async () => {
    const { transport, calls } = mockTransport();
    const adapter = createLithicAdapter({ transport });

    const ach = await adapter.dispatchAch({
      destination: "eab_1",
      amountCents: 4242,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });
    const card = await adapter.createVirtualCard({
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    });

    expect(ach.ok).toBe(false);
    expect(card.ok).toBe(false);
    // Both failures share the same structured envelope shape.
    for (const failure of [ach, card]) {
      if (failure.ok) throw new Error("expected failure");
      expect(failure.status).toBe(503);
      expect(failure.code).toBe("lithic_not_configured");
      expect(failure.message).toContain("LITHIC_API_KEY");
    }
    expect(calls).toHaveLength(0);
  });

  it("treats a partial config as not configured", async () => {
    vi.stubEnv("LITHIC_API_KEY", "sk_sandbox_test_key");
    vi.stubEnv("LITHIC_ENV", "sandbox");
    // LITHIC_FINANCIAL_ACCOUNT_TOKEN missing.
    const { transport, calls } = mockTransport();
    const adapter = createLithicAdapter({ transport });

    const result = await adapter.dispatchAch({
      destination: "eab_1",
      amountCents: 1,
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("Lithic adapter — ACH dispatch wire shape", () => {
  it("sends the exact Lithic payments request", async () => {
    for (const [key, value] of Object.entries(LITHIC_ENV)) vi.stubEnv(key, value);
    const { transport, calls } = mockTransport([
      { status: 201, body: JSON.stringify({ token: "pay_1", status: "PENDING" }) },
    ]);
    const adapter = createLithicAdapter({ transport });

    const result = await adapter.dispatchAch({
      destination: "eab_destination_1",
      amountCents: 12345,
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      memo: "Gold Board settlement",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.transferId).toBe("pay_1");
      expect(result.value.status).toBe("PENDING");
    }
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe(`${lithicBaseUrl()}${LITHIC_PAYMENTS_PATH}`);
    expect(call.init.method).toBe("POST");
    // Lithic auth is the RAW api key — no Bearer scheme.
    expect(call.init.headers.Authorization).toBe("sk_sandbox_test_key");
    expect(call.init.headers["Content-Type"]).toBe("application/json");
    expect(call.init.headers["Idempotency-Key"]).toBe(
      "44444444-4444-4444-8444-444444444444",
    );
    const body = JSON.parse(call.init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: "PAYMENT",
      method: "ACH_NEXT_DAY",
      method_attributes: { sec_code: "CCD" },
      financial_account_token: "fa_test_1",
      external_bank_account_token: "eab_destination_1",
      amount: 12345,
      memo: "Gold Board settlement",
    });
  });

  it("targets the production base when LITHIC_ENV=production", async () => {
    vi.stubEnv("LITHIC_API_KEY", "sk_live_key");
    vi.stubEnv("LITHIC_ENV", "production");
    vi.stubEnv("LITHIC_FINANCIAL_ACCOUNT_TOKEN", "fa_live_1");
    const { transport, calls } = mockTransport([
      { status: 201, body: JSON.stringify({ token: "pay_2" }) },
    ]);
    await createLithicAdapter({ transport }).dispatchAch({
      destination: "eab_2",
      amountCents: 500,
      idempotencyKey: "55555555-5555-4555-8555-555555555555",
    });
    expect(calls[0].url).toBe(`https://api.lithic.com${LITHIC_PAYMENTS_PATH}`);
  });

  it("maps a provider rejection to the sanitized 502 envelope without echoing the body", async () => {
    for (const [key, value] of Object.entries(LITHIC_ENV)) vi.stubEnv(key, value);
    const { transport } = mockTransport([
      { status: 400, body: JSON.stringify({ message: "external_bank_account_token: eab_secret_bad" }) },
    ]);
    const result = await createLithicAdapter({ transport }).dispatchAch({
      destination: "eab_bad",
      amountCents: 1,
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.code).toBe("lithic_dispatch_failed");
      // The provider's message may echo sensitive identifiers — only the
      // provider's own `message` field is surfaced, never the raw body.
      expect(result.message).not.toContain("raw body");
    }
  });
});

describe("Lithic adapter — virtual card wire shape", () => {
  it("sends the exact Lithic cards request", async () => {
    for (const [key, value] of Object.entries(LITHIC_ENV)) vi.stubEnv(key, value);
    const { transport, calls } = mockTransport([
      { status: 201, body: JSON.stringify({ token: "card_1", state: "ACTIVE" }) },
    ]);

    const result = await createLithicAdapter({ transport }).createVirtualCard({
      idempotencyKey: "77777777-7777-4777-8777-777777777777",
      memo: "Gold Note Card",
      spendLimitCents: 25000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cardToken).toBe("card_1");
      expect(result.value.state).toBe("ACTIVE");
    }
    const call = calls[0];
    expect(call.url).toBe(`${lithicBaseUrl()}${LITHIC_CARDS_PATH}`);
    expect(call.init.headers.Authorization).toBe("sk_sandbox_test_key");
    expect(call.init.headers["Idempotency-Key"]).toBe(
      "77777777-7777-4777-8777-777777777777",
    );
    const body = JSON.parse(call.init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: "VIRTUAL",
      memo: "Gold Note Card",
      spend_limit: 25000,
      spend_limit_duration: "MONTHLY",
    });
  });
});

describe("Stripe adapter — funding charge seam", () => {
  it("returns the structured 503 envelope with zero outbound calls when the secret key is absent", async () => {
    const { transport, calls } = mockTransport();
    const result = await createStripeAdapter({ transport }).createFundingCharge({
      payeeId: "c1",
      payeeName: "Yeshua Throne",
      amountCents: 10000,
      idempotencyKey: "88888888-8888-4888-8888-888888888888",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.code).toBe("stripe_not_configured");
      expect(result.message).toContain("STRIPE_SECRET_KEY");
    }
    expect(calls).toHaveLength(0);
  });

  it("sends the exact Stripe payment-intents request (form-encoded, Bearer auth, metadata)", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_funding");
    const { transport, calls } = mockTransport([
      {
        status: 200,
        body: JSON.stringify({ id: "pi_1", client_secret: "pi_1_secret", status: "requires_confirmation" }),
      },
    ]);

    const result = await createStripeAdapter({ transport }).createFundingCharge({
      payeeId: "payee_9",
      payeeName: "Nova Sky",
      amountCents: 25000,
      currency: "USD",
      description: "Gold Board funding",
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.paymentIntentId).toBe("pi_1");
      expect(result.value.clientSecret).toBe("pi_1_secret");
      expect(result.value.status).toBe("requires_confirmation");
    }
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe(`https://api.stripe.com${STRIPE_PAYMENT_INTENTS_PATH}`);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers.Authorization).toBe("Bearer sk_test_funding");
    expect(call.init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(call.init.headers["Idempotency-Key"]).toBe(
      "99999999-9999-4999-8999-999999999999",
    );
    // Stripe's wire format is form-encoded, NOT JSON.
    const form = new URLSearchParams(call.init.body);
    expect(form.get("amount")).toBe("25000");
    expect(form.get("currency")).toBe("usd");
    expect(form.get("metadata[payee_id]")).toBe("payee_9");
    expect(form.get("metadata[payee_name]")).toBe("Nova Sky");
    expect(form.get("metadata[origin]")).toBe("covnant_gold_board_funding");
    expect(form.get("description")).toBe("Gold Board funding");
  });

  it("maps a provider rejection to the 502 envelope", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_funding");
    const { transport } = mockTransport([{ status: 402, body: "{}" }]);
    const result = await createStripeAdapter({ transport }).createFundingCharge({
      payeeId: "c1",
      payeeName: "Nova Sky",
      amountCents: 100,
      idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.code).toBe("stripe_funding_failed");
    }
  });
});

describe("Plaid adapter — link token + verification", () => {
  const PLAID_ENV = {
    PLAID_CLIENT_ID: "client_test_1",
    PLAID_SECRET: "secret_test_1",
    PLAID_ENV: "sandbox",
  };

  it("returns the structured 503 envelope with zero outbound calls when credentials are absent", async () => {
    const { transport, calls } = mockTransport();
    const adapter = createPlaidAdapter({ transport });
    const link = await adapter.createLinkToken({ userId: "payee_1", userName: "Nova Sky" });
    const verify = await adapter.getBankAccountVerification({ publicToken: "pt_1" });
    expect(link.ok).toBe(false);
    expect(verify.ok).toBe(false);
    for (const failure of [link, verify]) {
      if (failure.ok) throw new Error("expected failure");
      expect(failure.status).toBe(503);
      expect(failure.code).toBe("plaid_not_configured");
    }
    expect(calls).toHaveLength(0);
  });

  it("fails closed for an unrecognized PLAID_ENV even with client_id and secret", async () => {
    vi.stubEnv("PLAID_CLIENT_ID", "client_test_1");
    vi.stubEnv("PLAID_SECRET", "secret_test_1");
    vi.stubEnv("PLAID_ENV", "development");
    const { transport, calls } = mockTransport();
    const result = await createPlaidAdapter({ transport }).createLinkToken({
      userId: "payee_1",
      userName: "Nova Sky",
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("sends the exact link/token/create request", async () => {
    for (const [key, value] of Object.entries(PLAID_ENV)) vi.stubEnv(key, value);
    const { transport, calls } = mockTransport([
      {
        status: 200,
        body: JSON.stringify({ link_token: "link-sandbox-1", expiration: "2026-10-01T00:00:00Z", request_id: "req_1" }),
      },
    ]);

    const result = await createPlaidAdapter({ transport }).createLinkToken({
      userId: "payee_7",
      userName: "Nova Sky",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.linkToken).toBe("link-sandbox-1");
      expect(result.value.expiration).toBe("2026-10-01T00:00:00Z");
      expect(result.value.requestId).toBe("req_1");
    }
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe(`https://sandbox.plaid.com${PLAID_LINK_TOKEN_CREATE_PATH}`);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(call.init.body) as Record<string, unknown>;
    // Plaid's primary auth pattern: client_id + secret in the JSON body.
    expect(body).toMatchObject({
      client_id: "client_test_1",
      secret: "secret_test_1",
      client_name: "Covnant",
      user: { client_user_id: "payee_7" },
      products: ["auth"],
      country_codes: ["US"],
      language: "en",
    });
  });

  it("exchanges the public token then reads auth/get, mapping only account metadata", async () => {
    for (const [key, value] of Object.entries(PLAID_ENV)) vi.stubEnv(key, value);
    const { transport, calls } = mockTransport([
      { status: 200, body: JSON.stringify({ access_token: "access-sandbox-1" }) },
      {
        status: 200,
        body: JSON.stringify({
          accounts: [
            {
              account_id: "acc_1",
              name: "Plaid Checking",
              official_name: "Gold Checking",
              verification_status: "automatically_verified",
              mask: "0000",
              // Full account numbers ride under numbers[] in the real
              // response — they must never surface in the mapped result.
              numbers: { ach: [{ account: "111222333", routing: "000000000" }] },
            },
          ],
          numbers: { ach: [{ account: "111222333", routing: "000000000" }] },
        }),
      },
    ]);

    const result = await createPlaidAdapter({ transport }).getBankAccountVerification({
      publicToken: "public-sandbox-1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.accounts).toHaveLength(1);
      const account = result.value.accounts[0];
      expect(account).toEqual({
        accountId: "acc_1",
        name: "Plaid Checking",
        officialName: "Gold Checking",
        verificationStatus: "automatically_verified",
        mask: "0000",
      });
      // Last-4 mask only — the full account number appears NOWHERE.
      expect(JSON.stringify(result.value)).not.toContain("111222333");
      expect(JSON.stringify(result.value)).not.toContain("access-sandbox-1");
    }
    expect(calls).toHaveLength(2);
    const exchange = calls[0];
    expect(exchange.url).toBe(`https://sandbox.plaid.com${PLAID_PUBLIC_TOKEN_EXCHANGE_PATH}`);
    expect(JSON.parse(exchange.init.body)).toMatchObject({
      client_id: "client_test_1",
      secret: "secret_test_1",
      public_token: "public-sandbox-1",
    });
    const authGet = calls[1];
    expect(authGet.url).toBe(`https://sandbox.plaid.com${PLAID_AUTH_GET_PATH}`);
    expect(JSON.parse(authGet.init.body)).toMatchObject({
      access_token: "access-sandbox-1",
    });
  });

  it("fails the verification honestly when the exchange step is rejected", async () => {
    for (const [key, value] of Object.entries(PLAID_ENV)) vi.stubEnv(key, value);
    const { transport, calls } = mockTransport([
      { status: 400, body: JSON.stringify({ error_code: "INVALID_PUBLIC_TOKEN" }) },
    ]);
    const result = await createPlaidAdapter({ transport }).getBankAccountVerification({
      publicToken: "public-bad",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.code).toBe("plaid_verification_failed");
    }
    expect(calls).toHaveLength(1);
  });
});
