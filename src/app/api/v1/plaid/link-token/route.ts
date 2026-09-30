import { NextRequest, NextResponse } from "next/server";
import { donJsonError } from "@/lib/server/http";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { resolveSessionCreator } from "@/lib/server/sessionCreator";
import { clientIdentity } from "@/modules/don/http";
import { createPlaidAdapter, isPlaidConfigured, plaidNotConfigured } from "@/services/banking/plaid";

/**
 * POST /api/v1/plaid/link-token — the creator session-gated Plaid Link
 * handshake (creators connect their OWN banks — never an operator's action).
 * The session creator's payee id is Plaid's client_user_id; the identity
 * never returns more than the token, per the sessionCreator disclosure rule.
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
  const session = await resolveSessionCreator();
  if (session.kind === "anonymous") {
    return donJsonError(401, "no_session", "Sign in to connect a bank account.");
  }
  if (session.kind === "unregistered") {
    return donJsonError(
      403,
      "not_registered",
      "This session is not enrolled as a rights holder.",
    );
  }

  // Capability check AFTER authorization — not-configured is a 503, never a
  // fake token.
  if (!isPlaidConfigured()) {
    const notConfigured = plaidNotConfigured();
    return donJsonError(notConfigured.status, notConfigured.code, notConfigured.message);
  }

  const link = await createPlaidAdapter().createLinkToken({
    userId: session.creator.payee_id,
    userName: session.creator.stage_name,
  });
  if (!link.ok) {
    return donJsonError(link.status, link.code, link.message);
  }
  return NextResponse.json(
    { ok: true, link_token: link.value.linkToken, expiration: link.value.expiration },
    { status: 201 },
  );
}
