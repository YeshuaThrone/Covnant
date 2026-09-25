// Ported from EmeraldVal PR #41 src/app/api/v1/sweeper/route.test.ts (D3):
// direct / async / luminate wire shapes unchanged over the landed D1 route
// logic, re-keyed to Covnant's house HTTP helpers. Addition required by the
// D3 gate: the queue-drain → query_audit_proof round trip — the routes and
// the default MCP host share the module-singleton registry in one process,
// so a 202 drained sweep must be visible to the registry-only MCP tool.
import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimits } from "@/lib/server/rateLimit";
import { resetCovenantRegistry } from "@/lib/server/covenantRegistry";
import { EmeraldValMcpToolHost } from "@/mcp/host";
import { POST as postWork } from "../works/route";
import { POST as postSweep } from "./route";
import { POST as postSweepAsync } from "./async/route";
import { POST as postLuminate } from "./luminate/route";

const WORK = {
  workId: "WORK_CHAMPION_001",
  title: "STATE OF THE ART",
  identifiers: { isrc: "USXX12600001", iswc: "T1234567890" },
  splits: [
    {
      partyId: "WRITER_01",
      partyName: "Yeshua Throne",
      role: "COMPOSER",
      sharePercentage: 50,
      payoutWalletOrAccount: "acct_writer",
    },
    {
      partyId: "PUBLISHER_01",
      partyName: "Covenant Publishing",
      role: "PUBLISHER",
      sharePercentage: 50,
      payoutWalletOrAccount: "acct_pub",
    },
  ],
};

const DSR = [
  "AS01\tBLOCK_01\tSTATE OF THE ART\tSTATE OF THE ART\tUSXX12600001\tT1234567890",
  "SU02\tBLOCK_01\t\t\t\t\t\t\tUS\tUSD\t10.00\t\tUNMATCHED_HOLD",
].join("\n");

function postRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetRateLimits();
  resetCovenantRegistry();
});

describe("Covenant sweeper HTTP mounts", () => {
  it("sweeps a DSR hold on POST /api/v1/sweeper", async () => {
    const registered = await postWork(
      postRequest("http://localhost:3000/api/v1/works", WORK) as never,
    );
    expect(registered.status).toBe(201);

    const response = await postSweep(
      postRequest("http://localhost:3000/api/v1/sweeper", {
        dsrRawFeed: DSR,
      }) as never,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      jobId: "sweep_direct",
      recoveredRevenueCents: 1_000,
      matchesFound: 1,
      disputes: 0,
    });
  });

  it("drains the sandbox queue on POST /api/v1/sweeper/async", async () => {
    await postWork(postRequest("http://localhost:3000/api/v1/works", WORK) as never);

    const response = await postSweepAsync(
      postRequest("http://localhost:3000/api/v1/sweeper/async", {
        jobId: "job_async_1",
        dsrRawFeed: DSR,
      }) as never,
    );
    expect(response.status).toBe(202);
    const payload = await response.json();
    expect(payload).toEqual({
      ok: true,
      jobId: "job_async_1",
      status: "drained",
      recoveredRevenueCents: 1_000,
      matchesFound: 1,
      disputes: 0,
    });
  });

  it("exposes the swept batch to the registry-only query_audit_proof tool", async () => {
    await postWork(postRequest("http://localhost:3000/api/v1/works", WORK) as never);

    const response = await postSweepAsync(
      postRequest("http://localhost:3000/api/v1/sweeper/async", {
        jobId: "job_proof_1",
        dsrRawFeed: DSR,
      }) as never,
    );
    expect(response.status).toBe(202);

    // Default host construction binds the same module-singleton registry the
    // routes drained into — no HTTP, one process.
    const proof = await new EmeraldValMcpToolHost().callTool(
      "query_audit_proof",
      { matchedWorkId: "WORK_CHAMPION_001" },
    );
    expect(proof.isError).toBe(false);
    const payload = proof.payload as { ok: boolean; proofs: unknown[] };
    expect(payload.ok).toBe(true);
    expect(payload.proofs.length).toBeGreaterThan(0);
  });

  it("ingests Luminate payloads on POST /api/v1/sweeper/luminate", async () => {
    await postWork(postRequest("http://localhost:3000/api/v1/works", WORK) as never);

    const response = await postLuminate(
      postRequest("http://localhost:3000/api/v1/sweeper/luminate", {
        payloads: [
          {
            luminateId: "LUM_CHAMPION_001",
            isrc: "USXX12600001",
            songTitle: "STATE OF THE ART",
            artistName: "Yeshua Throne",
            onDemandAudioStreams: 1_000,
            periodStartDate: "2026-01-01",
            periodEndDate: "2026-01-31",
            marketTerritory: "US",
          },
        ],
      }) as never,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      recoveredRevenueCents: 380,
      matchesFound: 1,
      disputes: 0,
      recordsIngested: 1,
    });
  });

  it("returns 400 when the direct sweeper is missing a feed", async () => {
    const response = await postSweep(
      postRequest("http://localhost:3000/api/v1/sweeper", {}) as never,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      code: "missing_feed",
      error: "Provide cwrRawFeed and/or dsrRawFeed.",
    });
  });
});
