import { createHmac, timingSafeEqual } from "node:crypto";
import { donJsonError } from "@/lib/server/http";
import type { NextResponse } from "next/server";

/**
 * Stripe webhook signature verification — Stripe's OWN scheme (distinct from
 * the Standard Webhooks verifier in webhookSignature.ts):
 *
 *   header:  Stripe-Signature: t=<unix-seconds>,v1=<hex-hmac>[,v1=...]
 *   mac:     HMAC-SHA256(secret, `${t}.${rawBody}`) — hex-encoded
 *
 * Fail-closed: an unset secret, a missing header, a bad MAC, or a timestamp
 * outside the tolerance window refuses the delivery before any parse.
 */

/** Stripe's default replay tolerance (300s) per their webhook docs. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

export function parseStripeSignatureHeader(
  header: string,
): { timestamp: string; signatures: string[] } | null {
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      return null;
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      timestamp = value;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) {
    return null;
  }
  return { timestamp, signatures };
}

export function verifyStripeWebhookSignature(params: {
  rawBody: string;
  signatureHeader: string;
  configuredSecret: string;
}): boolean {
  const parsed = parseStripeSignatureHeader(params.signatureHeader);
  if (parsed === null) {
    return false;
  }
  const timestamp = Number.parseInt(parsed.timestamp, 10);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > STRIPE_SIGNATURE_TOLERANCE_SECONDS) {
    return false; // Stale — a replay.
  }
  const expected = createHmac("sha256", params.configuredSecret)
    .update(`${parsed.timestamp}.${params.rawBody}`)
    .digest("hex");
  for (const candidate of parsed.signatures) {
    const a = Buffer.from(candidate, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return true;
    }
  }
  return false;
}

export type StripeWebhookAuth =
  | { ok: true; rawBody: string }
  | { ok: false; response: NextResponse };

export async function authenticateStripeWebhook(
  request: Request,
  secretEnvVar: string,
): Promise<StripeWebhookAuth> {
  const rawBody = await request.text();
  const configuredSecret = process.env[secretEnvVar];
  if (!configuredSecret) {
    return {
      ok: false,
      response: donJsonError(
        401,
        "signature_not_configured",
        `Stripe webhook signature verification is not configured: ${secretEnvVar} is unset.`,
      ),
    };
  }
  const signatureHeader = request.headers.get("stripe-signature");
  if (!signatureHeader) {
    return {
      ok: false,
      response: donJsonError(
        401,
        "signature_missing",
        "The Stripe-Signature header is missing.",
      ),
    };
  }
  if (
    !verifyStripeWebhookSignature({ rawBody, signatureHeader, configuredSecret })
  ) {
    return {
      ok: false,
      response: donJsonError(
        403,
        "signature_invalid",
        "The Stripe webhook signature is invalid or stale.",
      ),
    };
  }
  return { ok: true, rawBody };
}
