// Tests for the internal onboarding phone-OTP MCP tools (founder directive C):
// catalog shape + internal-only descriptions, the isVerifyPhoneMcpTool guard,
// outcome → tool-result mapping for every lifecycle outcome, the shared
// rate-limit bucket key, no-session construction, code-free outputs, and
// dispatch through the composed EmeraldValMcpToolHost.
import { beforeEach, describe, expect, it, vi } from "vitest";

const requestPhoneOtp = vi.hoisted(() => vi.fn());
const verifyPhoneOtp = vi.hoisted(() => vi.fn());

vi.mock("@/lib/covnant/otp/lifecycle", () => ({
  OTP_REJECTION_COPY: {
    invalid_code: "That code is not right. Check the message and try again.",
    code_used: "That code was already used. Request a new one.",
    code_expired: "That code expired. Request a new one.",
    too_many_attempts: "Too many attempts. Request a new code.",
  },
  requestPhoneOtp,
  verifyPhoneOtp,
}));

import { EmeraldValMcpToolHost } from "../host";
import {
  isVerifyPhoneMcpTool,
  VerifyPhoneMcpToolHost,
  VERIFY_PHONE_MCP_TOOLS,
} from "../verify-phone-tools";

/** Every payload an MCP result can leak through — payload + the whole result. */
function assertCodeFree(result: { isError: boolean; payload: unknown }, code: string): void {
  expect(JSON.stringify(result)).not.toContain(code);
}

describe("VERIFY_PHONE_MCP_TOOLS catalog", () => {
  it("registers exactly the two onboarding tools with object schemas", () => {
    expect(VERIFY_PHONE_MCP_TOOLS.map((tool) => tool.name)).toEqual([
      "send_phone_otp",
      "verify_phone_otp",
    ]);
    for (const tool of VERIFY_PHONE_MCP_TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description).toContain("Internal onboarding only");
      expect(tool.description).toContain("Never returns the code");
    }
  });

  it("requires email plus phone / code in the input schemas", () => {
    expect(VERIFY_PHONE_MCP_TOOLS[0].inputSchema.required).toEqual(["email", "phone"]);
    expect(VERIFY_PHONE_MCP_TOOLS[1].inputSchema.required).toEqual(["email", "code"]);
  });

  it("is guarded by isVerifyPhoneMcpTool and nothing else in the catalog collides", () => {
    expect(isVerifyPhoneMcpTool("send_phone_otp")).toBe(true);
    expect(isVerifyPhoneMcpTool("verify_phone_otp")).toBe(true);
    expect(isVerifyPhoneMcpTool("splits_calculate")).toBe(false);
    expect(isVerifyPhoneMcpTool("not_a_tool")).toBe(false);
  });
});

describe("VerifyPhoneMcpToolHost.send_phone_otp", () => {
  const host = new VerifyPhoneMcpToolHost();

  beforeEach(() => {
    requestPhoneOtp.mockReset();
    verifyPhoneOtp.mockReset();
  });

  it("maps a delivered send to ok:true with delivery metadata and passes the shared MCP rate-limit key", async () => {
    requestPhoneOtp.mockResolvedValue({ outcome: "sent", delivered: true, deliveredVia: "whatsapp" });
    const result = await host.callTool("send_phone_otp", {
      email: "Creator@Example.com",
      phone: "(830) 358-2306",
    });
    expect(result.isError).toBe(false);
    expect(result.payload).toEqual({ ok: true, delivered: true, deliveredVia: "whatsapp" });
    expect(requestPhoneOtp).toHaveBeenCalledWith(
      "mcp-internal-onboarding",
      { email: "Creator@Example.com", phone: "(830) 358-2306" },
    );
    assertCodeFree(result, "123456");
  });

  it("maps an ineligible profile to the same generic delivered:false payload (no enumeration)", async () => {
    requestPhoneOtp.mockResolvedValue({ outcome: "sent", delivered: false, deliveredVia: null });
    const result = await host.callTool("send_phone_otp", { email: "unknown@example.com", phone: "+18303582306" });
    expect(result.isError).toBe(false);
    expect(result.payload).toEqual({ ok: true, delivered: false, deliveredVia: null });
  });

  it("maps validation, cooldown, not-configured, and store failures to named errors", async () => {
    requestPhoneOtp.mockResolvedValue({ outcome: "invalid_input", reason: "invalid_phone" });
    expect((await host.callTool("send_phone_otp", {})).payload).toMatchObject({ code: "invalid_request" });

    requestPhoneOtp.mockResolvedValue({ outcome: "rate_limited", kind: "resend_cooldown" });
    expect((await host.callTool("send_phone_otp", {})).payload).toMatchObject({ code: "resend_cooldown" });

    requestPhoneOtp.mockResolvedValue({ outcome: "rate_limited", kind: "ip_window" });
    expect((await host.callTool("send_phone_otp", {})).payload).toMatchObject({ code: "rate_limited" });

    requestPhoneOtp.mockResolvedValue({ outcome: "not_configured", reason: "otp_not_configured" });
    expect((await host.callTool("send_phone_otp", {})).payload).toMatchObject({ code: "otp_not_configured" });

    requestPhoneOtp.mockResolvedValue({ outcome: "store_error" });
    const storeFailure = await host.callTool("send_phone_otp", {});
    expect(storeFailure.isError).toBe(true);
    expect(storeFailure.payload).toMatchObject({ code: "otp_request_failed" });
  });

  it("tolerates missing args (undefined body) without throwing", async () => {
    requestPhoneOtp.mockResolvedValue({ outcome: "invalid_input", reason: "invalid_email" });
    const result = await host.callTool("send_phone_otp", undefined);
    expect(result.payload).toMatchObject({ code: "invalid_request" });
    expect(requestPhoneOtp).toHaveBeenCalledWith("mcp-internal-onboarding", { email: undefined, phone: undefined });
  });
});

describe("VerifyPhoneMcpToolHost.verify_phone_otp", () => {
  const host = new VerifyPhoneMcpToolHost();

  beforeEach(() => {
    requestPhoneOtp.mockReset();
    verifyPhoneOtp.mockReset();
  });

  it("maps a successful verify to ok:true verified:true — and never echoes the code", async () => {
    verifyPhoneOtp.mockResolvedValue({ outcome: "verified" });
    const result = await host.callTool("verify_phone_otp", { email: "creator@example.com", code: "482913" });
    expect(result.isError).toBe(false);
    expect(result.payload).toEqual({ ok: true, verified: true });
    assertCodeFree(result, "482913");
  });

  it("maps every rejection to its plain-language error code and copy", async () => {
    for (const reason of ["invalid_code", "code_used", "code_expired", "too_many_attempts"] as const) {
      verifyPhoneOtp.mockResolvedValue({ outcome: "rejected", reason });
      const result = await host.callTool("verify_phone_otp", { email: "creator@example.com", code: "000000" });
      expect(result.isError).toBe(true);
      expect(result.payload).toMatchObject({ code: reason });
      assertCodeFree(result, "000000");
    }
  });

  it("maps a malformed code and a limiter trip without burning a lifecycle attempt", async () => {
    verifyPhoneOtp.mockResolvedValue({ outcome: "invalid_input", reason: "invalid_code" });
    expect((await host.callTool("verify_phone_otp", {})).payload).toMatchObject({ code: "invalid_request" });

    verifyPhoneOtp.mockResolvedValue({ outcome: "rate_limited" });
    expect((await host.callTool("verify_phone_otp", {})).payload).toMatchObject({ code: "rate_limited" });
    expect(verifyPhoneOtp).toHaveBeenCalledWith("mcp-internal-onboarding", {
      email: undefined,
      code: undefined,
    });
  });
});

describe("composed host integration", () => {
  it("routes the verify-phone tools through EmeraldValMcpToolHost without a session", async () => {
    const host = new EmeraldValMcpToolHost();
    requestPhoneOtp.mockResolvedValue({ outcome: "sent", delivered: false, deliveredVia: null });
    const result = await host.callTool("send_phone_otp", { email: "creator@example.com", phone: "+18303582306" });
    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({ delivered: false });
  });

  it("lists 28 tools from the composed host including the verify-phone pair", () => {
    const names = new EmeraldValMcpToolHost().listTools().map((tool) => tool.name);
    expect(names).toContain("send_phone_otp");
    expect(names).toContain("verify_phone_otp");
    expect(names).toHaveLength(28);
  });

  it("keeps unknown-tool dispatch failing closed", async () => {
    const result = await new EmeraldValMcpToolHost().callTool("not_a_tool", {});
    expect(result.isError).toBe(true);
  });
});
