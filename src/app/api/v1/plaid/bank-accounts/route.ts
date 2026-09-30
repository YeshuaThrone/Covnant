import { NextRequest, NextResponse } from "next/server";
import { donJsonError } from "@/lib/server/http";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { resolveSessionCreator } from "@/lib/server/sessionCreator";
import { clientIdentity } from "@/modules/don/http";
import { createPlaidAdapter, isPlaidConfigured, plaidNotConfigured } from "@/services/banking/plaid";
import { validatePlaidBankAccountPayload } from "@/modules/banking/validation";

/**
 * POST /api/v1/plaid/bank-accounts — verification status for the creator's
 * own connected accounts. Exchanges the creator's own Link public_token and
 * reads /auth/get; the response carries Plaid's verification status and the
 * last-4 mask ONLY — full account numbers never leave the adapter.
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
    return donJsonError(401, "no_session", "Sign in to verify a bank account.");
  }
  if (session.kind === "unregistered") {
    return donJsonError(
      403,
      "not_registered",
      "This session is not enrolled as a rights holder.",
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return donJsonError(400, "malformed_body", "Request body must be valid JSON.");
  }
  const parsed = validatePlaidBankAccountPayload(body);
  if (!parsed.ok) {
    return donJsonError(
      parsed.code === "malformed_body" ? 400 : 422,
      parsed.code,
      parsed.message,
    );
  }

  // Capability check AFTER authorization.
  if (!isPlaidConfigured()) {
    const notConfigured = plaidNotConfigured();
    return donJsonError(notConfigured.status, notConfigured.code, notConfigured.message);
  }

  const verification = await createPlaidAdapter().getBankAccountVerification({
    publicToken: parsed.value.public_token,
  });
  if (!verification.ok) {
    return donJsonError(verification.status, verification.code, verification.message);
  }
  return NextResponse.json({
    ok: true,
    accounts: verification.value.accounts.map((account) => ({
      account_id: account.accountId,
      name: account.name,
      official_name: account.officialName,
      verification_status: account.verificationStatus,
      mask: account.mask,
    })),
  });
}
