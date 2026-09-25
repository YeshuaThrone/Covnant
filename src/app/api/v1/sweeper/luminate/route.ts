import { NextRequest, NextResponse } from "next/server";
import { sweepLuminate } from "@/covenant-sdk/routes/luminate";
import { donJsonError } from "@/lib/server/http";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { clientIdentity } from "@/modules/don/http";

/**
 * POST /api/v1/sweeper/luminate — normalize Luminate payloads and sweep
 * (D3 landing).
 *
 * Thin Next.js wrapper over the D1 `covenant-sdk/routes/luminate` logic —
 * the Express-paste composition vendored from EmeraldVal PR #41, re-keyed
 * to Covnant's house HTTP helpers: donJsonError failures ({error, code}
 * envelope), the shared 30/min/IP Don rate limiter, no auth (matching
 * today's unauthenticated /api/v1 surface). The normalizer is a sandbox
 * fixture: it never calls live Luminate HTTP.
 */

export async function POST(request: NextRequest) {
  const limit = checkRateLimit(clientIdentity(request), DON_API_RATE_LIMIT);
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

  const result = await sweepLuminate(body);
  if (!result.ok) {
    return donJsonError(result.status, result.code, result.error);
  }
  return NextResponse.json(result.body, { status: result.status });
}
