/**
 * Standard Webhooks HMAC verification for the Don ingestors
 * (/api/v1/webhooks/baas, /api/v1/webhooks/dsp).
 *
 * Ported verbatim from the proven implementation in
 * src/app/api/covnant/webhooks/increase/route.ts (audit art_GG1emERn C2:
 * the Don webhook routes accepted any schema-valid JSON — no HMAC, no
 * signing secret, no timestamp window). A forged body could settle/fail/
 * reverse payouts or fabricate royalty income, so the gate below must run
 * BEFORE any store read: the routes authenticate the raw body first and
 * only then parse/validate/ingest.
 *
 * Contract (pinned from the Standard Webhooks spec, same as the Increase
 * route): three request headers — `webhook-id` (the event id),
 * `webhook-timestamp` (unix seconds), and `webhook-signature` (one or more
 * space-separated "v1,<base64>" tokens, plural while signing secrets
 * rotate). The signed payload is "<webhook-id>.<webhook-timestamp>.<raw-
 * body>" and the MAC is HMAC-SHA256 keyed with the endpoint's signing
 * secret (per-provider env var; a "whsec_"-prefixed value is the
 * standard-webhooks base64 form — decode before use). Comparison is
 * timing-safe, and the timestamp is checked against a 5-minute freshness
 * window. Fail closed: missing secret or headers → 401; wrong signature
 * or a stale timestamp → 403 — the body is never processed, and no
 * signature failure can produce a 5xx. Replay idempotency stays where it
 * is (event_id checked inside the ingestors, before any money moves).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { donJsonError, type DonApiErrorEnvelope } from "@/lib/server/http";
import type { NextResponse } from "next/server";

/** 5-minute freshness window on the webhook timestamp (blunts replays). */
export const SIGNATURE_FRESHNESS_SECONDS = 300;

/** Standard Webhooks signing secret: "whsec_"-prefixed values are base64. */
function signingSecretBytes(configuredSecret: string): Buffer {
  if (configuredSecret.startsWith("whsec_")) {
    return Buffer.from(configuredSecret.slice("whsec_".length), "base64");
  }
  return Buffer.from(configuredSecret, "utf8");
}

/**
 * Standard Webhooks verification: HMAC-SHA256 over
 * "<webhook-id>.<webhook-timestamp>.<raw-body>", base64-encoded, "v1,"-prefixed,
 * compared timing-safe against every space-separated signature candidate, with a
 * freshness window on the timestamp to blunt replays.
 */
export function verifyStandardWebhookSignature(params: {
  rawBody: string;
  webhookId: string;
  webhookTimestamp: string;
  signatureHeader: string;
  configuredSecret: string;
}): boolean {
  const timestamp = Number.parseInt(params.webhookTimestamp, 10);
  if (!Number.isFinite(timestamp)) return false;
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (ageSeconds > SIGNATURE_FRESHNESS_SECONDS) return false;
  const expected =
    "v1," +
    createHmac("sha256", signingSecretBytes(params.configuredSecret))
      .update(`${params.webhookId}.${params.webhookTimestamp}.${params.rawBody}`)
      .digest("base64");
  const expectedBuffer = Buffer.from(expected);
  for (const candidate of params.signatureHeader.split(" ")) {
    const candidateBuffer = Buffer.from(candidate);
    if (
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer)
    ) {
      return true;
    }
  }
  return false;
}

export type StandardWebhookAuth =
  | { ok: true; rawBody: string }
  | { ok: false; response: NextResponse<DonApiErrorEnvelope> };

/**
 * The one signature gate for a Don webhook route: reads the raw body and
 * the Standard Webhooks headers, verifies against the per-provider secret
 * named by `secretEnvVar`, and fails closed (401/403) before the caller
 * touches the store. On success the raw body is returned for parsing so the
 * HMAC sees the exact delivered bytes.
 */
export async function authenticateStandardWebhook(
  request: Request,
  secretEnvVar: string,
): Promise<StandardWebhookAuth> {
  const rawBody = await request.text();
  const webhookId = request.headers.get("webhook-id");
  const webhookTimestamp = request.headers.get("webhook-timestamp");
  const signatureHeader = request.headers.get("webhook-signature");
  const configuredSecret = process.env[secretEnvVar];

  // Fail closed on ANY missing signature material: 4xx, never processed,
  // never a 5xx. An unset secret is its own 401 — a clear not-configured
  // error, consistent with the platform's fail-closed convention.
  if (!configuredSecret) {
    return {
      ok: false,
      response: donJsonError(
        401,
        "signature_not_configured",
        `Webhook signature verification is not configured: ${secretEnvVar} is unset.`,
      ),
    };
  }
  if (!webhookId || !webhookTimestamp || !signatureHeader) {
    return {
      ok: false,
      response: donJsonError(
        401,
        "signature_missing",
        "Webhook signature headers are missing.",
      ),
    };
  }
  if (
    !verifyStandardWebhookSignature({
      rawBody,
      webhookId,
      webhookTimestamp,
      signatureHeader,
      configuredSecret,
    })
  ) {
    return {
      ok: false,
      response: donJsonError(
        403,
        "signature_invalid",
        "Webhook signature is invalid or stale.",
      ),
    };
  }
  return { ok: true, rawBody };
}


/** Provider signing secrets a unified-route delivery may verify under. */
export type DonWebhookSecretEnv = "COLUMN_WEBHOOK_SECRET" | "DSP_WEBHOOK_SECRET";

export type UnifiedStandardWebhookAuth =
  | { ok: true; rawBody: string; verifiedWith: DonWebhookSecretEnv }
  | { ok: false; response: NextResponse<DonApiErrorEnvelope> };

/**
 * The unified /api/v1/webhooks route accepts two payload kinds behind one
 * URL, and the kind is only knowable after the body is parsed — while the
 * signature can only be verified over the raw bytes. This gate therefore
 * verifies the delivery against each provider's configured secret in turn
 * and reports which one authenticated it; the route then binds the
 * verified secret to the parsed payload kind (BaaS bodies must have
 * verified under COLUMN_WEBHOOK_SECRET, DSP bodies under
 * DSP_WEBHOOK_SECRET) so the unified route can never become a weaker
 * sibling of the typed baas/ and dsp/ routes. Same fail-closed contract
 * as `authenticateStandardWebhook`: no secret configured → 401, missing
 * headers → 401, no candidate verifies (wrong or stale) → 403 — all
 * before the body is parsed or any store is read.
 */
export async function authenticateUnifiedStandardWebhook(
  request: Request,
  secretEnvVars: readonly DonWebhookSecretEnv[],
): Promise<UnifiedStandardWebhookAuth> {
  const rawBody = await request.text();
  const webhookId = request.headers.get("webhook-id");
  const webhookTimestamp = request.headers.get("webhook-timestamp");
  const signatureHeader = request.headers.get("webhook-signature");

  const configured = secretEnvVars
    .map((name) => ({ name, secret: process.env[name] }))
    .filter((entry): entry is { name: DonWebhookSecretEnv; secret: string } =>
      Boolean(entry.secret),
    );

  if (configured.length === 0) {
    return {
      ok: false,
      response: donJsonError(
        401,
        "signature_not_configured",
        `Webhook signature verification is not configured: none of ${secretEnvVars.join(", ")} is set.`,
      ),
    };
  }
  if (!webhookId || !webhookTimestamp || !signatureHeader) {
    return {
      ok: false,
      response: donJsonError(
        401,
        "signature_missing",
        "Webhook signature headers are missing.",
      ),
    };
  }
  const verifiedWith = configured.find((entry) =>
    verifyStandardWebhookSignature({
      rawBody,
      webhookId,
      webhookTimestamp,
      signatureHeader,
      configuredSecret: entry.secret,
    }),
  );
  if (!verifiedWith) {
    return {
      ok: false,
      response: donJsonError(
        403,
        "signature_invalid",
        "Webhook signature is invalid or stale.",
      ),
    };
  }
  return { ok: true, rawBody, verifiedWith: verifiedWith.name };
}
