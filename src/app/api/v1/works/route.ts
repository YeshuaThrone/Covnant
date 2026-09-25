import { NextRequest, NextResponse } from "next/server";
import { listWorks, registerWork } from "@/covenant-sdk/routes/works";
import { donJsonError } from "@/lib/server/http";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { clientIdentity } from "@/modules/don/http";

/**
 * POST/GET /api/v1/works — Covenant work registration (D3 landing).
 *
 * Thin Next.js wrapper over the D1 `covenant-sdk/routes/works` logic — the
 * Express-paste composition vendored from EmeraldVal PR #41, re-keyed to
 * Covnant's house HTTP helpers: donJsonError failures ({error, code}
 * envelope), the shared 30/min/IP Don rate limiter, no auth (matching
 * today's unauthenticated /api/v1 surface). Success bodies pass through the
 * SDK's RouteResult bodies unchanged.
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

  const result = await registerWork(body);
  if (!result.ok) {
    return donJsonError(result.status, result.code, result.error);
  }
  return NextResponse.json(result.body, { status: result.status });
}

export async function GET() {
  const result = listWorks();
  if (!result.ok) {
    return donJsonError(result.status, result.code, result.error);
  }
  return NextResponse.json(result.body, { status: result.status });
}
