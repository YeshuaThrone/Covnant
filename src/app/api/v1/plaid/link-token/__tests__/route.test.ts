import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";
import { resetRateLimits } from "@/lib/server/rateLimit";
import type { SessionCreatorResolution } from "@/lib/server/sessionCreator";

/**
 * POST /api/v1/plaid/link-token — the creator session-gated Plaid Link
 * handshake. Creators connect their OWN banks; the response carries the
 * token and its expiration ONLY. The session resolver and the adapter
 * factory are mocked (importOriginal keeps the real not-configured posture
 * so the 503 discipline is tested against the actual env gate).
 */

const createLinkToken = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server/sessionCreator", () => ({
  resolveSessionCreator: vi.fn(),
}));

vi.mock("@/services/banking/plaid", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/banking/plaid")>();
  return {
    ...actual,
    createPlaidAdapter: vi.fn(() => ({ createLinkToken })),
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

function linkRequest(): Request {
  return new Request("http://localhost/api/v1/plaid/link-token", {
    method: "POST",
  });
}

beforeEach(() => {
  resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mockSession.mockReset();
  createLinkToken.mockReset();
});

describe("POST /api/v1/plaid/link-token — session gate", () => {
  it("rejects an anonymous session with 401 no_session", async () => {
    mockSession.mockResolvedValue({ kind: "anonymous" });
    const res = await POST(linkRequest() as never);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("no_session");
  });

  it("rejects an unregistered session with 403 not_registered", async () => {
    mockSession.mockResolvedValue({
      kind: "unregistered",
      reason: "profile_not_found",
    });
    const res = await POST(linkRequest() as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("not_registered");
  });

  it("answers 503 with zero outbound calls when Plaid is not configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockSession.mockResolvedValue(REGISTERED);

    const res = await POST(linkRequest() as never);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("plaid_not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createLinkToken).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/plaid/link-token — success", () => {
  it("returns the link token and expiration for the session's own identity", async () => {
    vi.stubEnv("PLAID_CLIENT_ID", "test-client");
    vi.stubEnv("PLAID_SECRET", "test-secret");
    vi.stubEnv("PLAID_ENV", "sandbox");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockSession.mockResolvedValue(REGISTERED);

    createLinkToken.mockResolvedValue({
      ok: true,
      value: { linkToken: "link-sandbox-abc", expiration: "2026-09-30T12:00:00Z" },
    });

    const res = await POST(linkRequest() as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      link_token: "link-sandbox-abc",
      expiration: "2026-09-30T12:00:00Z",
    });
    // The session creator's payee id is the client_user_id — never a raw
    // account identifier.
    expect(createLinkToken).toHaveBeenCalledWith({
      userId: "c_1",
      userName: "Yeshua Throne",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces an adapter failure honestly without a fake token", async () => {
    vi.stubEnv("PLAID_CLIENT_ID", "test-client");
    vi.stubEnv("PLAID_SECRET", "test-secret");
    vi.stubEnv("PLAID_ENV", "sandbox");
    mockSession.mockResolvedValue(REGISTERED);

    createLinkToken.mockResolvedValue({
      ok: false,
      status: 502,
      code: "plaid_error",
      message: "Plaid returned an unexpected error.",
    });

    const res = await POST(linkRequest() as never);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("plaid_error");
  });
});
