import { NextRequest, NextResponse } from "next/server";
import { donJsonError } from "@/lib/server/http";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { getStore } from "@/lib/server/store";
import { requireOperator } from "@/lib/server/apiAccess";
import { clientIdentity } from "@/modules/don/http";
import { validateRecoupmentPayload } from "@/lib/don/validation";
import { readAdvance, upsertAdvance } from "@/modules/recoupment/engine";

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

  // GATED (hardening gen 12): upserting an advance retargets ANYONE's
  // recoupment position — an operator action. The signed admin cookie is
  // verified before any body is parsed.
  const access = requireOperator(request);
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
  const parsed = validateRecoupmentPayload(body);
  if (!parsed.ok) {
    const status = parsed.code === "malformed_body" ? 400 : 422;
    return donJsonError(status, parsed.code, parsed.message);
  }

  const advance = await upsertAdvance(getStore(), parsed.value);
  return NextResponse.json(advance, { status: 201 });
}

export async function GET(request: NextRequest) {
  const identity = clientIdentity(request);
  const limit = checkRateLimit(identity, DON_API_RATE_LIMIT);
  if (!limit.ok) {
    return donJsonError(
      429,
      "rate_limited",
      `Rate limit exceeded. Retry after ${limit.retryAfterSeconds}s.`,
    );
  }

  // GATED (hardening gen 12): the advance read resolves any creator_id —
  // operator-only, same as the POST.
  const access = requireOperator(request);
  if (!access.ok) {
    return donJsonError(access.status, access.code, access.message);
  }

  const creatorId = request.nextUrl.searchParams.get("creator_id")?.trim() ?? "";
  if (creatorId === "") {
    return donJsonError(
      422,
      "missing_creator_id",
      "creator_id is required.",
    );
  }
  return NextResponse.json(await readAdvance(getStore(), creatorId));
}
