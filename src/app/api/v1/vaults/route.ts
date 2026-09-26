/**
 * The sovereign-vault surface (Don Engine API).
 *
 * GATED (hardening gen 12 — this surface was rate-limit-only before):
 *   - GET  — holder-scoped. A creator session reads ITS OWN vault only; the
 *     payee_id query param is a claim to verify, never trusted (a mismatch
 *     is 403 holder_mismatch before any read runs). Listing EVERY vault (no
 *     payee_id) is the operator's view and requires the signed admin cookie.
 *   - POST — operator-only: releasing a vault's pending balance is payout
 *     initiation, so only the admin-gated console may call it.
 *
 * Failures carry no data: 503 admin_not_configured (no secret configured),
 * 401 (absent/invalid operator cookie, or no creator session), 403
 * holder_mismatch / not_registered, then the envelope's own 400/404/422.
 */

import { NextRequest, NextResponse } from "next/server";
import { donJsonError } from "@/lib/server/http";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { getStore } from "@/lib/server/store";
import { requireHolderAccess, requireOperator } from "@/lib/server/apiAccess";
import { clientIdentity } from "@/modules/don/http";
import { validateVaultReleasePayload } from "@/lib/don/validation";
import { releaseVaultPending } from "@/modules/vaults/engine";

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

  const access = await requireHolderAccess(
    request,
    request.nextUrl.searchParams.get("payee_id"),
  );
  if (!access.ok) {
    return donJsonError(access.status, access.code, access.message);
  }

  const store = getStore();
  // A creator session is bound to its OWN vault id; only an operator may
  // leave the id empty (the list-every-vault view).
  const payeeId = access.holderId ?? "";
  if (payeeId !== "") {
    const vault = await store.getVault(payeeId);
    if (vault === undefined) {
      return donJsonError(
        404,
        "vault_not_found",
        "No sovereign vault exists for that payee.",
      );
    }
    return NextResponse.json(vault);
  }
  return NextResponse.json({ vaults: await store.listVaults() });
}

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
    return donJsonError(
      400,
      "malformed_body",
      "Request body must be valid JSON.",
    );
  }
  const parsed = validateVaultReleasePayload(body);
  if (!parsed.ok) {
    const status = parsed.code === "malformed_body" ? 400 : 422;
    return donJsonError(status, parsed.code, parsed.message);
  }

  const result = await releaseVaultPending(
    getStore(),
    parsed.value.payee_id,
    parsed.value.amount_cents,
  );
  if (!result.ok) {
    return donJsonError(result.status, result.code, result.message);
  }
  return NextResponse.json(result);
}
