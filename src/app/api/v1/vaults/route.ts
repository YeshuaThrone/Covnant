import { NextRequest, NextResponse } from "next/server";
import { donJsonError } from "@/lib/server/http";
import { checkRateLimit, DON_API_RATE_LIMIT } from "@/lib/server/rateLimit";
import { getStore } from "@/lib/server/store";
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

  const store = getStore();
  const payeeId = request.nextUrl.searchParams.get("payee_id")?.trim() ?? "";
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
