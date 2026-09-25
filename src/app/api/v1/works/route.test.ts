// Ported from EmeraldVal PR #41 src/app/api/v1/works/route.test.ts (D3):
// same fixtures and wire assertions over the landed D1 route logic. The
// wrapper is re-keyed to Covnant's house HTTP helpers — donJsonError
// ({error, code} envelope, already the drop's failure shape) and the shared
// 30/min/IP Don limiter — so the additions here are the wrapper-boundary
// cases: malformed-JSON 400 and the 31st-request rate-limit outcome.
import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimits } from "@/lib/server/rateLimit";
import { resetCovenantRegistry } from "@/lib/server/covenantRegistry";
import { GET, POST } from "./route";

const BODY = {
  title: "Sandbox Track",
  identifiers: { isrc: "USAAA0000001" },
  registeredTerritories: ["US"],
  splits: [
    {
      partyId: "writer-1",
      partyName: "Ada Writer",
      role: "COMPOSER",
      sharePercentage: 70,
      payoutWalletOrAccount: "acct_writer",
    },
    {
      partyId: "pub-1",
      name: "Pub",
      role: "PUBLISHER",
      sharePercentage: 30,
      payoutWalletOrBank: "acct_pub",
    },
  ],
};

function postRequest(body: string): Request {
  return new Request("http://localhost:3000/api/v1/works", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

beforeEach(() => {
  resetRateLimits();
  resetCovenantRegistry();
});

describe("POST /api/v1/works", () => {
  it("registers a 70/30 work into the sandbox registry", async () => {
    const response = await POST(postRequest(JSON.stringify(BODY)) as never);
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.ok).toBe(true);
    expect(payload.work.workId).toBe("work_Sandbox_Track");
    expect(payload.work.title).toBe("Sandbox Track");
    expect(payload.work.splits).toHaveLength(2);
    expect(payload.codeCount).toBe(1);

    const listed = await GET();
    const listPayload = await listed.json();
    expect(listPayload.ok).toBe(true);
    expect(listPayload.works).toHaveLength(1);
    expect(listPayload.works[0].workId).toBe("work_Sandbox_Track");
  });

  it("returns 409 {error, code} when the workId is already registered", async () => {
    const first = await POST(
      postRequest(JSON.stringify({ ...BODY, workId: "work_dup" })) as never,
    );
    expect(first.status).toBe(201);
    const second = await POST(
      postRequest(JSON.stringify({ ...BODY, workId: "work_dup" })) as never,
    );
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({
      code: "work_exists",
      error: "workId work_dup is already registered.",
    });
  });

  it("returns 400 for a body that is not valid JSON", async () => {
    const response = await POST(postRequest("{not json") as never);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "malformed_body",
      error: "Request body must be valid JSON.",
    });
  });

  it("returns 400 {code:invalid_manifest} when title is missing", async () => {
    const response = await POST(
      postRequest(JSON.stringify({ splits: BODY.splits })) as never,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "invalid_manifest",
      error: "Must provide title and array of split parties.",
    });
  });

  it("returns 422 when splits do not sum to 10000 bps", async () => {
    const response = await POST(
      postRequest(
        JSON.stringify({
          ...BODY,
          splits: [BODY.splits[0]],
        }),
      ) as never,
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      code: "splits_do_not_balance",
      error: expect.stringContaining("10000 bps"),
    });
  });

  it("rate-limits the 31st request inside a minute", async () => {
    for (let i = 0; i < 30; i += 1) {
      const spent = await POST(postRequest("{}") as never);
      expect(spent.status).toBe(400);
    }
    const limited = await POST(postRequest(JSON.stringify(BODY)) as never);
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({
      code: "rate_limited",
      error: expect.stringContaining("Rate limit exceeded"),
    });
  });
});
