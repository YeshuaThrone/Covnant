// The instant GPU grid-split settlement EXECUTION (PR 49, the founder
// resource directive) — the moment PR 48's staged grid split becomes
// MONEY.
//
// PR 48's SCADA/GPU detector walk computes the compute cluster's revenue
// split across the registered grid participants (the silicon lessors —
// GPU hardware owners, the power providers — plant operators, the
// hosting facilities — colocation managers) by telemetry-scaled weights
// and STAGES the allocation in energy_compute_grid_split_applications
// with journal_id null. THIS engine completes the staged application:
//
//   1. Read the staged application of record — fail-closed when absent.
//   2. A stamped journal_id IS the posting of record: counted no-op, no
//      second pricing, no second posting.
//   3. Parse the staged split legs and re-verify the conservation
//      identity against the staged totals (legs sum === allocated total
//      === the compute revenue) BEFORE anything moves.
//   4. Post INSTANTLY: FBO cash debits the pot; every participant's
//      allocation rides the SAME fail-closed taxed cascade every payout
//      credits through (withholding off the top, the recoupment sweep).
//      The cascade credits each participant's GROSS (withheld and
//      recouped portions move within the house accounts, not out of the
//      split), so participant legs === pot, ALWAYS.
//   5. CAS-stamp the journal id onto the staged application — the
//      journal of record marks the posting complete; a replayed or
//      concurrent invocation reads the stamp and refuses.
//
// THE INVARIANT: the staged application is the row of record — it exists
// even if the posting is interrupted (the OTA instant-posting discipline:
// the reconciliation of staged applications against journals surfaces
// any gap). The walk's single-worker claim discipline guards the
// posting window; the journal stamp guards every later replay.

import type { Store } from "@/lib/server/store";
import type {
  EnergyComputeGridSplitApplicationRecord,
  EnergyGridParticipantClass,
} from "@/modules/energy/records";
import { postJournal } from "@/modules/ledger/engine";
import { fboDebit, type GlLegInput } from "@/modules/ledger/journal";
import { creditTaxedCascadePayee } from "@/lib/server/patentLitigationEscrow";

/** House failure envelope — the patent escrow's shape. */
export type GpuGridSplitSettlementFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type GpuGridSplitSettlementCredit = {
  payee_id: string;
  payee_name: string;
  participant_class: EnergyGridParticipantClass;
  gross_cents: number;
  net_cents: number;
  step: string;
};

export type GpuGridSplitSettlementSuccess = {
  ok: true;
  value: {
    /** The staged application of record (journal-stamped after posting). */
    application: EnergyComputeGridSplitApplicationRecord;
    /** True when the journal of record already existed — a replay. */
    replayed: boolean;
    /** The posted journal when this execution moved money. */
    journal_id: string | null;
    allocated_total_cents: number;
    credits: GpuGridSplitSettlementCredit[];
  };
};

/** The participant class's founder-vocabulary name (the settlement voice). */
export function gpuGridParticipantName(
  participantClass: EnergyGridParticipantClass,
  payeeId: string,
): string {
  switch (participantClass) {
    case "gpu_hardware_owner":
      return `Silicon lessor ${payeeId}`;
    case "power_plant_operator":
      return `Power provider ${payeeId}`;
    case "colocation_manager":
      return `Hosting facility ${payeeId}`;
  }
}

/**
 * The PURE conservation check — the staged split legs' allocations must
 * sum EXACTLY to the staged pot, every allocation a whole non-negative
 * cent amount, every leg a registered participant class. The staged
 * row's CHECKs pin this at rest; the engine re-verifies the parsed legs
 * before money moves (never trust a payload's own arithmetic).
 */
export function gpuGridSplitConservationHolds(
  legs: { payee_id: string; participant_class: string; allocated_cents: number }[],
  allocatedTotalCents: number,
): boolean {
  if (!Number.isInteger(allocatedTotalCents) || allocatedTotalCents < 0) {
    return false;
  }
  if (legs.length === 0) {
    return false;
  }
  let total = 0;
  for (const leg of legs) {
    if (
      leg.payee_id.trim() === "" ||
      !Number.isInteger(leg.allocated_cents) ||
      leg.allocated_cents < 0
    ) {
      return false;
    }
    total += leg.allocated_cents;
  }
  return total === allocatedTotalCents;
}

/**
 * Executes ONE staged GPU grid-split application — the instant cascade
 * between the silicon lessor, power provider, and hosting facility
 * ledgers on compute block rental. Idempotent BY STAGED APPLICATION: a
 * replayed execution reads the journal stamp and refuses with the same
 * counted no-op — never a second posting.
 */
export async function executeGpuGridSplitSettlement(
  store: Store,
  sourceEventId: string,
  now: Date = new Date(),
): Promise<GpuGridSplitSettlementSuccess | GpuGridSplitSettlementFailure> {
  if (sourceEventId.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_settlement_identity",
      message: "An instant GPU grid-split settlement names its staged application of record.",
    };
  }

  // The staged application of record — PR 48's detector staged it with
  // journal_id null. Fail-closed when absent: nothing posts from a
  // staging that does not exist.
  const application = await store.getEnergyComputeGridSplitApplication(sourceEventId);
  if (application === undefined) {
    return {
      ok: false,
      status: 404,
      code: "grid_split_application_not_found",
      message: "No staged GPU grid-split application matches that source event.",
    };
  }

  // The journal of record — a stamped journal_id IS the completed
  // posting: counted no-op, never a second split.
  if (application.journal_id !== null) {
    return {
      ok: true,
      value: {
        application,
        replayed: true,
        journal_id: application.journal_id,
        allocated_total_cents: application.allocated_total_cents,
        credits: [],
      },
    };
  }

  // The staged legs of record — re-verify the conservation identity
  // BEFORE anything moves (the payload's own arithmetic is never
  // trusted).
  let legs: {
    payee_id: string;
    participant_class: EnergyGridParticipantClass;
    allocated_cents: number;
  }[];
  try {
    const parsed: unknown = JSON.parse(application.split_legs);
    if (!Array.isArray(parsed)) {
      throw new Error("split_legs is not an array");
    }
    legs = parsed as typeof legs;
  } catch {
    return {
      ok: false,
      status: 500,
      code: "grid_split_legs_unparsable",
      message: `Staged split legs for ${sourceEventId} do not parse — posting refused.`,
    };
  }
  if (
    !gpuGridSplitConservationHolds(legs, application.allocated_total_cents) ||
    application.allocated_total_cents !== application.compute_revenue_cents
  ) {
    return {
      ok: false,
      status: 500,
      code: "grid_split_conservation_violation",
      message: `Staged split legs for ${sourceEventId} do not conserve the staged pot — posting refused.`,
    };
  }

  // The instant posting: FBO cash debits the pot; every participant's
  // allocation rides the taxed cascade (withholding off the top, the
  // recoupment sweep — their legs append to glLegs). The cascade credits
  // each participant's GROSS, so participant legs === pot, ALWAYS.
  const glLegs: GlLegInput[] = [fboDebit(application.allocated_total_cents)];
  const credits: GpuGridSplitSettlementCredit[] = [];
  for (const leg of legs) {
    if (leg.allocated_cents === 0) {
      continue;
    }
    const payeeName = gpuGridParticipantName(leg.participant_class, leg.payee_id);
    const netCents = await creditTaxedCascadePayee(
      store,
      leg.payee_id,
      payeeName,
      leg.allocated_cents,
      now,
      glLegs,
      [],
    );
    credits.push({
      payee_id: leg.payee_id,
      payee_name: payeeName,
      participant_class: leg.participant_class,
      gross_cents: leg.allocated_cents,
      net_cents: netCents,
      step: "participant_net",
    });
  }

  // The zero-balance tripwire: participant legs + dust === the pot,
  // ALWAYS (the Don invariant in integer cents — the cascade's withheld
  // and recouped portions move within the house accounts, inside the
  // legs).
  const totalCredited = credits.reduce((sum, credit) => sum + credit.gross_cents, 0);
  if (totalCredited !== application.allocated_total_cents) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "Participant allocations !== staged pot — instant GPU cascade posting refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "gpu_cascade_settlement_post",
    ref_type: "ledger_transaction",
    ref_id: application.id,
    legs: glLegs,
  });
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }

  // The journal stamp — the CAS marks the staged application's posting
  // complete (journal_id null → stamped). A concurrent invocation that
  // lost the stamp race reads undefined; the walk's single-worker claim
  // discipline and the reconciliation of staged applications against
  // journals surface any gap (the OTA instant-posting stance).
  const stamped = await store.setEnergyComputeGridSplitJournal(
    application.source_event_id,
    posted.journal.id,
  );
  if (stamped === undefined) {
    return {
      ok: false,
      status: 409,
      code: "grid_split_already_posted",
      message: `Staged application ${application.source_event_id} is already journal-stamped — a concurrent posting won.`,
    };
  }

  return {
    ok: true,
    value: {
      application: stamped,
      replayed: false,
      journal_id: posted.journal.id,
      allocated_total_cents: application.allocated_total_cents,
      credits,
    },
  };
}
