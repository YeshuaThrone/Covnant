/**
 * CVT recon worker — the energy lane's math and identity space (PR 48,
 * the founder resource directive). Pure functions only — no store, no
 * I/O; the queue module owns every side effect, the same discipline as
 * hardware.ts.
 *
 * House rules, restated as the module's contract:
 * - EXACT INTEGER CENTS — every money leg is an integer number of
 *   cents; fractional results floor (never round up), and splits
 *   conserve: the legs sum to their pot with the dust riding the
 *   largest basis (the hardware waterfall's discipline).
 * - THE FOUNDER'S IDENTITY, PINNED — gross energy sales + gross mineral
 *   sales − transportation and pipeline deductions − grid transmission
 *   fees − processing and refining base fees = the Net Realized
 *   Resource Pool, keyed on the parcel_id / well_meter_id /
 *   gpu_cluster_hash columns.
 * - FAIL-CLOSED — a walk the lane cannot fully price records its honest
 *   outcome (a negative net is a HELD verdict, visible, never dropped,
 *   never posted) and skips without a policy of record — never a rate
 *   guess (the hardware precedent).
 * - STATUTORY INTEREST IS THE DAY-COUNT EXACT FORMULA —
 *   floor(base × lateDays × rateBps / 3,650,000) — the same integer
 *   division the 0052 CHECK enforces at the database.
 */

/** A royalty tier band — the revenue-window ladder. `up_to` is the
 * band's exclusive upper bound on the cumulative royalty basis, or null
 * for the open top band (only the last band may be open). */
export type EnergyRoyaltyTierBand = {
  readonly up_to: number | null;
  readonly royalty_bps: number;
};

/** True when the value is the house period shape (YYYY-MM). */
export function isEnergyPeriod(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

/** Bps share of an integer-cent amount, floored — never rounds up. */
export function energyBpsShareCents(amountCents: number, bps: number): number {
  return Math.floor((amountCents * bps) / 10_000);
}

// ---------------------------------------------------------------------------
// THE NET RESOURCE REALIZATION — the founder's exact identity.
// ---------------------------------------------------------------------------

export function netResourceRealizationCents(input: {
  grossEnergySalesCents: number;
  grossMineralSalesCents: number;
  transportationPipelineDeductionsCents: number;
  gridTransmissionFeesCents: number;
  processingRefiningBaseFeesCents: number;
}): { netRealizedResourcePoolCents: number } {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`energy_realization_invalid_leg:${name}:${value}`);
    }
  }
  return {
    netRealizedResourcePoolCents:
      input.grossEnergySalesCents +
      input.grossMineralSalesCents -
      input.transportationPipelineDeductionsCents -
      input.gridTransmissionFeesCents -
      input.processingRefiningBaseFeesCents,
  };
}

// ---------------------------------------------------------------------------
// THE TIERED ROYALTY WALK — the marginal band ladder over the parcel's /
// cluster's cumulative royalty basis (the hardware SEP walk's shape in
// revenue space). A single open band prices the flat percentage (the
// founder's 12.5% ORRI and 20% GPU yield examples).
// ---------------------------------------------------------------------------

export function energyRoyaltyTierWalk(input: {
  royaltyBasisCents: number;
  cumulativeBeforeCents: number;
  bands: readonly EnergyRoyaltyTierBand[];
}): {
  legs: {
    band_from: number;
    band_to: number | null;
    royalty_bps: number;
    band_basis_cents: number;
    band_royalty_cents: number;
  }[];
  royaltyCents: number;
  cumulativeAfterCents: number;
} {
  const { royaltyBasisCents, cumulativeBeforeCents, bands } = input;
  if (!Number.isInteger(royaltyBasisCents) || royaltyBasisCents < 0) {
    throw new Error(`energy_walk_invalid_basis:${royaltyBasisCents}`);
  }
  if (!Number.isInteger(cumulativeBeforeCents) || cumulativeBeforeCents < 0) {
    throw new Error(`energy_walk_invalid_position:${cumulativeBeforeCents}`);
  }
  if (bands.length === 0) {
    throw new Error("energy_walk_bands_empty");
  }
  const cumulativeAfterCents = cumulativeBeforeCents + royaltyBasisCents;

  // The basis each band holds: band window ∩ (before, after].
  type BandSlot = { band: EnergyRoyaltyTierBand; lower: number; basis: number };
  const slots: BandSlot[] = [];
  {
    let lower = 0;
    for (const band of bands) {
      const upper = band.up_to;
      const bandLow = Math.max(cumulativeBeforeCents, lower);
      const bandHigh =
        upper === null ? cumulativeAfterCents : Math.min(cumulativeAfterCents, upper);
      slots.push({ band, lower, basis: Math.max(0, bandHigh - bandLow) });
      if (upper === null) break;
      lower = upper;
    }
  }

  const legs: {
    band_from: number;
    band_to: number | null;
    royalty_bps: number;
    band_basis_cents: number;
    band_royalty_cents: number;
  }[] = [];
  let royaltyCents = 0;
  for (const slot of slots) {
    if (slot.basis <= 0) continue;
    const bandRoyaltyCents = energyBpsShareCents(slot.basis, slot.band.royalty_bps);
    legs.push({
      band_from: slot.lower,
      band_to: slot.band.up_to,
      royalty_bps: slot.band.royalty_bps,
      band_basis_cents: slot.basis,
      band_royalty_cents: bandRoyaltyCents,
    });
    royaltyCents += bandRoyaltyCents;
  }

  return { legs, royaltyCents, cumulativeAfterCents };
}

/** Validates a royalty policy's tier bands — ascending finite bounds, at
 * most one open top band (last), bounded bps. The registries run this
 * before persisting; a band outside the vocabulary is a refusal, never a
 * stored guess (the hardware band validator's discipline). */
export function validateEnergyRoyaltyBands(
  bands: readonly unknown[],
): EnergyRoyaltyTierBand[] {
  if (!Array.isArray(bands) || bands.length === 0) {
    throw new Error("energy_bands_empty");
  }
  const parsed: EnergyRoyaltyTierBand[] = [];
  let previousBound = 0;
  for (const raw of bands) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("energy_bands_shape");
    }
    const band = raw as Record<string, unknown>;
    const upTo = band.up_to;
    const rate = band.royalty_bps;
    if (upTo !== null && (!Number.isInteger(upTo) || (upTo as number) <= previousBound)) {
      throw new Error("energy_bands_bounds");
    }
    if (!Number.isInteger(rate) || (rate as number) <= 0 || (rate as number) > 10_000) {
      throw new Error("energy_bands_rate");
    }
    parsed.push({ up_to: upTo as number | null, royalty_bps: rate as number });
    if (upTo !== null) {
      previousBound = upTo as number;
    }
  }
  // Only the last band may be open, and every band after an open band is
  // unreachable — reject trailing bands.
  if (parsed.some((band, index) => band.up_to === null && index !== parsed.length - 1)) {
    throw new Error("energy_bands_open_not_last");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// THE LAND PARCEL MULTI-OWNER SPLIT — the surveyed acreage ratios divide
// the pot across the deeded fractional heirs; the dust rides the largest
// deeded acreage (deterministic, conserving).
// ---------------------------------------------------------------------------

export type AcreageInterestInput = {
  readonly payeeId: string;
  readonly deededAcresMicros: number;
};

export function planParcelAcreageDivision(input: {
  interests: readonly AcreageInterestInput[];
  potCents: number;
}): { payee_id: string; deeded_acres_micros: number; allocated_cents: number }[] {
  const { interests, potCents } = input;
  if (!Number.isInteger(potCents) || potCents < 0) {
    throw new Error(`energy_division_invalid_pot:${potCents}`);
  }
  if (interests.length === 0) {
    throw new Error("energy_division_no_interests");
  }
  const totalAcresMicros = interests.reduce(
    (sum, interest) => sum + interest.deededAcresMicros,
    0,
  );
  if (!Number.isInteger(totalAcresMicros) || totalAcresMicros <= 0) {
    throw new Error("energy_division_zero_acreage");
  }

  // The exact proportional floor share per interest: floor(acres × pot /
  // totalAcres) — then the dust (pot − allocated) tops up the ranked
  // legs (largest acreage first) until the pot conserves exactly.
  const ranked = [...interests].sort(
    (a, b) =>
      b.deededAcresMicros - a.deededAcresMicros ||
      (a.payeeId < b.payeeId ? -1 : a.payeeId > b.payeeId ? 1 : 0),
  );
  const legs = ranked.map((interest) => ({
    payee_id: interest.payeeId,
    deeded_acres_micros: interest.deededAcresMicros,
    allocated_cents: 0,
  }));
  for (let index = 0; index < ranked.length; index += 1) {
    // BigInt exact — acres × pot at heir scale overflows Number.
    legs[index].allocated_cents = Number(
      (BigInt(ranked[index].deededAcresMicros) * BigInt(potCents)) /
        BigInt(totalAcresMicros),
    );
  }
  let allocated = legs.reduce((sum, leg) => sum + leg.allocated_cents, 0);
  for (const leg of legs) {
    if (allocated >= potCents) break;
    leg.allocated_cents += 1;
    allocated += 1;
  }

  return [...legs].sort((a, b) => (a.payee_id < b.payee_id ? -1 : 1));
}

// ---------------------------------------------------------------------------
// THE COMPUTE CLUSTER AND ENERGY GRID SPLIT — the cluster's AI and cloud
// compute revenue distributes across the registered participants by
// their telemetry-scaled weights: GPU hardware owners weight by the
// row's compute hours, power plant operators by the row's power draw,
// colocation facility managers ride their registered weight flat. The
// split is therefore DYNAMIC — a row with double the compute hours
// shifts the allocation toward the GPU owners.
// ---------------------------------------------------------------------------

export type EnergyGridParticipantClass =
  | "gpu_hardware_owner"
  | "power_plant_operator"
  | "colocation_manager";

export const ENERGY_GRID_PARTICIPANT_CLASSES: readonly EnergyGridParticipantClass[] = [
  "gpu_hardware_owner",
  "power_plant_operator",
  "colocation_manager",
];

export type GridParticipantInput = {
  readonly payeeId: string;
  readonly participantClass: EnergyGridParticipantClass;
  readonly weightMicros: number;
};

export type GridTelemetryInput = {
  /** The row's compute hours in micros (the GPU owners' telemetry leg). */
  readonly computeHoursMicros: number;
  /** The row's average power draw in kilowatt micros (the power
   * operators' telemetry leg). */
  readonly powerDrawKwMicros: number;
};

export function planComputeGridSplit(input: {
  participants: readonly GridParticipantInput[];
  telemetry: GridTelemetryInput;
  revenueCents: number;
}): {
  legs: {
    payee_id: string;
    participant_class: EnergyGridParticipantClass;
    effective_weight_micros: number;
    allocated_cents: number;
  }[];
  allocatedTotalCents: number;
} {
  const { participants, telemetry, revenueCents } = input;
  if (!Number.isInteger(revenueCents) || revenueCents < 0) {
    throw new Error(`energy_grid_split_invalid_revenue:${revenueCents}`);
  }
  if (!Number.isInteger(telemetry.computeHoursMicros) || telemetry.computeHoursMicros < 0) {
    throw new Error(`energy_grid_split_invalid_compute_hours:${telemetry.computeHoursMicros}`);
  }
  if (!Number.isInteger(telemetry.powerDrawKwMicros) || telemetry.powerDrawKwMicros < 0) {
    throw new Error(`energy_grid_split_invalid_power_draw:${telemetry.powerDrawKwMicros}`);
  }
  if (participants.length === 0) {
    throw new Error("energy_grid_split_no_participants");
  }

  // The effective weight: the registered weight scaled by the class's
  // telemetry factor (flat 1e6 for the colocation managers).
  const telemetryFactor = (participantClass: EnergyGridParticipantClass): number => {
    switch (participantClass) {
      case "gpu_hardware_owner":
        return telemetry.computeHoursMicros;
      case "power_plant_operator":
        return telemetry.powerDrawKwMicros;
      case "colocation_manager":
        return 1_000_000;
    }
  };

  const weighted = participants.map((participant) => {
    if (
      !Number.isInteger(participant.weightMicros) ||
      participant.weightMicros <= 0
    ) {
      throw new Error(`energy_grid_split_invalid_weight:${participant.payeeId}`);
    }
    return {
      payee_id: participant.payeeId,
      participant_class: participant.participantClass,
      effective_weight_micros: participant.weightMicros * telemetryFactor(participant.participantClass),
      allocated_cents: 0,
    };
  });
  const totalEffective = weighted.reduce(
    (sum, leg) => sum + leg.effective_weight_micros,
    0,
  );
  if (totalEffective <= 0) {
    throw new Error("energy_grid_split_zero_weight");
  }

  // The floor share per participant, then the dust to the largest
  // effective weight — deterministic by (weight, payee id).
  const ranked = [...weighted].sort(
    (a, b) =>
      b.effective_weight_micros - a.effective_weight_micros ||
      (a.payee_id < b.payee_id ? -1 : a.payee_id > b.payee_id ? 1 : 0),
  );
  for (const leg of ranked) {
    // BigInt exact — weight × telemetry × revenue at cluster scale
    // overflows Number.
    leg.allocated_cents = Number(
      (BigInt(leg.effective_weight_micros) * BigInt(revenueCents)) /
        BigInt(totalEffective),
    );
  }
  let allocated = ranked.reduce((sum, leg) => sum + leg.allocated_cents, 0);
  for (const leg of ranked) {
    if (allocated >= revenueCents) break;
    leg.allocated_cents += 1;
    allocated += 1;
  }

  return {
    legs: [...weighted].sort((a, b) => (a.payee_id < b.payee_id ? -1 : 1)),
    allocatedTotalCents: revenueCents,
  };
}

// ---------------------------------------------------------------------------
// THE ECOLOGICAL YIELD MICRO-ROYALTIES — per-tonne carbon offset payouts
// routed to the conservation trust and the project developer upon
// satellite-verified telemetry.
// ---------------------------------------------------------------------------

export function carbonOffsetPayoutCents(input: {
  /** The satellite-verified tonnes in statement micros — the house
   * quantity parse (1 unit = 1e8 micros), so a 12.5-tonne row parses
   * from "12.5". */
  tonnesVerifiedMicros: number;
  /** The policy's rate of record: money statement micros per tonne
   * ($1.50/tonne = 150_000_000). */
  microsPerTonne: number;
  /** The trust's bps share of the payout pot. */
  trustShareBps: number;
}): { potCents: number; trustCents: number; developerCents: number } {
  const { tonnesVerifiedMicros, microsPerTonne, trustShareBps } = input;
  if (!Number.isInteger(tonnesVerifiedMicros) || tonnesVerifiedMicros <= 0) {
    throw new Error(`energy_offset_invalid_tonnes:${tonnesVerifiedMicros}`);
  }
  if (!Number.isInteger(microsPerTonne) || microsPerTonne <= 0) {
    throw new Error(`energy_offset_invalid_rate:${microsPerTonne}`);
  }
  if (!Number.isInteger(trustShareBps) || trustShareBps <= 0 || trustShareBps >= 10_000) {
    throw new Error(`energy_offset_invalid_trust_share:${trustShareBps}`);
  }
  // The pot in exact cents: tonnes × microsPerTonne / 1e8 = the payout's
  // money micros (the tonne scale cancels), floored into cents / 1e6 —
  // potCents = floor(tonnesVerifiedMicros × microsPerTonne / 1e14). A
  // sub-cent pot floors to zero payable cents (recorded, never guessed
  // into a rounding).
  const potCents = Number(
    (BigInt(tonnesVerifiedMicros) * BigInt(microsPerTonne)) /
      100_000_000_000_000n,
  );
  const trustCents = energyBpsShareCents(potCents, trustShareBps);
  return { potCents, trustCents, developerCents: potCents - trustCents };
}

// ---------------------------------------------------------------------------
// STATUTORY INTEREST — the day-count exact formula across deed transfers:
// floor(base × lateDays × rateBps / 3,650,000) — the same integer
// division the 0052 CHECK enforces (positive operands, truncation
// toward zero is the floor).
// ---------------------------------------------------------------------------

export function statutoryInterestCents(input: {
  baseCents: number;
  lateDays: number;
  rateBps: number;
}): number {
  const { baseCents, lateDays, rateBps } = input;
  if (!Number.isInteger(baseCents) || baseCents < 0) {
    throw new Error(`energy_interest_invalid_base:${baseCents}`);
  }
  if (!Number.isInteger(lateDays) || lateDays < 0) {
    throw new Error(`energy_interest_invalid_late_days:${lateDays}`);
  }
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new Error(`energy_interest_invalid_rate:${rateBps}`);
  }
  // BigInt exact — base × lateDays × rate overflows Number.
  return Number(
    (BigInt(baseCents) * BigInt(lateDays) * BigInt(rateBps)) / 3_650_000n,
  );
}

/** The content-derived event id for the energy lane's rows — the ledger
 * namespace riding the energy prefix (the hardware precedent). */
export function energyRowEventId(
  kind: "meter_sales" | "pipeline_deduction" | "gpu_utilization" | "realization" | "division" | "grid_split" | "statutory_interest" | "carbon_payout",
  senderRowId: string,
  suffix?: string,
): string {
  return `energy:${kind}:${senderRowId}${suffix === undefined ? "" : `:${suffix}`}`;
}
