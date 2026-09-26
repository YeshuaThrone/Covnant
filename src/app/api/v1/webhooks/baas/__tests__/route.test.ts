import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";
import { setStore } from "@/lib/server/store";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { creditVault, payoutFromVault } from "@/modules/vaults/engine";

/**
 * POST /api/v1/webhooks/baas signature-gate contract tests
 * (audit art_GG1emERn C2 hardening).
 *
 * Covers the pinned Standard Webhooks HMAC verification ported from
 * /api/covnant/webhooks/increase: unsigned bodies (401), an unset
 * COLUMN_WEBHOOK_SECRET (401 fail-closed), wrong signatures and stale
 * timestamps (403), and a correctly signed fresh payout.settled accepted
 * end-to-end into the store (vault settled, event recorded) with the
 * event_id replay idempotency intact. The store is the repo's
 * InMemoryStore injection pattern (setStore, the canonical test seam);
 * rejection cases run with NO store injected, proving the gate fires
 * before any store read.
 */

const SECRET_RAW = "test-column-webhook-secret";
const SECRET_WHSEC = `whsec_${Buffer.from(SECRET_RAW).toString("base64")}`;
const SECRET_RAW_BYTES = Buffer.from(SECRET_RAW, "utf8");
const EVENT_ID = "evt_baas_test_1";

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
  return new Request("http://localhost/api/v1/webhooks/baas", {
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
  vi.stubEnv("COLUMN_WEBHOOK_SECRET", SECRET_WHSEC);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setStore(null);
});

describe("POST /api/v1/webhooks/baas — signature gate", () => {
  it("rejects an unsigned body with 401 before any store read", async () => {
    // No store injected: a gate bypass would surface as a 500, not a 401.
    const res = await POST(
      webhookRequest(JSON.stringify({ event: "payout.settled", transfer_id: "t1" })) as never,
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("signature_missing");
  });

  it("fails closed with 401 when COLUMN_WEBHOOK_SECRET is unset", async () => {
    vi.stubEnv("COLUMN_WEBHOOK_SECRET", "");
    const rawBody = JSON.stringify({ event: "payout.settled", transfer_id: "t1" });
    const res = await POST(webhookRequest(rawBody, signedHeaders(rawBody)) as never);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("signature_not_configured");
    expect(body.error).toContain("COLUMN_WEBHOOK_SECRET");
  });

  it("rejects a wrong signature with 403", async () => {
    const rawBody = JSON.stringify({ event: "payout.settled", transfer_id: "t1" });
    const headers = signedHeaders(rawBody, Buffer.from("wrong secret", "utf8"));
    const res = await POST(webhookRequest(rawBody, headers) as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("signature_invalid");
  });

  it("rejects a stale timestamp with 403", async () => {
    const rawBody = JSON.stringify({ event: "payout.settled", transfer_id: "t1" });
    const stale = Math.floor(Date.now() / 1000) - 400;
    const res = await POST(
      webhookRequest(rawBody, signedHeaders(rawBody, SECRET_RAW_BYTES, stale)) as never,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("signature_invalid");
  });
});

describe("POST /api/v1/webhooks/baas — signed ingestion", () => {
  it("accepts a correctly signed fresh body end-to-end into the store", async () => {
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
    const payload = {
      event: "payout.settled",
      transfer_id: paid.transfer.id,
      event_id: EVENT_ID,
    };
    const res = await POST(signedRequest(payload) as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.idempotent).toBe(false);
    expect(body.vault.pending_balance).toBe(0);
    // The event landed in the store, keyed by event_id.
    await expect(store.getWebhookEvent(EVENT_ID)).resolves.toBeDefined();
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
    const payload = {
      event: "payout.settled",
      transfer_id: paid.transfer.id,
      event_id: EVENT_ID,
    };
    const first = await POST(signedRequest(payload) as never);
    expect(first.status).toBe(201);
    const replay = await POST(signedRequest(payload) as never);
    expect(replay.status).toBe(200);
    const body = await replay.json();
    expect(body.ok).toBe(true);
    expect(body.idempotent).toBe(true);
    // The replay must not double-settle: the vault is still fully settled.
    expect(body.vault.pending_balance).toBe(0);
  });
});
