// Compliance engine — Cursor's Phase 2 re-drop (applyWithholding,
// resolveTinStatus, readCreatorCompliance).
//
// The pre-wiring stand-in (structural ComplianceStore over foundation record
// types) is superseded by the real Store, exactly as the stand-in's comment
// promised. Async adaptation only (Store PR contract): every store call is
// awaited and store-calling functions return Promises. Resolution order,
// flag semantics, and the returned snapshot shape are untouched.

import type { Store } from "@/lib/server/store";
import { FORM_1099_THRESHOLD_CENTS } from "@/modules/don/constants";
import { computeWithholding, type TinStatus } from "./withholding";

export type ApplyWithholdingInput = {
  creator_id: string;
  gross_cents: number;
  tax_year: number;
  tin_verified?: boolean;
  w9_on_file?: boolean;
};

export function resolveTinStatus(
  stored: TinStatus | undefined,
  incoming: { tin_verified?: boolean; w9_on_file?: boolean },
): TinStatus {
  return {
    tin_verified: incoming.tin_verified ?? stored?.tin_verified ?? false,
    w9_on_file: incoming.w9_on_file ?? stored?.w9_on_file ?? false,
  };
}

export async function applyWithholding(
  store: Store,
  input: ApplyWithholdingInput,
  now: Date = new Date(),
) {
  const createdAt = now.toISOString();
  const storedProfile = await store.getCreatorTaxProfile(input.creator_id);
  const status = resolveTinStatus(
    storedProfile
      ? {
          tin_verified: storedProfile.tin_verified === 1,
          w9_on_file: storedProfile.w9_on_file === 1,
        }
      : undefined,
    input,
  );
  await store.upsertCreatorTaxProfile({
    creator_id: input.creator_id,
    tin_verified: status.tin_verified ? 1 : 0,
    w9_on_file: status.w9_on_file ? 1 : 0,
    updated_at: createdAt,
  });

  const ytd = await store.getCreatorYtd(input.creator_id, input.tax_year);
  const computation = computeWithholding(
    input.gross_cents,
    ytd?.gross_cents ?? 0,
    ytd?.withheld_cents ?? 0,
    status,
  );
  await store.upsertCreatorYtd({
    creator_id: input.creator_id,
    tax_year: input.tax_year,
    gross_cents: computation.ytd_gross_cents,
    withheld_cents: computation.ytd_withheld_cents,
    updated_at: createdAt,
  });
  const escrow = await store.insertTaxEscrow({
    creator_id: input.creator_id,
    tax_year: input.tax_year,
    gross_cents: computation.gross_cents,
    withheld_cents: computation.withheld_cents,
    net_cents: computation.net_cents,
    tin_verified: status.tin_verified ? 1 : 0,
    w9_on_file: status.w9_on_file ? 1 : 0,
    requires_1099: computation.requires_1099 ? 1 : 0,
    crossed_1099_threshold: computation.crossed_1099_threshold ? 1 : 0,
    created_at: createdAt,
  });
  return {
    ok: true as const,
    value: {
      creator_id: input.creator_id,
      tax_year: input.tax_year,
      tin_verified: status.tin_verified,
      w9_on_file: status.w9_on_file,
      ...computation,
      escrow,
    },
  };
}

export async function readCreatorCompliance(
  store: Store,
  creatorId: string,
  taxYear: number,
) {
  const profile = await store.getCreatorTaxProfile(creatorId);
  const ytd = await store.getCreatorYtd(creatorId, taxYear);
  const status: TinStatus = {
    tin_verified: profile?.tin_verified === 1,
    w9_on_file: profile?.w9_on_file === 1,
  };
  const ytdGross = ytd?.gross_cents ?? 0;
  return {
    creator_id: creatorId,
    tax_year: taxYear,
    tin_verified: status.tin_verified,
    w9_on_file: status.w9_on_file,
    ytd_gross_cents: ytdGross,
    ytd_withheld_cents: ytd?.withheld_cents ?? 0,
    requires_1099: ytdGross >= FORM_1099_THRESHOLD_CENTS,
    escrow: await store.listTaxEscrowByCreator(creatorId, taxYear),
  };
}
