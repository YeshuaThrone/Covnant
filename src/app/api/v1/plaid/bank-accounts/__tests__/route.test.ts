import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";
import { resetRateLimits } from "@/lib/server/rateLimit";
import type { SessionCreatorResolution } from "@/lib/server/sessionCreator";

/**
 * POST /api/v1/plaid/bank-accounts — verification status for the creator's
 * own connected accounts. The exchange reads /auth/get through the adapter;
 * the response carries verification status and the last-4 mask ONLY — full
 * account numbers never leave the adapter. Session resolver and adapter
 * factory are mocked (importOriginal keeps the real not-configured posture).
 */

const getBankAccountVerification = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/sessionCreator", () => ({
  resolveSessionCreator: vi.fn(),
}));

vi.mock("@/services/banking/plaid", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/banking/plaid")>();
  return {
    ...actual,
    createPlaidAdapter: vi.fn(() => ({ getBankAccountVerification })),
  };
});

import { resolveSessionCreator } from "@/lib/server/sessionCreator";

const mockSession = vi.mocked(resolveSessionCreator);

const REGISTERED: SessionCreatorResolution = {
  kind: "registered",
  creator: {
    payee_id: "c_1",
    stage_name: "Yeshua Throne",
    kyc_status: "verified",
    bank_account_linked: false,
    provisioning_status: "PROVISIONED",
  },
};

function verifyRequest(body: unknown): Request {
  return new Request("http://localhost/api/v1/plaid/bank-accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mockSession.mockReset();
  getBankAccountVerification.mockReset();
});

describe("POST /api/v1/plaid/bank-accounts — session gate", () => {
  it("rejects an anonymous session with 401 no_session", async () => {
    mockSession.mockResolvedValue({ kind: "anonymous" });
    const res = await POST(verifyRequest({ public_token: "t" }) as never);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("no_session");
  });

  it("rejects an unregistered session with 403 not_registered", async () => {
    mockSession.mockResolvedValue({
      kind: "unregistered",
      reason: "holder_not_found",
    });
    const res = await POST(verifyRequest({ public_token: "t" }) as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("not_registered");
  });
});

describe("POST /api/v1/plaid/bank-accounts — validation", () => {
  it("rejects malformed JSON with 400", async () => {
    mockSession.mockResolvedValue(REGISTERED);
    const res = await POST(verifyRequest("not-json") as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("malformed_body");
  });

  it("rejects a missing public_token with 422", async () => {
    mockSession.mockResolvedValue(REGISTERED);
    const res = await POST(verifyRequest({}) as never);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("missing_public_token");
  });

  it("answers 503 with zero outbound calls when Plaid is not configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockSession.mockResolvedValue(REGISTERED);

    const res = await POST(verifyRequest({ public_token: "tok" }) as never);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("plaid_not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getBankAccountVerification).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/plaid/bank-accounts — success", () => {
  it("returns mask-only account metadata for the creator's own exchange", async () => {
    vi.stubEnv("PLAID_CLIENT_ID", "test-client");
    vi.stubEnv("PLAID_SECRET", "test-secret");
    vi.stubEnv("PLAID_ENV", "sandbox");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockSession.mockResolvedValue(REGISTERED);

    getBankAccountVerification.mockResolvedValue({
      ok: true,
      value: {
        accounts: [
          {
            accountId: "acc_1",
            name: "Checking",
            officialName: "Platinum Checking",
            verificationStatus: "automatically_verified",
            mask: "4444",
          },
        ],
      },
    });

    const res = await POST(verifyRequest({ public_token: "tok" }) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.accounts).toEqual([
      {
        account_id: "acc_1",
        name: "Checking",
        official_name: "Platinum Checking",
        verification_status: "automatically_verified",
        mask: "4444",
      },
    ]);
    expect(getBankAccountVerification).toHaveBeenCalledWith({
      publicToken: "tok",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces an adapter failure honestly without a fake status", async () => {
    vi.stubEnv("PLAID_CLIENT_ID", "test-client");
    vi.stubEnv("PLAID_SECRET", "test-secret");
    vi.stubEnv("PLAID_ENV", "sandbox");
    mockSession.mockResolvedValue(REGISTERED);

    getBankAccountVerification.mockResolvedValue({
      ok: false,
      status: 502,
      code: "plaid_error",
      message: "Plaid returned an unexpected error.",
    });

    const res = await POST(verifyRequest({ public_token: "tok" }) as never);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("plaid_error");
  });
});
