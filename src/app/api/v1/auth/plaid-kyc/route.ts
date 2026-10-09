import { NextRequest, NextResponse } from "next/server";
import { donJsonError } from "@/lib/server/http";
import { requireRegisteredOrOperator } from "@/lib/server/apiAccess";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { getStore } from "@/lib/server/store";
import { clientIdentity } from "@/modules/don/http";
import { validatePlaidKycPayload } from "@/lib/don/validation";
import { handlePlaidKyc } from "@/lib/server/plaid";

/**
 * POST /api/v1/auth/plaid-kyc — the legacy Plaid Link/KYC handshake.
 *
 * Superseded by the session-derived POST /api/v1/plaid/link-token for UI
 * flows, but still exposed as an MCP HTTP binding — retired only when the
 * owner confirms no external caller depends on it (bug hunt F3 follow-up).
 *
 * AUTH (bug hunt F3): the POST is GATED behind requireRegisteredOrOperator
 * — a registered creator session or the signed operator cookie — answering
 * before the body is read and before any token is minted. Identity comes
 * from the session, never the body: a caller-supplied creator_id is a
 * claim, not a credential.
 */
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

  // GATED (bug hunt F3): a registered creator session or the operator —
  // never a visitor. The gate answers before the body is parsed and before
  // any token is minted.
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
  const parsed = validatePlaidKycPayload(body);
  if (!parsed.ok) {
    const status = parsed.code === "malformed_body" ? 400 : 422;
    return donJsonError(status, parsed.code, parsed.message);
  }

  const result = await handlePlaidKyc(getStore(), parsed.value);
  if (!result.ok) {
    return donJsonError(result.status, result.code, result.message);
  }
  const created = result.value.action === "create_link_token";
  return NextResponse.json(result.value, { status: created ? 201 : 200 });
}
