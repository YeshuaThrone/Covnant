import { NextRequest, NextResponse } from "next/server";
import { donJsonError } from "@/lib/server/http";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { getStore } from "@/lib/server/store";
import { clientIdentity } from "@/modules/don/http";
import { validateSplitCalculatePayload } from "@/lib/don/validation";
import { calculateUdrSplits } from "@/lib/server/udrSplits";

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
  const parsed = validateSplitCalculatePayload(body);
  if (!parsed.ok) {
    const status = parsed.code === "malformed_body" ? 400 : 422;
    return donJsonError(status, parsed.code, parsed.message);
  }

  try {
    const result = await calculateUdrSplits(getStore(), parsed.value);
    if (!result.ok) {
      return donJsonError(result.status, result.code, result.message);
    }
    return NextResponse.json(result.value, { status: 201 });
  } catch (error) {
    console.error("splits.calculate failed", error);
    return donJsonError(
      500,
      "split_calculation_failed",
      "Split calculation failed unexpectedly.",
    );
  }
}
