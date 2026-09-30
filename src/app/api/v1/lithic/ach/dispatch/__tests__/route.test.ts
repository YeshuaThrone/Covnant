import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";
import { setStore } from "@/lib/server/store";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { ADMIN_COOKIE_NAME, mintAdminSessionToken } from "@/lib/admin/gate";
import { resetRateLimits } from "@/lib/server/rateLimit";
import { creditVault } from "@/modules/vaults/engine";
import { setVerticalComplianceStateSource } from "@/modules/compliance/payoutGate";

/**
 * POST /api/v1/lithic/ach/dispatch — the operator-only, compliance-gated
 * payout route, with the Lithic adapter module mocked (the real transport
 * never runs in tests; the zero-outbound claims are proven with a fetch spy
 * instead).
 *
 * Battery, in the order the route enforces it:
 *   1. operator gate: 503 admin_not_configured / 401 admin_not_authenticated;
 *   2. validation: 422 on a non-UUID idempotency key;
 *   3. the fail-closed compliance gate: settlement approval, Plaid-backed
 *      KYC, and the vertical family — every refusal is a NAMED 403 envelope
 *      that fires BEFORE any capability disclosure (a refused caller cannot
 *      even learn whether Lithic is configured);
 *   4. not-configured: 503 with zero outbound calls;
 *   5. success: 201 through payoutFromVault with the injected Lithic
 *      dispatcher — the vault holds, the ledger row posts, and the adapter
 *      received the tokenized destination + UUID idempotency key.
 */

const createAchTransfer = vi.hoisted(() => vi.fn());

// The implementation is passed to vi.fn() itself (not mockImplementation) so
// vi.restoreAllMocks() in afterEach restores to it instead of stripping it.
vi.mock("@/services/baas/LithicAdapter", () => ({
  LithicAdapter: vi.fn(() => ({ createAchTransfer })),
}));

const OPERATOR_PASSWORD = "test-operator-pass";
const UUID = "0e2d1a86-9c1b-4a7e-b8bd-3f5f7d2f9e01";

const SATISFIED_FILM = {
  vertical: "film" as const,
  cama_escrow_released: true,
  guild_residual_holdback_satisfied: true,
};

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    payee_id: "c_1",
    vertical: "film",
    operator_settlement_approved: true,
    idempotency_key: UUID,
    amount_cents: 25_000,
    destination: "bank_tok_xyz",
    memo: "Settlement",
    ...overrides,
  };
}

function operatorRequest(body: unknown): Request {
  const token = mintAdminSessionToken(new Date(), process.env);
  return new Request("http://localhost/api/v1/lithic/ach/dispatch", {
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
  createAchTransfer.mockReset();
});

describe("POST /api/v1/lithic/ach/dispatch — operator gate", () => {
  it("fails closed with 503 when the operator secret is unset", async () => {
    vi.stubEnv("ADMIN_DASHBOARD_PASSWORD", "");
    const res = await POST(operatorRequest(validBody()) as never);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("admin_not_configured");
  });

  it("rejects a request without the operator cookie with 401", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/lithic/ach/dispatch", {
        method: "POST",
        body: JSON.stringify(validBody()),
      }) as never,
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("admin_not_authenticated");
  });
});

describe("POST /api/v1/lithic/ach/dispatch — validation", () => {
  it("rejects a non-UUID idempotency key with 422", async () => {
    const res = await POST(
      operatorRequest(validBody({ idempotency_key: "not-a-uuid" })) as never,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("invalid_idempotency_key");
  });

  it("rejects an unknown vertical with 422", async () => {
    const res = await POST(
      operatorRequest(validBody({ vertical: "vaporwave" })) as never,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("invalid_vertical");
  });
});

describe("POST /api/v1/lithic/ach/dispatch — the fail-closed compliance gate", () => {
  it("refuses with settlement_not_approved before any capability disclosure", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const store = new InMemoryStore();
    setStore(store);
    await seedVerifiedKyc(store);
    setVerticalComplianceStateSource(async () => SATISFIED_FILM);

    const res = await POST(
      operatorRequest(validBody({ operator_settlement_approved: false })) as never,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("settlement_not_approved");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses with kyc_state_unknown when the creator has no KYC record", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    setStore(new InMemoryStore());
    setVerticalComplianceStateSource(async () => SATISFIED_FILM);

    const res = await POST(operatorRequest(validBody()) as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("kyc_state_unknown");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses with vertical_state_unknown while the recon layer has not populated state", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const store = new InMemoryStore();
    setStore(store);
    await seedVerifiedKyc(store);

    const res = await POST(operatorRequest(validBody()) as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("vertical_state_unknown");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses with film_cama_escrow_not_released when the vertical family fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const store = new InMemoryStore();
    setStore(store);
    await seedVerifiedKyc(store);
    setVerticalComplianceStateSource(async () => ({
      vertical: "film",
      cama_escrow_released: false,
      guild_residual_holdback_satisfied: true,
    }));

    const res = await POST(operatorRequest(validBody()) as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("film_cama_escrow_not_released");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/lithic/ach/dispatch — capability and success", () => {
  it("answers 503 with zero outbound calls when Lithic is not configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const store = new InMemoryStore();
    setStore(store);
    await seedVerifiedKyc(store);
    setVerticalComplianceStateSource(async () => SATISFIED_FILM);

    const res = await POST(operatorRequest(validBody()) as never);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("lithic_not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createAchTransfer).not.toHaveBeenCalled();
  });

  it("dispatches through payoutFromVault with 201 and the tokenized request fields", async () => {
    vi.stubEnv("LITHIC_API_KEY", "lk_test_key");
    vi.stubEnv("LITHIC_ENV", "sandbox");
    vi.stubEnv("LITHIC_FINANCIAL_ACCOUNT_TOKEN", "fact_tok_test");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const store = new InMemoryStore();
    setStore(store);
    await seedVerifiedKyc(store);
    setVerticalComplianceStateSource(async () => SATISFIED_FILM);
    const now = new Date();
    await creditVault(store, "c_1", "Yeshua Throne", 25_000, "available", now);

    createAchTransfer.mockResolvedValue({
      ok: true,
      mode: "sandbox",
      transfer: {
        id: "tr_lithic_test_1",
        provider: "lithic",
        rail: "ach",
        payee_id: "c_1",
        payee_name: "Yeshua Throne",
        amount_cents: 25_000,
        currency: "USD",
        status: "submitted",
        ledger_transaction_id: null,
        created_at: now.toISOString(),
        estimated_settlement: null,
      },
    });

    const res = await POST(operatorRequest(validBody()) as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.transfer).toMatchObject({ id: "tr_lithic_test_1", provider: "lithic" });
    expect(body.vault.available_balance).toBe(0);

    // The adapter received the vault-built request plus the tokenized
    // destination and the UUID idempotency key — never a raw account number.
    expect(createAchTransfer).toHaveBeenCalledTimes(1);
    const request = createAchTransfer.mock.calls[0][0];
    expect(request).toMatchObject({
      payee_id: "c_1",
      amount_cents: 25_000,
      destination_bank_token: "bank_tok_xyz",
      idempotency_key: UUID,
    });
    // Real HTTP stays out of the route: the adapter module was mocked, and
    // no transport fetch fired.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces a failed dispatch honestly without a fake success", async () => {
    vi.stubEnv("LITHIC_API_KEY", "lk_test_key");
    vi.stubEnv("LITHIC_ENV", "sandbox");
    vi.stubEnv("LITHIC_FINANCIAL_ACCOUNT_TOKEN", "fact_tok_test");

    const store = new InMemoryStore();
    setStore(store);
    await seedVerifiedKyc(store);
    setVerticalComplianceStateSource(async () => SATISFIED_FILM);
    await creditVault(store, "c_1", "Yeshua Throne", 25_000, "available", new Date());

    createAchTransfer.mockResolvedValue({
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
