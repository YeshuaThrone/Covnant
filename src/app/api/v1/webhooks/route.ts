import { NextRequest, NextResponse } from "next/server";
import { donJsonError } from "@/lib/server/http";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { getStore } from "@/lib/server/store";
import { clientIdentity } from "@/modules/don/http";
import { validateUnifiedWebhookPayload, type UnifiedWebhookPayload } from "@/lib/don/validation";
import { ingestBaasWebhook, ingestDspWebhook } from "@/lib/server/webhooks";
import {
  authenticateUnifiedStandardWebhook,
  type DonWebhookSecretEnv,
} from "@/modules/don/webhookSignature";

/** The signing secret each unified payload kind must have verified under. */
function expectedSecretForKind(kind: UnifiedWebhookPayload["kind"]): DonWebhookSecretEnv {
  return kind === "baas" ? "COLUMN_WEBHOOK_SECRET" : "DSP_WEBHOOK_SECRET";
}

export async function POST(request: NextRequest) {
  const identity = clientIdentity(request);
  const limit = checkRateLimit(identity, DON_API_RATE_LIMIT);
  if (!limit.ok) {
    return donJsonError(
      429,
      "rate_limited",
      `Rate limit exceeded. Retry after ${limit.retryAfterSeconds}s.`,
    );
  }

  // Signature gate (Standard Webhooks HMAC), matching the typed baas/ and
  // dsp/ routes: unsigned, stale, or unverifiable bodies are rejected here
  // — BEFORE the body is parsed, validated, or the store is read — so no
  // forged delivery can settle/fail/reverse a payout or fabricate royalty
  // income. Unset secrets fail closed with a 401 not-configured error.
  const auth = await authenticateUnifiedStandardWebhook(request, [
    "COLUMN_WEBHOOK_SECRET",
    "DSP_WEBHOOK_SECRET",
  ]);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = JSON.parse(auth.rawBody);
  } catch {
    return donJsonError(
      400,
      "malformed_body",
      "Request body must be valid JSON.",
    );
  }
  const parsed = validateUnifiedWebhookPayload(body);
  if (!parsed.ok) {
    const status = parsed.code === "malformed_body" ? 400 : 422;
    return donJsonError(status, parsed.code, parsed.message);
  }

  // Kind↔secret binding: the payload kind is only knowable after parsing,
  // but the delivery must still be signed by the payload kind's own
  // provider secret — a BaaS body signed under the DSP secret (or vice
  // versa) is an unknown-secret delivery, and accepting it would make this
  // route a weaker sibling of the typed routes. No store is touched.
  if (auth.verifiedWith !== expectedSecretForKind(parsed.value.kind)) {
    return donJsonError(
      403,
      "signature_invalid",
      "Webhook signature is invalid or stale.",
    );
  }

  if (parsed.value.kind === "baas") {
    const result = await ingestBaasWebhook(getStore(), parsed.value.value);
    if (!result.ok) {
      return donJsonError(result.status, result.code, result.message);
    }
    return NextResponse.json(result, {
      status: result.idempotent ? 200 : 201,
    });
  }

  const result = await ingestDspWebhook(getStore(), parsed.value.value);
  if (!result.ok) {
    return donJsonError(result.status, result.code, result.message);
  }
  return NextResponse.json(result, { status: result.idempotent ? 200 : 201 });
}
