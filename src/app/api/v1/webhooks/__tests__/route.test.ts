import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";
import { setStore } from "@/lib/server/store";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { creditVault, payoutFromVault } from "@/modules/vaults/engine";
import { ingestBaasWebhook, ingestDspWebhook } from "@/lib/server/webhooks";

/**
 * POST /api/v1/webhooks signature-gate regression tests (audit F5,
 * spec D4). The unified route serves both sources — the payload's kind is
 * the only source discriminator — so it verifies the Standard Webhooks
 * HMAC against the source-appropriate secret (COLUMN_WEBHOOK_SECRET for
 * baas, DSP_WEBHOOK_SECRET for dsp) BEFORE any ingestor runs, mirroring
 * the sibling routes (/api/v1/webhooks/baas, /api/v1/webhooks/dsp).
 *
 * Both ingestors are wrapped in spies over their real implementations:
 * every forged case (valid payload, missing/invalid signature) asserts the
 * spy was never invoked, and every signed case ingests end-to-end into the
 * InMemoryStore (setStore, the canonical test seam). Rejection cases run
 * with NO store injected, so a gate bypass would also surface as a 500
 * instead of the asserted 4xx.
 */

vi.mock("@/lib/server/webhooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/webhooks")>();
  return {
    ...actual,
    ingestBaasWebhook: vi.fn(actual.ingestBaasWebhook),
    ingestDspWebhook: vi.fn(actual.ingestDspWebhook),
  };
});

const COLUMN_SECRET_RAW = "test-column-webhook-secret";
const COLUMN_SECRET_WHSEC = `whsec_${Buffer.from(COLUMN_SECRET_RAW).toString("base64")}`;
const COLUMN_SECRET_BYTES = Buffer.from(COLUMN_SECRET_RAW, "utf8");
const DSP_SECRET_RAW = "test-dsp-webhook-secret";
const DSP_SECRET_WHSEC = `whsec_${Buffer.from(DSP_SECRET_RAW).toString("base64")}`;
const DSP_SECRET_BYTES = Buffer.from(DSP_SECRET_RAW, "utf8");

const BAAS_EVENT_ID = "evt_unified_baas_1";
const DSP_EVENT_ID = "evt_unified_dsp_1";

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

/** A schema-valid baas delivery (accepted by the unified validator). */
function baasPayload(transferId = "t1"): Record<string, unknown> {
  return {
    event: "payout.settled",
    transfer_id: transferId,
    event_id: BAAS_EVENT_ID,
  };
}

/** A schema-valid dsp delivery (accepted by the unified validator). */
function dspPayload(): Record<string, unknown> {
  return {
    event: "royalty.report",
    event_id: DSP_EVENT_ID,
    source: "spotify",
    period: "2026-08",
    line_items: LINE_ITEMS,
  };
}

function signedHeaders(
  rawBody: string,
  webhookId: string,
  secret: Buffer,
  timestamp = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const signature = `v1,${createHmac("sha256", secret)
    .update(`${webhookId}.${timestamp}.${rawBody}`)
    .digest("base64")}`;
  return {
    "webhook-id": webhookId,
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
function signedBaasRequest(payload: unknown): Request {
  const rawBody = JSON.stringify(payload);
  return webhookRequest(
    rawBody,
    signedHeaders(rawBody, BAAS_EVENT_ID, COLUMN_SECRET_BYTES),
  );
}

function signedDspRequest(payload: unknown): Request {
  const rawBody = JSON.stringify(payload);
  return webhookRequest(
    rawBody,
    signedHeaders(rawBody, DSP_EVENT_ID, DSP_SECRET_BYTES),
  );
}

const baasIngest = vi.mocked(ingestBaasWebhook);
const dspIngest = vi.mocked(ingestDspWebhook);

beforeEach(() => {
  vi.stubEnv("COLUMN_WEBHOOK_SECRET", COLUMN_SECRET_WHSEC);
  vi.stubEnv("DSP_WEBHOOK_SECRET", DSP_SECRET_WHSEC);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  setStore(null);
});

describe("POST /api/v1/webhooks — signature gate", () => {
  it("rejects an unsigned baas payload with 401 before any ingestor invocation", async () => {
    // No store injected: a gate bypass would surface as a 500, not a 401.
    const res = await POST(
      webhookRequest(JSON.stringify(baasPayload())) as never,
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("signature_missing");
    expect(baasIngest).not.toHaveBeenCalled();
    expect(dspIngest).not.toHaveBeenCalled();
  });

  it("rejects an unsigned dsp payload with 401 before any ingestor invocation", async () => {
    const res = await POST(
      webhookRequest(JSON.stringify(dspPayload())) as never,
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("signature_missing");
    expect(baasIngest).not.toHaveBeenCalled();
    expect(dspIngest).not.toHaveBeenCalled();
  });

  it("fails closed with 401 when COLUMN_WEBHOOK_SECRET is unset (baas payload)", async () => {
    vi.stubEnv("COLUMN_WEBHOOK_SECRET", "");
    const rawBody = JSON.stringify(baasPayload());
    const res = await POST(
      webhookRequest(
        rawBody,
        signedHeaders(rawBody, BAAS_EVENT_ID, COLUMN_SECRET_BYTES),
      ) as never,
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("signature_not_configured");
    expect(body.error).toContain("COLUMN_WEBHOOK_SECRET");
    expect(baasIngest).not.toHaveBeenCalled();
    expect(dspIngest).not.toHaveBeenCalled();
  });

  it("fails closed with 401 when DSP_WEBHOOK_SECRET is unset (dsp payload)", async () => {
    vi.stubEnv("DSP_WEBHOOK_SECRET", "");
    const rawBody = JSON.stringify(dspPayload());
    const res = await POST(
      webhookRequest(
        rawBody,
        signedHeaders(rawBody, DSP_EVENT_ID, DSP_SECRET_BYTES),
      ) as never,
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("signature_not_configured");
    expect(body.error).toContain("DSP_WEBHOOK_SECRET");
    expect(baasIngest).not.toHaveBeenCalled();
    expect(dspIngest).not.toHaveBeenCalled();
  });

  it("rejects a baas payload signed with the wrong secret with 403", async () => {
    const rawBody = JSON.stringify(baasPayload());
    const res = await POST(
      webhookRequest(
        rawBody,
        signedHeaders(rawBody, BAAS_EVENT_ID, Buffer.from("wrong secret", "utf8")),
      ) as never,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("signature_invalid");
    expect(baasIngest).not.toHaveBeenCalled();
    expect(dspIngest).not.toHaveBeenCalled();
  });

  it("rejects a dsp payload signed with the wrong secret with 403", async () => {
    const rawBody = JSON.stringify(dspPayload());
    const res = await POST(
      webhookRequest(
        rawBody,
        signedHeaders(rawBody, DSP_EVENT_ID, Buffer.from("wrong secret", "utf8")),
      ) as never,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("signature_invalid");
    expect(baasIngest).not.toHaveBeenCalled();
    expect(dspIngest).not.toHaveBeenCalled();
  });

  it("rejects a baas payload signed with the DSP secret with 403 (per-source secret selection)", async () => {
    const rawBody = JSON.stringify(baasPayload());
    const res = await POST(
      webhookRequest(
        rawBody,
        signedHeaders(rawBody, BAAS_EVENT_ID, DSP_SECRET_BYTES),
      ) as never,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("signature_invalid");
    expect(baasIngest).not.toHaveBeenCalled();
    expect(dspIngest).not.toHaveBeenCalled();
  });

  it("rejects a dsp payload signed with the COLUMN secret with 403 (per-source secret selection)", async () => {
    const rawBody = JSON.stringify(dspPayload());
    const res = await POST(
      webhookRequest(
        rawBody,
        signedHeaders(rawBody, DSP_EVENT_ID, COLUMN_SECRET_BYTES),
      ) as never,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("signature_invalid");
    expect(baasIngest).not.toHaveBeenCalled();
    expect(dspIngest).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp with 403", async () => {
    const rawBody = JSON.stringify(baasPayload());
    const stale = Math.floor(Date.now() / 1000) - 400;
    const res = await POST(
      webhookRequest(
        rawBody,
        signedHeaders(rawBody, BAAS_EVENT_ID, COLUMN_SECRET_BYTES, stale),
      ) as never,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("signature_invalid");
    expect(baasIngest).not.toHaveBeenCalled();
    expect(dspIngest).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/webhooks — signed ingestion", () => {
  it("accepts a correctly signed baas payout.settled end-to-end into the store", async () => {
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
      signedBaasRequest(baasPayload(paid.transfer.id)) as never,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.idempotent).toBe(false);
    expect(body.vault.pending_balance).toBe(0);
    // The event landed in the store, keyed by event_id.
    await expect(store.getWebhookEvent(BAAS_EVENT_ID)).resolves.toBeDefined();
    expect(baasIngest).toHaveBeenCalledTimes(1);
    expect(baasIngest).toHaveBeenCalledWith(store, {
      event: "payout.settled",
      transfer_id: paid.transfer.id,
      event_id: BAAS_EVENT_ID,
    });
    expect(dspIngest).not.toHaveBeenCalled();
  });

  it("accepts a correctly signed dsp royalty.report end-to-end into the store", async () => {
    const store = new InMemoryStore();
    setStore(store);
    const res = await POST(signedDspRequest(dspPayload()) as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.idempotent).toBe(false);
    expect(body.split.split_run.gross_cents).toBe(10_000);
    await expect(store.getDspWebhookEvent(DSP_EVENT_ID)).resolves.toBeDefined();
    expect((await store.getVault("c1"))?.pending_balance).toBe(5320);
    expect(dspIngest).toHaveBeenCalledTimes(1);
    expect(baasIngest).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/webhooks — validation ahead of the gate", () => {
  it("keeps the 400 malformed_body shape for invalid JSON", async () => {
    const res = await POST(webhookRequest("not json") as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("malformed_body");
    expect(baasIngest).not.toHaveBeenCalled();
    expect(dspIngest).not.toHaveBeenCalled();
  });

  it("keeps the 422 invalid_webhook_event shape for an unknown event", async () => {
    const res = await POST(
      webhookRequest(JSON.stringify({ event: "hacked.transfer" })) as never,
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("invalid_webhook_event");
    expect(baasIngest).not.toHaveBeenCalled();
    expect(dspIngest).not.toHaveBeenCalled();
  });
});
