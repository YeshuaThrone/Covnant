import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";
import { setStore } from "@/lib/server/store";
import { InMemoryStore } from "@/lib/server/inMemoryStore";

/**
 * POST /api/v1/webhooks/dsp signature-gate contract tests
 * (audit art_GG1emERn C2 hardening).
 *
 * Covers the pinned Standard Webhooks HMAC verification ported from
 * /api/covnant/webhooks/increase: unsigned bodies (401), an unset
 * DSP_WEBHOOK_SECRET (401 fail-closed), wrong signatures and stale
 * timestamps (403), and a correctly signed fresh royalty.report accepted
 * end-to-end into the store (split run computed, event recorded, vaults
 * credited) with the event_id replay idempotency intact. The store is the
 * repo's InMemoryStore injection pattern (setStore, the canonical test
 * seam); rejection cases run with NO store injected, proving the gate
 * fires before any store read.
 */

const SECRET_RAW = "test-dsp-webhook-secret";
const SECRET_WHSEC = `whsec_${Buffer.from(SECRET_RAW).toString("base64")}`;
const SECRET_RAW_BYTES = Buffer.from(SECRET_RAW, "utf8");
const EVENT_ID = "evt_dsp_test_1";

const LINE_ITEMS = [
  {
    work_id: "trk_01",
    work_title: "Midnight On 6th",
    amount_cents: 10_000,
    splits: [
      {
        payee_id: "c1",
        payee_name: "Yeshua Throne",
        role: "creator" as const,
        share_bps: 7000,
      },
      {
        payee_id: "l1",
        payee_name: "Throne Records",
        role: "label" as const,
        share_bps: 3000,
      },
    ],
  },
];

function reportPayload(): Record<string, unknown> {
  return {
    event: "royalty.report",
    event_id: EVENT_ID,
    source: "spotify",
    period: "2026-08",
    line_items: LINE_ITEMS,
  };
}

function signedHeaders(
  rawBody: string,
  secret: Buffer = SECRET_RAW_BYTES,
  timestamp = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const signature = `v1,${createHmac("sha256", secret)
    .update(`${EVENT_ID}.${timestamp}.${rawBody}`)
    .digest("base64")}`;
  return {
    "webhook-id": EVENT_ID,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signature,
  };
}

function webhookRequest(
  rawBody: string,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/v1/webhooks/dsp", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

/** Signs the body with the raw-byte secret (not the whsec_ base64 form). */
function signedRequest(payload: unknown): Request {
  const rawBody = JSON.stringify(payload);
  return webhookRequest(rawBody, signedHeaders(rawBody));
}

beforeEach(() => {
  vi.stubEnv("DSP_WEBHOOK_SECRET", SECRET_WHSEC);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setStore(null);
});

describe("POST /api/v1/webhooks/dsp — signature gate", () => {
  it("rejects an unsigned body with 401 before any store read", async () => {
    // No store injected: a gate bypass would surface as a 500, not a 401.
    const res = await POST(
      webhookRequest(JSON.stringify({ event: "royalty.report" })) as never,
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("signature_missing");
  });

  it("fails closed with 401 when DSP_WEBHOOK_SECRET is unset", async () => {
    vi.stubEnv("DSP_WEBHOOK_SECRET", "");
    const rawBody = JSON.stringify(reportPayload());
    const res = await POST(webhookRequest(rawBody, signedHeaders(rawBody)) as never);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("signature_not_configured");
    expect(body.error).toContain("DSP_WEBHOOK_SECRET");
  });

  it("rejects a wrong signature with 403", async () => {
    const rawBody = JSON.stringify(reportPayload());
    const headers = signedHeaders(rawBody, Buffer.from("wrong secret", "utf8"));
    const res = await POST(webhookRequest(rawBody, headers) as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("signature_invalid");
  });

  it("rejects a stale timestamp with 403", async () => {
    const rawBody = JSON.stringify(reportPayload());
    const stale = Math.floor(Date.now() / 1000) - 400;
    const res = await POST(
      webhookRequest(rawBody, signedHeaders(rawBody, SECRET_RAW_BYTES, stale)) as never,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("signature_invalid");
  });
});

describe("POST /api/v1/webhooks/dsp — signed ingestion", () => {
  it("accepts a correctly signed fresh body end-to-end into the store", async () => {
    const store = new InMemoryStore();
    setStore(store);
    const res = await POST(signedRequest(reportPayload()) as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.idempotent).toBe(false);
    expect(body.split.split_run.gross_cents).toBe(10_000);
    // The event landed in the store, keyed by event_id, and the split
    // credited the creator's vault.
    await expect(store.getDspWebhookEvent(EVENT_ID)).resolves.toBeDefined();
    expect((await store.getVault("c1"))?.pending_balance).toBe(5320);
  });

  it("is idempotent on a validly signed replay of a known event", async () => {
    const store = new InMemoryStore();
    setStore(store);
    const first = await POST(signedRequest(reportPayload()) as never);
    expect(first.status).toBe(201);
    const replay = await POST(signedRequest(reportPayload()) as never);
    expect(replay.status).toBe(200);
    const body = await replay.json();
    expect(body.ok).toBe(true);
    expect(body.idempotent).toBe(true);
    // The replay must not double-credit the creator's vault.
    expect((await store.getVault("c1"))?.pending_balance).toBe(5320);
  });
});
