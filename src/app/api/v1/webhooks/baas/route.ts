import { NextRequest, NextResponse } from "next/server";
import { donJsonError } from "@/lib/server/http";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { getStore } from "@/lib/server/store";
import { clientIdentity } from "@/modules/don/http";
import { validateBaasWebhookPayload } from "@/lib/don/validation";
import { ingestBaasWebhook } from "@/lib/server/webhooks";

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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return donJsonError(
      400,
      "malformed_body",
      "Request body must be valid JSON.",
    );
  }
  const parsed = validateBaasWebhookPayload(body);
  if (!parsed.ok) {
    const status = parsed.code === "malformed_body" ? 400 : 422;
    return donJsonError(status, parsed.code, parsed.message);
  }

  const result = await ingestBaasWebhook(getStore(), parsed.value);
  if (!result.ok) {
    return donJsonError(result.status, result.code, result.message);
  }
  return NextResponse.json(result, { status: result.idempotent ? 200 : 201 });
}
