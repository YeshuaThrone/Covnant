/**
 * CVT recon worker — the hardware lane's senders and pure calculators
 * (PR 46, migration 0050, the founder hardware directive). Same posture
 * as every lane's engine file: the senders are the four strict feed
 * families, the row event ids are content-derived fingerprints (the
 * replay guard), and the calculators are pure, exact-integer functions —
 * never a float, never a guess. The vocabularies here are byte-identical
 * to the 0050 SQL CHECKs.
 */

import { createHash } from "node:crypto";
import type { HardwareSepTierBand } from "@/modules/hardware/records";

export type HardwareSenderCode =
  | "cellular_activation"
  | "mac_address_log"
  | "production_serial"
  | "smart_grid_telemetry";

function hardwareFingerprint(...fields: readonly string[]): string {
  return createHash("sha256").update(fields.join("|")).digest("hex");
}

/**
 * The row's event id — one per (ledger, sender, period, sender row id).
 * The sender's row id of record is the identity core: a re-shipped sheet
 * replays as a counted no-op, and two senders' sheets stay distinct
 * identities. The ledger namespace rides the prefix — one source event
 * can appear in several ledgers (a production batch routes the routing
 * and both pools' waterfalls) without colliding.
 */
export function hardwareRowEventId(
  ledger:
    | "realization"
    | "sep_royalty"
    | "pool_routing"
    | "pool_waterfall"
    | "telemetry"
    | "ota_unlock",
  detail: {
    sender: HardwareSenderCode;
    period: string;
    senderRowId: string;
  },
): string {
  return `hardware:${ledger}:${detail.sender}:${hardwareFingerprint(
    detail.period,
    detail.senderRowId,
  )}`;
}

/** Floors statement micros to integer cents — the application ledgers'
 * pricing pin (cents = micros / 1,000,000, never rounded up). */
export function hardwareMicrosToCents(micros: number | bigint): number {
  return Math.floor(Number(micros) / 1_000_000);
}

/** The reporting period's shape of record (YYYY-MM) — the tracking is
 * monthly. */
export function isHardwarePeriod(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

/** Floors a basis-points share of a cents amount — per-leg exact, never
 * rounds up (the founder's cent-exact canon). */
export function hardwareBpsShareCents(amountCents: number, bps: number): number {
  return Math.floor((amountCents * bps) / 10_000);
}

/**
 * THE NET HARDWARE PATENT REALIZATION CALCULATOR (the founder directive's
 * exact identity, keyed on the row's patent_family_id, sep_pool_code, and
 * device_imei_mac columns — the identity legs ride the application):
 *
 *   Net Patentable Device Value Base =
 *     device wholesale ASP
 *     − component COGS base
 *     − non-essential bill of materials
 *
 * Every leg is a recorded money amount (the activation statement's own
 * figures — never a rate guess). The identity (COGS + BOM + net === ASP)
 * pins the math. A deduction set larger than the ASP yields a negative
 * net — the CALLER holds that application (held_negative_net); this
 * function records the arithmetic honestly either way.
 */
export function netHardwarePatentRealizationCents(input: {
  deviceWholesaleAspCents: number;
  componentCogsBaseCents: number;
  nonEssentialBomCents: number;
}): {
  deviceWholesaleAspCents: number;
  netPatentableDeviceValueBaseCents: number;
} {
  const legs = [
    input.deviceWholesaleAspCents,
    input.componentCogsBaseCents,
    input.nonEssentialBomCents,
  ];
  for (const leg of legs) {
    if (!Number.isInteger(leg) || leg < 0) {
      throw new Error(`hardware_realization_invalid_leg:${leg}`);
    }
  }
  const netPatentableDeviceValueBaseCents =
    input.deviceWholesaleAspCents -
    input.componentCogsBaseCents -
    input.nonEssentialBomCents;
  return {
    deviceWholesaleAspCents: input.deviceWholesaleAspCents,
    netPatentableDeviceValueBaseCents,
  };
}

/**
 * THE TIERED SEP MICRO-ROYALTY — the per-unit FRAND walk. The connected
 * units cross the (licensee, patent family, pool, month) cumulative unit
 * position; each band carries its own FRAND rate and per-unit cap, and
 * the band's per-unit royalty floors the basis's rate against the cap —
 * the founder example's exact shape (a 2.5% FRAND rate capped at $3.00
 * per connected vehicle module for 5G SEPs): a $200.00 basis at 250 bps
 * prices $5.00 per unit, the $3.00 cap binds, the unit pays $3.00.
 */
export function hardwareSepTierWalk(input: {
  units: number;
  cumulativeBefore: number;
  royaltyBasisCents: number;
  bands: readonly HardwareSepTierBand[];
}): {
  legs: {
    band_from: number;
    band_to: number | null;
    frand_rate_bps: number;
    per_unit_cap_cents: number;
    band_units: number;
    band_payout_cents: number;
  }[];
  royaltyCents: number;
  cumulativeAfter: number;
} {
  const { units, cumulativeBefore, royaltyBasisCents, bands } = input;
  if (!Number.isInteger(units) || units <= 0) {
    throw new Error(`hardware_walk_invalid_units:${units}`);
  }
  if (!Number.isInteger(cumulativeBefore) || cumulativeBefore < 0) {
    throw new Error(`hardware_walk_invalid_position:${cumulativeBefore}`);
  }
  if (!Number.isInteger(royaltyBasisCents) || royaltyBasisCents < 0) {
    throw new Error(`hardware_walk_invalid_basis:${royaltyBasisCents}`);
  }
  const cumulativeAfter = cumulativeBefore + units;

  // The units each band holds: band window ∩ (before, after].
  type BandSlot = { band: HardwareSepTierBand; lower: number; units: number };
  const slots: BandSlot[] = [];
  {
    let lower = 0;
    for (const band of bands) {
      const upper = band.up_to;
      const bandLow = Math.max(cumulativeBefore, lower);
      const bandHigh = upper === null ? cumulativeAfter : Math.min(cumulativeAfter, upper);
      slots.push({ band, lower, units: Math.max(0, bandHigh - bandLow) });
      if (upper === null) break;
      lower = upper;
    }
  }

  const legs: {
    band_from: number;
    band_to: number | null;
    frand_rate_bps: number;
    per_unit_cap_cents: number;
    band_units: number;
    band_payout_cents: number;
  }[] = [];
  let royaltyCents = 0;
  for (const slot of slots) {
    if (slot.units <= 0) continue;
    // THE PER-UNIT CAP — min(the basis's FRAND rate, the cap), floored
    // per unit (never rounds up), then × the band's units.
    const uncapped = hardwareBpsShareCents(royaltyBasisCents, slot.band.frand_rate_bps);
    const perUnit = Math.min(uncapped, slot.band.per_unit_cap_cents);
    const bandPayoutCents = perUnit * slot.units;
    legs.push({
      band_from: slot.lower,
      band_to: slot.band.up_to,
      frand_rate_bps: slot.band.frand_rate_bps,
      per_unit_cap_cents: slot.band.per_unit_cap_cents,
      band_units: slot.units,
      band_payout_cents: bandPayoutCents,
    });
    royaltyCents += bandPayoutCents;
  }

  return { legs, royaltyCents, cumulativeAfter };
}

/** Validates a FRAND policy's tier bands — ascending finite bounds, at
 * most one open top band (last), positive integer caps, bounded bps. The
 * registries run this before persisting; a band outside the vocabulary
 * is a 422, never a stored guess. */
export function validateHardwareSepBands(
  bands: readonly unknown[],
): HardwareSepTierBand[] {
  if (!Array.isArray(bands) || bands.length === 0) {
    throw new Error("hardware_bands_empty");
  }
  const parsed: HardwareSepTierBand[] = [];
  let previousBound = 0;
  for (const raw of bands) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("hardware_bands_shape");
    }
    const band = raw as Record<string, unknown>;
    const upTo = band.up_to;
    const rate = band.frand_rate_bps;
    const cap = band.per_unit_cap_cents;
    if (upTo !== null && (!Number.isInteger(upTo) || (upTo as number) <= previousBound)) {
      throw new Error("hardware_bands_bounds");
    }
    if (!Number.isInteger(rate) || (rate as number) <= 0 || (rate as number) > 10_000) {
      throw new Error("hardware_bands_rate");
    }
    if (!Number.isInteger(cap) || (cap as number) <= 0) {
      throw new Error("hardware_bands_cap");
    }
    parsed.push({
      up_to: upTo as number | null,
      frand_rate_bps: rate as number,
      per_unit_cap_cents: cap as number,
    });
    if (upTo !== null) {
      previousBound = upTo as number;
    }
  }
  // Only the last band may be open, and every band after an open band is
  // unreachable — reject trailing bands.
  if (parsed.some((band, index) => band.up_to === null && index !== parsed.length - 1)) {
    throw new Error("hardware_bands_open_not_last");
  }
  return parsed;
}

/**
 * THE AUTOMOTIVE POOL ROUTING — per-vehicle cellular and navigation
 * licensing fees × the production serials, routed to the line's pools of
 * record. Both legs are integer-exact (serials × fee); the totals
 * conserve (cellular + navigation === total).
 */
export function automotivePoolRoutingCents(input: {
  serialsProduced: number;
  cellularFeePerVehicleCents: number;
  navigationFeePerVehicleCents: number;
}): {
  cellularRoutedCents: number;
  navigationRoutedCents: number;
  totalRoutedCents: number;
} {
  const { serialsProduced, cellularFeePerVehicleCents, navigationFeePerVehicleCents } = input;
  if (!Number.isInteger(serialsProduced) || serialsProduced <= 0) {
    throw new Error(`hardware_routing_invalid_serials:${serialsProduced}`);
  }
  for (const fee of [cellularFeePerVehicleCents, navigationFeePerVehicleCents]) {
    if (!Number.isInteger(fee) || fee < 0) {
      throw new Error(`hardware_routing_invalid_fee:${fee}`);
    }
  }
  const cellularRoutedCents = serialsProduced * cellularFeePerVehicleCents;
  const navigationRoutedCents = serialsProduced * navigationFeePerVehicleCents;
  return {
    cellularRoutedCents,
    navigationRoutedCents,
    totalRoutedCents: cellularRoutedCents + navigationRoutedCents,
  };
}

/**
 * THE ESSENTIALITY-WEIGHTED POOL WATERFALL — the incoming pool fee pot
 * distributes across the pool's verified holders by essentiality score
 * weightings (the MPEG-LA / Avanci shape): each holder's floor share,
 * then the sub-cent dust to the highest-scored holders in a deterministic
 * order (score DESC, payee ASC) until the pot conserves exactly.
 */
export function essentialityWaterfallCents(input: {
  poolFeePotCents: number;
  holders: readonly { holder_payee_id: string; essentiality_score: number }[];
}): {
  legs: { holder_payee_id: string; essentiality_score: number; allocated_cents: number }[];
  allocatedTotalCents: number;
} {
  const { poolFeePotCents, holders } = input;
  if (!Number.isInteger(poolFeePotCents) || poolFeePotCents < 0) {
    throw new Error(`hardware_waterfall_invalid_pot:${poolFeePotCents}`);
  }
  if (holders.length === 0) {
    throw new Error("hardware_waterfall_no_holders");
  }
  const seen = new Set<string>();
  let scoreSum = 0;
  for (const holder of holders) {
    if (
      typeof holder.holder_payee_id !== "string" ||
      holder.holder_payee_id.trim() === "" ||
      seen.has(holder.holder_payee_id)
    ) {
      throw new Error(`hardware_waterfall_invalid_holder:${holder.holder_payee_id}`);
    }
    if (!Number.isInteger(holder.essentiality_score) || holder.essentiality_score <= 0) {
      throw new Error(`hardware_waterfall_invalid_score:${holder.essentiality_score}`);
    }
    seen.add(holder.holder_payee_id);
    scoreSum += holder.essentiality_score;
  }
  const legs = holders.map((holder) => ({
    holder_payee_id: holder.holder_payee_id,
    essentiality_score: holder.essentiality_score,
    allocated_cents: Math.floor((poolFeePotCents * holder.essentiality_score) / scoreSum),
  }));
  // The dust — the sub-cent remainder — rides the highest-scored holders
  // in the deterministic order (score DESC, payee ASC) until the pot
  // conserves exactly.
  let allocated = legs.reduce((sum, leg) => sum + leg.allocated_cents, 0);
  const dust = poolFeePotCents - allocated;
  if (dust > 0) {
    const ordered = [...legs].sort((a, b) => {
      if (b.essentiality_score !== a.essentiality_score) {
        return b.essentiality_score - a.essentiality_score;
      }
      return a.holder_payee_id < b.holder_payee_id ? -1 : 1;
    });
    for (let index = 0; index < dust; index += 1) {
      ordered[index % ordered.length].allocated_cents += 1;
      allocated += 1;
    }
  }
  return { legs, allocatedTotalCents: allocated };
}

/**
 * THE CLEAN-TECH TELEMETRY MICRO-PAYOUT — per-kilowatt-hour and
 * per-charge-cycle micros off the IoT telemetry row's delivered energy
 * and completed charge cycles, exact. The identity is pinned at the
 * database (hardware_telemetry_royalty_applications' micros-math CHECK):
 *
 *   royalty_micros = (kwh_micros × micros_per_kwh) / 1e8
 *                    + charge_cycles × micros_per_charge_cycle
 *
 * kwh_micros prices the delivered energy at 1e8 statement micros per
 * kWh, so the energy product divides back down by 1e8 — the rate is
 * micro-dollars per kWh (without the division the product double-scales
 * 1e8x and a $0.001/kWh micro-payout would price at $100,000/kWh). The
 * cycle leg is a plain count × micro-dollars per cycle. Bigint division
 * floors the energy leg (the house cent-exact canon, never rounds up);
 * this function is that same arithmetic, so the TS and the SQL
 * vocabulary are byte-identical (the PR 129 lesson).
 */
export function telemetryRoyaltyMicros(input: {
  kwhMicros: number;
  chargeCycles: number;
  microsPerKwh: number;
  microsPerChargeCycle: number;
}): {
  energyMicros: number;
  cycleMicros: number;
  royaltyMicros: number;
} {
  const { kwhMicros, chargeCycles, microsPerKwh, microsPerChargeCycle } = input;
  if (!Number.isInteger(kwhMicros) || kwhMicros < 0) {
    throw new Error(`hardware_telemetry_invalid_kwh:${kwhMicros}`);
  }
  if (!Number.isInteger(chargeCycles) || chargeCycles < 0) {
    throw new Error(`hardware_telemetry_invalid_cycles:${chargeCycles}`);
  }
  for (const rate of [microsPerKwh, microsPerChargeCycle]) {
    if (!Number.isInteger(rate) || rate < 0) {
      throw new Error(`hardware_telemetry_invalid_rate:${rate}`);
    }
  }
  // The two legs — exact bigint products, converging with the DB CHECK
  // identity (the energy product divides back down by 1e8; no dust
  // pricing).
  const energyMicros = (BigInt(kwhMicros) * BigInt(microsPerKwh)) / 100_000_000n;
  const cycleMicros = BigInt(chargeCycles) * BigInt(microsPerChargeCycle);
  const royaltyMicros = energyMicros + cycleMicros;
  return {
    energyMicros: Number(energyMicros),
    cycleMicros: Number(cycleMicros),
    royaltyMicros: Number(royaltyMicros),
  };
}

/**
 * THE OTA FEATURE-UNLOCK ROYALTY SPLIT — the per-unlock policy's terms:
 * micros per unlock, the sensor licensor's bps share, the residual the
 * platform's. The settlement pot floors the micros to cents (the 0048
 * discipline); the licensor share floors the pot's bps; the platform
 * takes the remainder — the split conserves ALWAYS.
 */
export function otaUnlockSplit(input: {
  microsPerUnlock: number;
  licensorShareBps: number;
}): {
  settlementMicros: bigint;
  settlementCents: number;
  licensorCents: number;
  platformCents: number;
} {
  const { microsPerUnlock, licensorShareBps } = input;
  if (!Number.isInteger(microsPerUnlock) || microsPerUnlock <= 0) {
    throw new Error(`hardware_ota_invalid_rate:${microsPerUnlock}`);
  }
  if (!Number.isInteger(licensorShareBps) || licensorShareBps < 0 || licensorShareBps > 10_000) {
    throw new Error(`hardware_ota_invalid_bps:${licensorShareBps}`);
  }
  const settlementMicros = BigInt(microsPerUnlock);
  const settlementCents = hardwareMicrosToCents(settlementMicros);
  const licensorCents = hardwareBpsShareCents(settlementCents, licensorShareBps);
  return {
    settlementMicros,
    settlementCents,
    licensorCents,
    platformCents: settlementCents - licensorCents,
  };
}

/**
 * THE CROSS-LICENSING NET OFFSET — the mutual liabilities net, the
 * founder example's exact shape (Company A owes Company B $12,000,000
 * for 5G SEPs while Company B owes Company A $8,000,000 for Wi-Fi 7
 * SEPs — the net balance clearing dispatches $4,000,000 to Company B).
 * Integer cents in, signed net out; the direction names the dispatch.
 */
export function crossLicenseNetting(input: {
  owedAToBCents: number;
  owedBToACents: number;
}): {
  netCents: number;
  direction: "a_to_b" | "b_to_a" | "balanced";
} {
  const { owedAToBCents, owedBToACents } = input;
  for (const leg of [owedAToBCents, owedBToACents]) {
    if (!Number.isInteger(leg) || leg < 0) {
      throw new Error(`hardware_netting_invalid_leg:${leg}`);
    }
  }
  const netCents = owedAToBCents - owedBToACents;
  return {
    netCents,
    direction: netCents > 0 ? "a_to_b" : netCents < 0 ? "b_to_a" : "balanced",
  };
}

/**
 * The cross-license pair's canonical orientation of record — the
 * agreement registry stores one direction per pair (company_a <
 * company_b) so the netting walk reads one row of identity regardless
 * of which side's royalty application triggered it. Byte-stable string
 * ordering (never locale-dependent).
 */
export function crossLicenseNormalizedPair(
  companyIdA: string,
  companyIdB: string,
): { companyAId: string; companyBId: string } {
  if (companyIdA === companyIdB) {
    throw new Error(`hardware_netting_self_pair:${companyIdA}`);
  }
  return companyIdA < companyIdB
    ? { companyAId: companyIdA, companyBId: companyIdB }
    : { companyAId: companyIdB, companyBId: companyIdA };
}
