import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";
import { setStore } from "@/lib/server/store";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { ADMIN_COOKIE_NAME, mintAdminSessionToken } from "@/lib/admin/gate";
import { resetRateLimits } from "@/lib/server/rateLimit";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";

/**
 * POST /api/v1/lithic/cards — the Gold Note Card issuing stub (operator-only,
 * compliance-gated). Issuance moves no Gold Board money; the SAME fail-closed
 * payout gate as ACH dispatch runs first. The Lithic adapter factory is
 * mocked (importOriginal keeps the real not-configured posture); zero
 * outbound calls are proven with a fetch spy.
 */

const createVirtualCard = vi.hoisted(() => vi.fn());

vi.mock("@/services/banking/lithic", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/banking/lithic")>();
  return {
    ...actual,
    createLithicAdapter: vi.fn(() => ({ createVirtualCard })),
  };
});

const OPERATOR_PASSWORD = "test-operator-pass";
const UUID = "7f3c2b91-4d6e-4a5f-9a2b-1c8d7e6f5a4b";

const SATISFIED_MUSIC = {
  vertical: "music" as const,
  rights_separation_settled: true,
};

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payee_id: "c_1",
    vertical: "music",
    operator_settlement_approved: true,
    idempotency_key: UUID,
    memo: "Tour advance card",
    spend_limit_cents: 100_000,
    ...overrides,
  };
}

function operatorRequest(body: unknown): Request {
  const token = mintAdminSessionToken(new Date(), process.env);
  return new Request("http://localhost/api/v1/lithic/cards", {
    method: "POST",
    headers: {
      cookie: `${ADMIN_COOKIE_NAME}=${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function seedVerifiedKyc(store: InMemoryStore): Promise<void> {
  const now = new Date().toISOString();
  await store.insertKycVerification({
    creator_id: "c_1",
    plaid_link_token: null,
    plaid_public_token: null,
    status: "verified",
    identity_json: "{}",
    failure_reason: null,
    created_at: now,
    verified_at: now,
  });
}

beforeEach(() => {
  vi.stubEnv("ADMIN_DASHBOARD_PASSWORD", OPERATOR_PASSWORD);
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setStore(null);
  setVerticalComplianceStateSource(null);
  createVirtualCard.mockReset();
});

describe("POST /api/v1/lithic/cards — gate and validation", () => {
  it("rejects a request without the operator cookie with 401", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/lithic/cards", {
        method: "POST",
        body: JSON.stringify(validBody()),
      }) as never,
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("admin_not_authenticated");
  });

  it("fails closed with 503 when the operator secret is unset", async () => {
    vi.stubEnv("ADMIN_DASHBOARD_PASSWORD", "");
    const res = await POST(operatorRequest(validBody()) as never);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("admin_not_configured");
  });

  it("rejects a missing idempotency key with 422", async () => {
    const res = await POST(
      operatorRequest(validBody({ idempotency_key: undefined })) as never,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("missing_idempotency_key");
  });

  it("refuses with kyc_state_unknown before any capability disclosure", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    setStore(new InMemoryStore());
    setVerticalComplianceStateSource(async () => SATISFIED_MUSIC);

    const res = await POST(operatorRequest(validBody()) as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("kyc_state_unknown");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/lithic/cards — capability and success", () => {
  it("answers 503 with zero outbound calls when Lithic is not configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const store = new InMemoryStore();
    setStore(store);
    await seedVerifiedKyc(store);
    setVerticalComplianceStateSource(async () => SATISFIED_MUSIC);

    const res = await POST(operatorRequest(validBody()) as never);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("lithic_not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createVirtualCard).not.toHaveBeenCalled();
  });

  it("issues a virtual card with 201 through the configured adapter", async () => {
    vi.stubEnv("LITHIC_API_KEY", "lk_test_key");
    vi.stubEnv("LITHIC_ENV", "sandbox");
    vi.stubEnv("LITHIC_FINANCIAL_ACCOUNT_TOKEN", "fact_tok_test");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const store = new InMemoryStore();
    setStore(store);
    await seedVerifiedKyc(store);
    setVerticalComplianceStateSource(async () => SATISFIED_MUSIC);

    createVirtualCard.mockResolvedValue({
      ok: true,
      value: { cardToken: "card_tok_test_1", state: "OPEN" },
    });

    const res = await POST(operatorRequest(validBody()) as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      card: { card_token: "card_tok_test_1", state: "OPEN" },
    });
    expect(createVirtualCard).toHaveBeenCalledWith({
      idempotencyKey: UUID,
      memo: "Tour advance card",
      spendLimitCents: 100_000,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces an adapter failure honestly without a fake success", async () => {
    vi.stubEnv("LITHIC_API_KEY", "lk_test_key");
    vi.stubEnv("LITHIC_ENV", "sandbox");
    vi.stubEnv("LITHIC_FINANCIAL_ACCOUNT_TOKEN", "fact_tok_test");

    const store = new InMemoryStore();
    setStore(store);
    await seedVerifiedKyc(store);
    setVerticalComplianceStateSource(async () => SATISFIED_MUSIC);

    createVirtualCard.mockResolvedValue({
      ok: false,
      status: 502,
      code: "lithic_error",
      message: "Lithic returned an unexpected error.",
    });

    const res = await POST(operatorRequest(validBody()) as never);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("lithic_error");
  });
});
