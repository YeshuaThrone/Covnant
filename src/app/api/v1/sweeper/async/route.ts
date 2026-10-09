import { NextRequest, NextResponse } from "next/server";
import { sweepAsync } from "@/covenant-sdk/routes/sweep-async";
import { donJsonError } from "@/lib/server/http";
import { requireRegisteredOrOperator } from "@/lib/server/apiAccess";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { clientIdentity } from "@/modules/don/http";

/**
 * POST /api/v1/sweeper/async — enqueue then drain the sandbox sweep queue
 * (D3 landing).
 *
 * Thin Next.js wrapper over the D1 `covenant-sdk/routes/sweep-async`
 * logic — the Express-paste composition vendored from EmeraldVal PR #41,
 * re-keyed to Covnant's house HTTP helpers: donJsonError failures
 * ({error, code} envelope) and the shared 30/min/IP Don rate limiter.
 *
 * AUTH (bug hunt F1): the POST is GATED behind requireRegisteredOrOperator
 * — a registered creator session or the signed operator cookie — answering
 * before the body is read or any sweep runs. Returns 202 with
 * `status:"drained"`: the queue is in-memory and drained inside this
 * request (3 attempts per job) — durability is a named founder decision,
 * not silent drift.
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
  // any sweep runs.
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

  const result = await sweepAsync(body);
  if (!result.ok) {
    return donJsonError(result.status, result.code, result.error);
  }
  return NextResponse.json(result.body, { status: result.status });
}
