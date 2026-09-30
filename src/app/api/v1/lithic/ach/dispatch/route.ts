import { NextRequest, NextResponse } from "next/server";
import { donJsonError } from "@/lib/server/http";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { getStore } from "@/lib/server/store";
import { requireOperator } from "@/lib/server/apiAccess";
import { clientIdentity } from "@/modules/don/http";
import { payoutFromVault } from "@/modules/vaults/engine";
import { LithicAdapter } from "@/services/baas/LithicAdapter";
import { isLithicConfigured, lithicNotConfigured } from "@/services/banking/lithic";
import {
  evaluatePayoutCompliance,
  getVerticalComplianceStateSource,
  resolveCreatorKycStatus,
} from "@/modules/compliance/payoutGate";
import { validateLithicAchDispatchPayload } from "@/modules/banking/validation";

/**
 * POST /api/v1/lithic/ach/dispatch — the operator-only Lithic ACH payout.
 *
 * SETTLEMENT-TRIGGERED, NEVER recon-triggered (docs/banking-rails.md): recon
 * completion lands audited events in the Gold Board ledger; this endpoint is
 * invoked only from the clearance-gated settlement path, by an operator, with
 * the fail-closed compliance gate in front of any money movement:
 *
 *   1. operator session (requireOperator), AND
 *   2. operator_settlement_approved true, AND
 *   3. target creator KYC verified (Plaid-backed ledger), AND
 *   4. the vertical compliance family satisfied.
 *
 * The dispatch posts through payoutFromVault — the same atomic
 * hold → ledger → dispatch → journal sequence as every other payout rail —
 * with the Lithic adapter injected as the dispatcher. Rail: ACH (CCD).
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
  const parsed = validateLithicAchDispatchPayload(body);
  if (!parsed.ok) {
    return donJsonError(
      parsed.code === "malformed_body" ? 400 : 422,
      parsed.code,
      parsed.message,
    );
  }

  // V1 compliance gate — fail-closed, before any capability check or store
  // mutation. A refused caller never learns whether the rail is configured.
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

  // Capability check AFTER authorization — not-configured is a 503, never a
  // fake success.
  if (!isLithicConfigured()) {
    const notConfigured = lithicNotConfigured();
    return donJsonError(notConfigured.status, notConfigured.code, notConfigured.message);
  }

  const lithicBaas = new LithicAdapter({ store });
  const result = await payoutFromVault(
    store,
    {
      payee_id: parsed.value.payee_id,
      amount_cents: parsed.value.amount_cents,
      rail: "ach",
    },
    new Date(),
    (req) =>
      lithicBaas.createAchTransfer({
        ...req,
        destination_bank_token: parsed.value.destination,
        idempotency_key: parsed.value.idempotency_key,
      }),
  );
  if (!result.ok) {
    return donJsonError(result.status, result.code, result.message);
  }
  return NextResponse.json(
    { ok: true, transfer: result.transfer, vault: result.vault },
    { status: 201 },
  );
}
