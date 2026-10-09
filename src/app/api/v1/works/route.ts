import { NextRequest, NextResponse } from "next/server";
import { listWorks, registerWork } from "@/covenant-sdk/routes/works";
import { donJsonError } from "@/lib/server/http";
import { requireRegisteredOrOperator } from "@/lib/server/apiAccess";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { clientIdentity } from "@/modules/don/http";

/**
 * POST/GET /api/v1/works — Covenant work registration (D3 landing).
 *
 * Thin Next.js wrapper over the D1 `covenant-sdk/routes/works` logic — the
 * Express-paste composition vendored from EmeraldVal PR #41, re-keyed to
 * Covnant's house HTTP helpers: donJsonError failures ({error, code}
 * envelope) and the shared 30/min/IP Don rate limiter. Success bodies pass
 * through the SDK's RouteResult bodies unchanged.
 *
 * AUTH (bug hunt F1): the POST is GATED behind requireRegisteredOrOperator
 * — a registered creator session or the signed operator cookie — answering
 * before the body is read or any registration runs. The GET stays a public
 * read, untouched.
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

  // GATED (bug hunt F1): a registered creator session or the operator —
  // never a visitor. The gate answers before the body is read and before
  // any work registration runs.
  const access = await requireRegisteredOrOperator(request);
  if (!access.ok) {
    return donJsonError(access.status, access.code, access.message);
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
