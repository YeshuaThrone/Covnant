import { NextRequest, NextResponse } from "next/server";
import { donJsonError } from "@/lib/server/http";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { getStore } from "@/lib/server/store";
import { clientIdentity } from "@/modules/don/http";
import { validateUnifiedWebhookPayload } from "@/lib/don/validation";
import { ingestBaasWebhook, ingestDspWebhook } from "@/lib/server/webhooks";
import { authenticateStandardWebhookBody } from "@/modules/don/webhookSignature";

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

  // The body is read exactly once: its raw bytes are both the JSON payload
  // and the HMAC input (below), so the signature covers the delivered bytes.
  const rawBody = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
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

  if (parsed.value.kind === "baas") {
    // Signature gate (Standard Webhooks HMAC), mirroring the sibling routes
    // (/api/v1/webhooks/baas, /api/v1/webhooks/dsp): the payload's kind is
    // the only source discriminator, so the source-appropriate secret is
    // selected here and verified BEFORE any ingestor or store access — no
    // forged delivery can settle/fail/reverse a payout, create/reverse a
    // split run, or fabricate royalty income. An unset source secret fails
    // closed with a 401 not-configured error.
    const auth = authenticateStandardWebhookBody({
      rawBody,
      headers: request.headers,
      secretEnvVar: "COLUMN_WEBHOOK_SECRET",
    });
    if (!auth.ok) return auth.response;

    const result = await ingestBaasWebhook(getStore(), parsed.value.value);
    if (!result.ok) {
      return donJsonError(result.status, result.code, result.message);
    }
    return NextResponse.json(result, {
      status: result.idempotent ? 200 : 201,
    });
  }

  const auth = authenticateStandardWebhookBody({
    rawBody,
    headers: request.headers,
    secretEnvVar: "DSP_WEBHOOK_SECRET",
  });
  if (!auth.ok) return auth.response;

  const result = await ingestDspWebhook(getStore(), parsed.value.value);
  if (!result.ok) {
    return donJsonError(result.status, result.code, result.message);
  }
  return NextResponse.json(result, { status: result.idempotent ? 200 : 201 });
}
