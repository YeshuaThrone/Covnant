import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";
import { setStore } from "@/lib/server/store";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { creditVault, payoutFromVault } from "@/modules/vaults/engine";

/**
 * POST /api/v1/webhooks (unified) signature-gate contract tests
 * (bug-hunt F2 hardening).
 *
 * The unified route forwards to the same money ingestors as the typed
 * baas/ and dsp/ routes, so it must satisfy the same Standard Webhooks
 * HMAC gate: unsigned bodies (401), no secret configured (401
 * fail-closed), wrong signatures and stale timestamps (403), and —
 * unique to the unified route, which accepts two payload kinds behind
 * one URL — a body signed under the OTHER provider's secret (403: a
 * BaaS-kind body must verify under COLUMN_WEBHOOK_SECRET, a DSP-kind
 * body under DSP_WEBHOOK_SECRET, so the unified route can never become
 * a weaker sibling of the typed routes). Correctly signed fresh bodies
 * ingest exactly as they do on the typed routes, with the event_id
 * replay idempotency intact. The store is the repo's InMemoryStore
 * injection pattern (setStore, the canonical test seam); rejection
 * cases run with NO store injected, proving the gate fires before any
 * store read.
 */

const COLUMN_SECRET_RAW = "test-column-webhook-secret";
const COLUMN_SECRET_WHSEC = `whsec_${Buffer.from(COLUMN_SECRET_RAW).toString("base64")}`;
const COLUMN_SECRET_BYTES = Buffer.from(COLUMN_SECRET_RAW, "utf8");

const DSP_SECRET_RAW = "test-dsp-webhook-secret";
const DSP_SECRET_WHSEC = `whsec_${Buffer.from(DSP_SECRET_RAW).toString("base64")}`;
const DSP_SECRET_BYTES = Buffer.from(DSP_SECRET_RAW, "utf8");

const EVENT_ID = "evt_unified_test_1";

function payoutSettledPayload(transferId: string): Record<string, unknown> {
  return {
    event: "payout.settled",
    transfer_id: transferId,
    event_id: EVENT_ID,
  };
}

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
  secret: Buffer,
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
  return new Request("http://localhost/api/v1/webhooks", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

/** Signs the body with the raw-byte secret (not the whsec_ base64 form). */
function signedRequest(payload: unknown, secret: Buffer = COLUMN_SECRET_BYTES): Request {
  const rawBody = JSON.stringify(payload);
  return webhookRequest(rawBody, signedHeaders(rawBody, secret));
}

beforeEach(() => {
  vi.stubEnv("COLUMN_WEBHOOK_SECRET", COLUMN_SECRET_WHSEC);
  vi.stubEnv("DSP_WEBHOOK_SECRET", DSP_SECRET_WHSEC);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setStore(null);
});

describe("POST /api/v1/webhooks — signature gate", () => {
  it("rejects an unsigned body with 401 before any store read", async () => {
    // No store injected: a gate bypass would surface as an ingest attempt
    // (500 without a store), never a 401.
    const res = await POST(
      webhookRequest(JSON.stringify({ event: "payout.settled", transfer_id: "t1" })) as never,
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("signature_missing");
  });

  it("fails closed with 401 when no signing secret is configured", async () => {
    vi.stubEnv("COLUMN_WEBHOOK_SECRET", "");
    vi.stubEnv("DSP_WEBHOOK_SECRET", "");
    const rawBody = JSON.stringify(payoutSettledPayload("t1"));
    const res = await POST(
      webhookRequest(rawBody, signedHeaders(rawBody, COLUMN_SECRET_BYTES)) as never,
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("signature_not_configured");
  });

  it("rejects a signature that verifies under neither configured secret with 403", async () => {
    const rawBody = JSON.stringify(payoutSettledPayload("t1"));
    const headers = signedHeaders(rawBody, Buffer.from("wrong secret", "utf8"));
    const res = await POST(webhookRequest(rawBody, headers) as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("signature_invalid");
  });

  it("rejects a stale timestamp with 403", async () => {
    const rawBody = JSON.stringify(payoutSettledPayload("t1"));
    const stale = Math.floor(Date.now() / 1000) - 400;
    const res = await POST(
      webhookRequest(rawBody, signedHeaders(rawBody, COLUMN_SECRET_BYTES, stale)) as never,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("signature_invalid");
  });

  it("rejects a BaaS-kind body signed under the DSP secret with 403 and no state change", async () => {
    const store = new InMemoryStore();
    setStore(store);
    await creditVault(store, "c1", "Yeshua Throne", 800, "available");
    const paid = await payoutFromVault(store, {
      payee_id: "c1",
      amount_cents: 800,
      rail: "ach",
    });
    expect(paid.ok).toBe(true);
    if (!paid.ok) {
      return;
    }
    // Correctly formed payout.settled body, but signed by the DSP
    // provider's secret — the unified route must not accept it where the
    // typed baas/ route would refuse it.
    const res = await POST(
      signedRequest(payoutSettledPayload(paid.transfer.id), DSP_SECRET_BYTES) as never,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("signature_invalid");
    // The forged settlement never landed: no event recorded, the payout
    // hold is untouched.
    await expect(store.getWebhookEvent(EVENT_ID)).resolves.toBeUndefined();
    expect((await store.getVault("c1"))?.pending_balance).toBe(800);
  });

  it("rejects a DSP-kind body signed under the COLUMN secret with 403 and no state change", async () => {
    const store = new InMemoryStore();
    setStore(store);
    const res = await POST(signedRequest(reportPayload()) as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("signature_invalid");
    // The forged royalty report never landed: no event, no vault credited.
    await expect(store.getDspWebhookEvent(EVENT_ID)).resolves.toBeUndefined();
    expect((await store.getVault("c1"))?.pending_balance ?? 0).toBe(0);
  });
});

describe("POST /api/v1/webhooks — signed ingestion", () => {
  it("accepts a correctly signed fresh payout.settled end-to-end into the store", async () => {
    const store = new InMemoryStore();
    setStore(store);
    await creditVault(store, "c1", "Yeshua Throne", 800, "available");
    const paid = await payoutFromVault(store, {
      payee_id: "c1",
      amount_cents: 800,
      rail: "ach",
    });
    expect(paid.ok).toBe(true);
    if (!paid.ok) {
      return;
    }
    const res = await POST(
      signedRequest(payoutSettledPayload(paid.transfer.id), COLUMN_SECRET_BYTES) as never,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.idempotent).toBe(false);
    expect(body.vault.pending_balance).toBe(0);
    // The event landed in the store, keyed by event_id.
    await expect(store.getWebhookEvent(EVENT_ID)).resolves.toBeDefined();
  });

  it("accepts a correctly signed fresh royalty.report end-to-end into the store", async () => {
    const store = new InMemoryStore();
    setStore(store);
    const res = await POST(signedRequest(reportPayload(), DSP_SECRET_BYTES) as never);
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
    await creditVault(store, "c1", "Yeshua Throne", 800, "available");
    const paid = await payoutFromVault(store, {
      payee_id: "c1",
      amount_cents: 800,
      rail: "ach",
    });
    expect(paid.ok).toBe(true);
    if (!paid.ok) {
      return;
    }
    const payload = payoutSettledPayload(paid.transfer.id);
    const first = await POST(signedRequest(payload, COLUMN_SECRET_BYTES) as never);
    expect(first.status).toBe(201);
    const replay = await POST(signedRequest(payload, COLUMN_SECRET_BYTES) as never);
    expect(replay.status).toBe(200);
    const body = await replay.json();
    expect(body.ok).toBe(true);
    expect(body.idempotent).toBe(true);
    // The replay must not double-settle: the vault is still fully settled.
    expect(body.vault.pending_balance).toBe(0);
  });
});
