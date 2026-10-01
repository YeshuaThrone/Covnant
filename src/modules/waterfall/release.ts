// The film waterfall release orchestration (PR 8) — composes the pure
// sequential router with the escrow release (PR 9's releaseFilmEscrow) and
// the routing-decision record (migration 0016).
//
// One released escrow receipt, fail-closed at every step:
//
//   1. Read the escrow receipt — 404 when absent. The receipt's amount and
//      per-film payee are the routing inputs; the release re-validates kind
//      and status itself.
//   2. Load the film's registered definition — 404 when none is registered.
//      A film without a waterfall does not release: nothing defaults.
//   3. Load the film's cumulative gross receipts (the SAME basis the release
//      computes the FDG trigger on) and the cumulative per-leg paid state
//      from the film's APPLIED distribution rows, then route the receipt
//      through the pure cascade.
//   4. Insert the routing-decision record status 'routed' — insert-as-lock,
//      the payout_reversals precedent. A prior 'routed' record for the same
//      receipt (a crashed attempt between insert and release) is REUSED, not
//      duplicated — the unique escrow_ledger_id is the lock. A prior
//      'applied' record means the receipt already released: refuse with the
//      same 409 the release's CAS produces.
//   5. Release through releaseFilmEscrow — its own gates hold (cross-
//      reference verification, FDG payout compliance, CAS settle before
//      money moves, tier-5 pool split, dust sweep). The router's tier
//      allocations and the definition's FDG terms are the verified inputs.
//   6. Success → flip the record to 'applied' (the cumulative-paid fold only
//      counts applied rows). Refusal → delete the record so the unique lock
//      frees for the next attempt. The money moved only on success.
//
// Integer cents throughout; corrupt cumulative state (paid exceeding an
// obligation — impossible while definitions lock once distributed) surfaces
// as a 500, never a clamp.

import {
  filmIdFromEscrowPayeeId,
  releaseFilmEscrow,
} from "@/lib/server/filmEscrow";
import type {
  CrossReferenceVerification,
  FilmEscrowReleaseSuccess,
} from "@/lib/server/filmEscrow";
import type { Store } from "@/lib/server/store";
import {
  cumulativePaidFromDistributions,
  routeWaterfallTransaction,
} from "@/modules/waterfall/engine";
import type { WaterfallRouting } from "@/modules/waterfall/engine";

export interface WaterfallReleaseInput {
  /** The locked escrow receipt to route and release (the ledger row id). */
  escrow_ledger_id: string;
  /** The cross-reference verification the release requires. */
  verification: CrossReferenceVerification;
  /** The clearance gate's first condition — fail-closed on anything but true. */
  operator_settlement_approved: boolean;
}

export type WaterfallReleaseSuccess = {
  ok: true;
  value: {
    /** The pure routing the release applied. */
    routing: WaterfallRouting;
    /** The routing-decision record, now status 'applied'. */
    distribution_id: string;
    /** The release outcome (escrow credit, FDG credits, tier GL, dust). */
    release: FilmEscrowReleaseSuccess["value"];
  };
};

export type WaterfallReleaseFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export async function releaseThroughWaterfall(
  store: Store,
  input: WaterfallReleaseInput,
  now: Date = new Date(),
): Promise<WaterfallReleaseSuccess | WaterfallReleaseFailure> {
  const receipt = await store.getLedgerTransaction(input.escrow_ledger_id);
  if (receipt === undefined) {
    return {
      ok: false,
      status: 404,
      code: "escrow_receipt_not_found",
      message: "No ledger transaction matches that id.",
    };
  }
  const filmId = filmIdFromEscrowPayeeId(receipt.payee_id);
  if (filmId === undefined) {
    return {
      ok: false,
      status: 500,
      code: "escrow_payee_corrupted",
      message: `Escrow receipt ${receipt.id} carries payee "${receipt.payee_id}" — not a film escrow payee.`,
    };
  }

  const definitionRecord = await store.getFilmWaterfallDefinition(filmId);
  if (definitionRecord === undefined) {
    return {
      ok: false,
      status: 404,
      code: "waterfall_not_registered",
      message: `Film "${filmId}" has no registered waterfall — register the deal before releasing escrow.`,
    };
  }
  const definition = definitionRecord.definition;

  // A prior applied decision for this receipt: the money already moved.
  const existing = await store.getFilmWaterfallDistributionByEscrow(receipt.id);
  if (existing !== undefined && existing.status === "applied") {
    return {
      ok: false,
      status: 409,
      code: "escrow_already_released",
      message: `Escrow receipt ${receipt.id} already routed through the waterfall (distribution ${existing.id}).`,
    };
  }

  // The gross basis — the same sumFilmGrossReceiptCents call the release
  // makes for the FDG trigger, so the router's FDG floors and the release's
  // are computed on one number.
  const cumulativeGrossCents = await store.sumFilmGrossReceiptCents(filmId);
  const applied = await store.listFilmWaterfallDistributions(filmId);
  const paid = cumulativePaidFromDistributions(applied);

  let routing: WaterfallRouting;
  try {
    routing = routeWaterfallTransaction(
      definition,
      receipt.amount_cents,
      cumulativeGrossCents,
      paid,
    );
  } catch (error) {
    // Corrupt cumulative state refuses closed — it never silently clamps.
    // The release has not run; nothing to roll back.
    return {
      ok: false,
      status: 500,
      code: "waterfall_state_corrupt",
      message:
        error instanceof RangeError
          ? error.message
          : "Waterfall routing failed on corrupt cumulative state.",
    };
  }

  // Insert-as-lock. A crashed attempt's 'routed' record was never executed —
  // replace it so the applied record always mirrors the decision actually
  // applied. ('applied' records returned 409 above.)
  if (existing !== undefined) {
    await store.deleteFilmWaterfallDistribution(existing.id);
  }
  const distribution = await store.insertFilmWaterfallDistribution({
    film_id: filmId,
    escrow_ledger_id: receipt.id,
    status: "routed",
    fdg_bypass_cents: routing.fdg_bypass_cents,
    legs: routing.legs,
    tier_allocations: routing.tier_allocations,
    unpaid_total_cents: routing.unpaid_total_cents,
    created_at: now.toISOString(),
  });

  const release = await releaseFilmEscrow(
    store,
    {
      escrow_ledger_id: receipt.id,
      verification: input.verification,
      fdg: definition.fdg,
      tier_allocations: routing.tier_allocations,
      operator_settlement_approved: input.operator_settlement_approved,
    },
    now,
  );
  if (!release.ok) {
    // The release refused — free the unique lock for the retry.
    await store.deleteFilmWaterfallDistribution(distribution.id);
    return release;
  }

  await store.updateFilmWaterfallDistributionStatus(distribution.id, "applied");
  return {
    ok: true,
    value: {
      routing,
      distribution_id: distribution.id,
      release: release.value,
    },
  };
}
