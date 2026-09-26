import { NextRequest, NextResponse } from "next/server";
import { donJsonError } from "@/lib/server/http";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { getStore } from "@/lib/server/store";
import { clientIdentity } from "@/modules/don/http";
import { validateDspWebhookPayload } from "@/lib/don/validation";
import { ingestDspWebhook } from "@/lib/server/webhooks";
import { authenticateStandardWebhook } from "@/modules/don/webhookSignature";

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

  // Signature gate (Standard Webhooks HMAC): unsigned, stale, or mismatched
  // bodies are rejected here — BEFORE the body is parsed, validated, or the
  // store is read — so no forged delivery can fabricate royalty income.
  // Unset secret fails closed with a 401 not-configured error.
  const auth = await authenticateStandardWebhook(request, "DSP_WEBHOOK_SECRET");
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
  const parsed = validateDspWebhookPayload(body);
  if (!parsed.ok) {
    const status = parsed.code === "malformed_body" ? 400 : 422;
    return donJsonError(status, parsed.code, parsed.message);
  }

  const result = await ingestDspWebhook(getStore(), parsed.value);
  if (!result.ok) {
    return donJsonError(result.status, result.code, result.message);
  }
  return NextResponse.json(result, { status: result.idempotent ? 200 : 201 });
}
