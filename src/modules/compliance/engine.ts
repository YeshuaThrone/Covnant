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
import type { TaxEscrowRecord } from "@/modules/don/records";
import { computeWithholding, type TinStatus } from "./withholding";

export type ApplyWithholdingInput = {
  creator_id: string;
  gross_cents: number;
  tax_year: number;
  tin_verified?: boolean;
  w9_on_file?: boolean;
  /**
   * The split run whose settlement this withholding belongs to (migration
   * 0059) — stamped on the escrow row so the reversal unwind (audit #7)
   * and failed-saga compensation (audit #6) can attribute it. Omitted by
   * callers without a run; the row is stored with null.
   */
  split_run_id?: string;
  /**
   * The withholding idempotency key (migration 0060, audit note_c5ksDgVw
   * #12): a replayed apply with the same key returns the STORED escrow
   * effect — one escrow row, one YTD accumulation — instead of booking a
   * second withholding. Mirrors the split-run saga's key pattern
   * (migration 0009 + udrSplits' probe/re-read). Omitted by callers
   * without a key (the vertical settlement engines); those rows stay
   * null-keyed and are never treated as replays.
   */
  idempotency_key?: string;
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

export type ApplyWithholdingEffect = {
  creator_id: string;
  tax_year: number;
  tin_verified: boolean;
  w9_on_file: boolean;
  gross_cents: number;
  withheld_cents: number;
  net_cents: number;
  backup_withholding_applied: boolean;
  ytd_gross_cents: number;
  ytd_withheld_cents: number;
  requires_1099: boolean;
  crossed_1099_threshold: boolean;
  escrow: TaxEscrowRecord;
  /** Present only on a replay (migration 0060): this call returned a stored effect and booked nothing. */
  replayed?: true;
};

/**
 * Classifies a store insert failure as THE idempotency-key collision
 * (migration 0060's tax_escrow_idempotency_key_unique index): SQLite says
 * "UNIQUE constraint failed: tax_escrow_ledger.idempotency_key", Postgres
 * reports SQLSTATE 23505, and the in-memory store mirrors that vocabulary.
 * Anything else is a genuine failure and rethrows.
 */
function isIdempotencyKeyConflict(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return lowered.includes("unique") && lowered.includes("idempotency_key");
}

/**
 * Reconstructs the ORIGINAL apply's result from its stored escrow row —
 * the replay contract (migration 0060, audit #12): same idempotency key,
 * same ONE effect. The row carries the effect's own amounts and flags; the
 * YTD totals re-read fresh (they include this escrow's contribution exactly
 * once — a replay accumulates nothing). `replayed` tells auditors this call
 * returned a stored effect instead of booking one.
 */
async function replayedWithholdingResult(
  store: Store,
  escrow: TaxEscrowRecord,
): Promise<{ ok: true; value: ApplyWithholdingEffect }> {
  const ytd = await store.getCreatorYtd(escrow.creator_id, escrow.tax_year);
  return {
    ok: true as const,
    value: {
      creator_id: escrow.creator_id,
      tax_year: escrow.tax_year,
      tin_verified: escrow.tin_verified === 1,
      w9_on_file: escrow.w9_on_file === 1,
      gross_cents: escrow.gross_cents,
      withheld_cents: escrow.withheld_cents,
      net_cents: escrow.net_cents,
      backup_withholding_applied: escrow.withheld_cents > 0,
      ytd_gross_cents: ytd?.gross_cents ?? escrow.gross_cents,
      ytd_withheld_cents: ytd?.withheld_cents ?? escrow.withheld_cents,
      requires_1099: escrow.requires_1099 === 1,
      crossed_1099_threshold: escrow.crossed_1099_threshold === 1,
      escrow,
      replayed: true,
    },
  };
}

export async function applyWithholding(
  store: Store,
  input: ApplyWithholdingInput,
  now: Date = new Date(),
): Promise<{ ok: true; value: ApplyWithholdingEffect }> {
  const idempotencyKey = input.idempotency_key ?? null;

  // Replay probe FIRST (audit #12): a keyed call whose escrow already
  // exists returns the stored effect and books NOTHING — no profile
  // upsert, no YTD delta, no second row. Mirrors the split-run saga's
  // probe-first pattern.
  if (idempotencyKey !== null) {
    const replay = await store.getTaxEscrowByIdempotencyKey(idempotencyKey);
    if (replay !== undefined) {
      return replayedWithholdingResult(store, replay);
    }
  }

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

  // THE MONEY-SAFE ORDER, now with an arbiter (migration 0060, audit #12):
  // the keyed escrow insert runs BEFORE the YTD accumulate. The unique
  // index picks a winner when two applies race one key; the loser re-reads
  // the winner's row and returns it — so the accumulate below happens only
  // on the winner's path and one key produces exactly one escrow row and
  // one accumulation. (The old increment-then-insert order could flip a
  // threshold with no escrow row when the insert failed; insert-first
  // leaves the recoverable direction — an escrow row whose YTD delta can
  // be re-posted — never the silent drift.) Unkeyed calls behave exactly
  // as before: Postgres unique indexes treat nulls as distinct, so every
  // unkeyed insert wins.
  let escrow: TaxEscrowRecord;
  try {
    escrow = await store.insertTaxEscrow({
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
      split_run_id: input.split_run_id ?? null,
      idempotency_key: idempotencyKey,
    });
  } catch (insertError) {
    if (idempotencyKey !== null && isIdempotencyKeyConflict(insertError)) {
      const winner = await store.getTaxEscrowByIdempotencyKey(idempotencyKey);
      if (winner !== undefined) {
        return replayedWithholdingResult(store, winner);
      }
      // Classified as the key collision but the winner is unreadable —
      // surface the original error rather than guess at the stored state.
    }
    throw insertError;
  }

  // The read above feeds the per-payment math (backup-withholding rate and
  // the escrow row's threshold flags at read time); the write must NOT be
  // the absolute totals it produced — that read-modify-write lost concurrent
  // settlements' contributions (audit note_c5ksDgVw). The atomic accumulate
  // keeps the stored YTD exact even when settlements race; the row's
  // requires_1099 surface (readCreatorCompliance) re-derives from it.
  await store.incrementCreatorYtd({
    creator_id: input.creator_id,
    tax_year: input.tax_year,
    gross_delta_cents: computation.gross_cents,
    withheld_delta_cents: computation.withheld_cents,
    updated_at: createdAt,
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
