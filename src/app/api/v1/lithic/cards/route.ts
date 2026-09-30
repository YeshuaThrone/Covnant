import { NextRequest, NextResponse } from "next/server";
import { donJsonError } from "@/lib/server/http";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { getStore } from "@/lib/server/store";
import { requireOperator } from "@/lib/server/apiAccess";
import { clientIdentity } from "@/modules/don/http";
import {
  createLithicAdapter,
  isLithicConfigured,
  lithicNotConfigured,
} from "@/services/banking/lithic";
import {
  evaluatePayoutCompliance,
  getVerticalComplianceStateSource,
  resolveCreatorKycStatus,
} from "@/modules/compliance/payoutGate";
import { validateLithicCardIssuePayload } from "@/modules/banking/validation";

/**
 * POST /api/v1/lithic/cards — the Gold Note Card issuing stub (operator-only,
 * compliance-gated). Issuance itself moves no Gold Board money: card
 * AUTHORIZATIONS move money, and those land through the existing
 * /api/banking card-authorization webhook path. The SAME fail-closed payout
 * compliance gate as ACH dispatch applies first:
 *
 *   1. operator session, AND
 *   2. operator_settlement_approved true, AND
 *   3. target creator KYC verified, AND
 *   4. the vertical compliance family satisfied.
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
  const access = requireOperator(request);
  if (!access.ok) {
    return donJsonError(access.status, access.code, access.message);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return donJsonError(400, "malformed_body", "Request body must be valid JSON.");
  }
  const parsed = validateLithicCardIssuePayload(body);
  if (!parsed.ok) {
    return donJsonError(
      parsed.code === "malformed_body" ? 400 : 422,
      parsed.code,
      parsed.message,
    );
  }

  // V1 compliance gate — fail-closed, before any capability disclosure.
  const store = getStore();
  const kycStatus = await resolveCreatorKycStatus(store, parsed.value.payee_id);
  const verticalState = await getVerticalComplianceStateSource()({
    payeeId: parsed.value.payee_id,
    vertical: parsed.value.vertical,
  });
  const compliance = evaluatePayoutCompliance({
    operatorSettlementApproved: parsed.value.operator_settlement_approved,
    kycStatus,
    verticalState,
  });
  if (!compliance.ok) {
    return donJsonError(403, compliance.code, compliance.message);
  }

  // Capability check AFTER authorization.
  if (!isLithicConfigured()) {
    const notConfigured = lithicNotConfigured();
    return donJsonError(notConfigured.status, notConfigured.code, notConfigured.message);
  }

  const card = await createLithicAdapter().createVirtualCard({
    idempotencyKey: parsed.value.idempotency_key,
    memo: parsed.value.memo,
    spendLimitCents: parsed.value.spend_limit_cents,
  });
  if (!card.ok) {
    return donJsonError(card.status, card.code, card.message);
  }
  return NextResponse.json(
    { ok: true, card: { card_token: card.value.cardToken, state: card.value.state } },
    { status: 201 },
  );
}
