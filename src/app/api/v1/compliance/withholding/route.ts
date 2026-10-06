/**
 * The tax-withholding surface (Don Engine API).
 *
 * GATED (tax audit fix — this surface was rate-limit-only before):
 *   - POST — operator-only: applying withholding upserts the creator tax
 *     profile of record and books tax escrow, so only the signed admin
 *     cookie may call it (mirrors splits/calculate and splits/reverse).
 *     The body's tin_verified/w9_on_file flags are NOT honored here — a
 *     self-attested flag flipped the profile of record and disabled the
 *     24% backup withholding on every later creator-role settlement.
 *     Verification moves through the operator's MCP withholding_apply tool
 *     and the fail-closed verification writer (verifyVtuberTaxWithholding),
 *     never through an API body.
 *   - GET — holder-scoped: the snapshot carries YTD gross, withheld, TIN
 *     status, the 1099 flag, and escrow history. The creator_id query param
 *     is a claim to verify, never trusted; the operator reads any creator.
 *
 * Failures carry no data: 503 admin_not_configured (no secret configured),
 * 401 (absent/invalid operator cookie, or no creator session), 403
 * holder_mismatch / not_registered, then the envelope's own 400/422/500.
 */

import { NextRequest, NextResponse } from "next/server";
import { donJsonError } from "@/lib/server/http";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { getStore } from "@/lib/server/store";
import { requireHolderAccess, requireOperator } from "@/lib/server/apiAccess";
import { clientIdentity } from "@/modules/don/http";
import { validateWithholdingPayload } from "@/lib/don/validation";
import { applyWithholding, readCreatorCompliance } from "@/modules/compliance/engine";

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

  // GATED: the signed admin cookie is verified before any body is parsed.
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
  const parsed = validateWithholdingPayload(body);
  if (!parsed.ok) {
    const status = parsed.code === "malformed_body" ? 400 : 422;
    return donJsonError(status, parsed.code, parsed.message);
  }

  // The profile of record is the only TIN/W-9 source: applyWithholding's
  // resolveTinStatus falls back to the stored profile, so an unverified
  // creator stays withheld at 24% until the operator flow verifies them.
  try {
    const result = await applyWithholding(getStore(), {
      creator_id: parsed.value.creator_id,
      gross_cents: parsed.value.gross_cents,
      tax_year: parsed.value.tax_year ?? new Date().getUTCFullYear(),
      idempotency_key: parsed.value.idempotency_key,
    });
    return NextResponse.json(result.value, { status: 201 });
  } catch (error) {
    console.error("compliance.withholding apply failed", error);
    return donJsonError(
      500,
      "withholding_apply_failed",
      "Withholding application failed unexpectedly.",
    );
  }
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

  // GATED: the gate verdict runs before any read; a holder naming another
  // creator's id is refused holder_mismatch.
  const access = await requireHolderAccess(
    request,
    request.nextUrl.searchParams.get("creator_id"),
  );
  if (!access.ok) {
    return donJsonError(access.status, access.code, access.message);
  }

  // A creator session is bound to its OWN creator id (derived from the
  // verified session); only an operator supplies an arbitrary one, and an
  // operator omitting it has no read to make.
  const creatorId = access.holderId;
  if (creatorId === null || creatorId === "") {
    return donJsonError(
      422,
      "missing_creator_id",
      "creator_id is required.",
    );
  }

  const yearRaw = request.nextUrl.searchParams.get("tax_year");
  const taxYear =
    yearRaw === null || yearRaw === ""
      ? new Date().getUTCFullYear()
      : Number(yearRaw);
  if (!Number.isSafeInteger(taxYear) || taxYear < 2000 || taxYear > 2100) {
    return donJsonError(
      422,
      "invalid_tax_year",
      "tax_year must be a four-digit year.",
    );
  }

  try {
    return NextResponse.json(
      await readCreatorCompliance(getStore(), creatorId, taxYear),
    );
  } catch (error) {
    console.error("compliance.withholding read failed", error);
    return donJsonError(
      500,
      "withholding_read_failed",
      "Compliance read failed unexpectedly.",
    );
  }
}
