import { NextRequest, NextResponse } from "next/server";
import { donJsonError } from "@/lib/server/http";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { getStore } from "@/lib/server/store";
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

  const result = await applyWithholding(getStore(), {
    creator_id: parsed.value.creator_id,
    gross_cents: parsed.value.gross_cents,
    tax_year: parsed.value.tax_year ?? new Date().getUTCFullYear(),
    tin_verified: parsed.value.tin_verified,
    w9_on_file: parsed.value.w9_on_file,
  });
  return NextResponse.json(result.value, { status: 201 });
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

  const creatorId = request.nextUrl.searchParams.get("creator_id")?.trim() ?? "";
  if (creatorId === "") {
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
  return NextResponse.json(
    await readCreatorCompliance(getStore(), creatorId, taxYear),
  );
}
