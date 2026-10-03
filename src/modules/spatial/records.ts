/**
 * The spatial revenue record vocabulary (PR 36, migration 0040) — the
 * founder's spatial directive's durable facts of record:
 *
 *   spatial_occupancy_tier_schedules — the occupancy royalty schedule of
 *                                      record per (venue, year): the
 *                                      sliding-scale tier bands, keyed on
 *                                      annual guest throughput or the
 *                                      venue's square-footage footprint.
 *   spatial_overhead_policies        — the shared facility overhead policy
 *                                      of record per (venue, year): the
 *                                      park-wide security, wristband
 *                                      maintenance, and ticketing platform
 *                                      bps legs deducted prior to net IP
 *                                      distribution.
 *   spatial_zone_assignments         — the assigned IP owner of record per
 *                                      (venue, zone): the royalty bps the
 *                                      zone's merch and F&B sales route to.
 *   spatial_micro_policies           — the micro-royalty rate of record per
 *                                      (venue, zone): the per-dwell-minute
 *                                      and per-ride-session unit rates.
 *   spatial_throughput_years         — the cumulative annual throughput of
 *                                      record per (venue, year): the tier
 *                                      walk's position.
 *   spatial_royalty_applications     — the append-only per-event occupancy
 *                                      royalty application: the Adjusted
 *                                      Location Sales calculator's legs,
 *                                      the shared overhead deduction, and
 *                                      the tier walk's committed bands.
 *   spatial_zone_allocations         — the append-only per-event zone
 *                                      allocation: the zone's overhead legs,
 *                                      the assigned IP owner, and the
 *                                      owner's royalty of record.
 *   spatial_micro_royalty_ledger     — the append-only per-event
 *                                      micro-royalty: the dwell and session
 *                                      legs and the exact micros math.
 *
 * Money is integer cents throughout; royalty unit rates are statement
 * micros (1 dollar = 1e8 micros) so sub-cent unit pricing stays exact.
 * Rates are basis points where they price a share of a money basis. No
 * foreign keys by design — the tables key on content-derived event ids,
 * the sender's venue/zone identifiers, and schedule years (the 0036–0039
 * discipline).
 */

import {
  BPS_DENOMINATOR,
  SPATIAL_AUDIT_ESCROW_MAX_RATE_BPS,
  SPATIAL_AUDIT_ESCROW_MIN_RATE_BPS,
  type SpatialAuditEscrowDrawdownClass,
} from "@/modules/don/constants";

/** The occupancy royalty schedule's basis of record — annual guest
 * throughput (cumulative turnstile entries) or the venue's square-footage
 * footprint allocation. */
export type SpatialTierBasis = "annual_throughput" | "footprint_sqft";

/** One occupancy royalty tier band. `up_to` is the band's exclusive upper
 * bound ON THE BASIS (cumulative entries for the throughput basis; the
 * venue's footprint sqft for the footprint basis) — null marks the open
 * top band. Exactly one band per schedule carries `up_to: null`, and it is
 * the LAST band. */
export type SpatialTierBand = {
  readonly up_to: number | null;
  /** The band's royalty rate, bps of the money basis routed through it. */
  readonly royalty_bps: number;
};

/**
 * Validates an occupancy tier schedule at registration — bands in
 * ascending order with strictly increasing bounds, the first bound past
 * zero, exactly one terminal open band (last), and every rate an integer
 * 1–10000 bps. A schedule that fails any clause is a hostile registration,
 * refused (the walk never guesses a rate).
 */
export function validateSpatialTierSchedule(
  bands: readonly SpatialTierBand[],
): { ok: true } | { ok: false; reason: string } {
  if (bands.length === 0) return { ok: false, reason: "empty_schedule" };
  let previousBound = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index] as SpatialTierBand;
    if (!Number.isInteger(band.royalty_bps) || band.royalty_bps <= 0 || band.royalty_bps > 10_000) {
      return { ok: false, reason: `band_${index}:royalty_bps_out_of_range` };
    }
    if (band.up_to === null) {
      if (index !== bands.length - 1) {
        return { ok: false, reason: `band_${index}:open_band_not_last` };
      }
      continue;
    }
    if (!Number.isInteger(band.up_to) || band.up_to <= previousBound) {
      return { ok: false, reason: `band_${index}:bound_not_increasing` };
    }
    previousBound = band.up_to;
  }
  const last = bands[bands.length - 1] as SpatialTierBand;
  if (last.up_to !== null) return { ok: false, reason: "no_open_top_band" };
  return { ok: true };
}

/** The occupancy royalty application's verdict of record. `paid` — every
 * policy of record was present and the money walked; `held_negative_net` —
 * the calculator's deduction legs exceeded its gross (the math is recorded
 * visible; no royalty posts). */
export type SpatialRoyaltyVerdict = "paid" | "held_negative_net";

/** The zone allocation's row class of record — which sender's sheet the
 * allocation walked. */
export type SpatialZoneRowClass = "fnb" | "retail";

// ---------------------------------------------------------------------------
// The records.
// ---------------------------------------------------------------------------

/** The occupancy royalty schedule of record per (venue, year). */
export type SpatialOccupancyTierScheduleRecord = {
  id: string;
  venue_id: string;
  /** The schedule year of record (e.g. "2026") — the throughput position
   * and the schedule's rates are annual. */
  year: string;
  basis: SpatialTierBasis;
  /** The tier bands of record — JSON-encoded SpatialTierBand[]. */
  bands: string;
  created_at: string;
  updated_at: string;
};

/** The shared facility overhead policy of record per (venue, year) — the
 * three park-wide bps legs deducted from every IP distribution's basis
 * BEFORE the royalty walk prices it. */
export type SpatialOverheadPolicyRecord = {
  id: string;
  venue_id: string;
  year: string;
  /** Park-wide security's share of the basis, bps. */
  security_bps: number;
  /** Wristband maintenance's share of the basis, bps. */
  wristband_maintenance_bps: number;
  /** The park-wide ticketing platform fee's share of the basis, bps. */
  ticketing_platform_bps: number;
  created_at: string;
  updated_at: string;
};

/** The assigned IP owner of record per (venue, zone) — the royalty waterfall
 * the zone's merch and F&B sales route to. */
export type SpatialZoneAssignmentRecord = {
  id: string;
  venue_id: string;
  zone_code: string;
  /** The assigned IP owner's payee identity of record. */
  assigned_ip_owner_id: string;
  /** The zone's royalty rate, bps of the zone's allocated basis. */
  royalty_bps: number;
  created_at: string;
  updated_at: string;
};

/** The micro-royalty rate of record per (venue, zone) — the real-time unit
 * prices the telemetry walk reads. Both rates are statement micros per
 * unit (1 dollar = 1e8 micros), so sub-cent pricing is exact. */
export type SpatialMicroPolicyRecord = {
  id: string;
  venue_id: string;
  zone_code: string;
  micros_per_dwell_minute: number;
  micros_per_ride_session: number;
  created_at: string;
  updated_at: string;
};

/** The cumulative annual throughput of record per (venue, year) — the
 * tier walk's position, advanced by every entries-bearing row. */
export type SpatialThroughputYearRecord = {
  id: string;
  venue_id: string;
  year: string;
  cumulative_entries: number;
  created_at: string;
  updated_at: string;
};

/** The per-event occupancy royalty application of record — the Adjusted
 * Location Sales calculator's legs, the shared overhead deduction, and the
 * tier walk's committed bands, all pinned where the money landed. */
export type SpatialRoyaltyApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  /** The sender family whose sheet the row walked ('turnstile' | 'pass'). */
  sender: "turnstile" | "pass";
  venue_id: string;
  zone_code: string;
  /** The venue's spatial footprint, sqft — the founder-specified column. */
  spatial_footprint_sqft: number;
  period: string;
  /** The calculator's gross: ticket + merch revenue, whole cents. */
  ticket_revenue_cents: number;
  merch_revenue_cents: number;
  gross_revenue_cents: number;
  occupancy_tax_cents: number;
  infrastructure_cogs_cents: number;
  /** The APPROVED group tour discount deducted; a pending discount never
   * deducts (this column records the deducted amount, 0 when pending). */
  group_tour_discount_cents: number;
  /** The Adjusted Location Sales calculator's net. */
  net_spatial_licensed_revenue_cents: number;
  overhead_security_cents: number;
  overhead_wristband_cents: number;
  overhead_ticketing_cents: number;
  overhead_total_cents: number;
  /** The royalty walk's money basis: net − overhead (the ordering). */
  royalty_basis_cents: number;
  tier_basis: SpatialTierBasis;
  /** The schedule of record's id the walk priced from (null when held —
   * a negative net walks no schedule). */
  tier_schedule_ref: string | null;
  /** The committed tier walk — JSON-encoded SpatialTierWalkLeg[]. */
  tier_legs: string;
  /** The row's turnstile entries (0 on pass rows). */
  entries_count: number;
  /** The venue's cumulative position before/after this row (null when the
   * walk never advanced — held rows). */
  entries_before: number | null;
  entries_after: number | null;
  occupancy_royalty_cents: number;
  verdict: SpatialRoyaltyVerdict;
  created_at: string;
};

/** One tier walk leg — the application's committed band math. */
export type SpatialTierWalkLeg = {
  /** The band's exclusive lower bound on the tier basis. */
  readonly band_from: number;
  /** The band's exclusive upper bound (null = the open top band). */
  readonly band_to: number | null;
  readonly band_rate_bps: number;
  /** The money basis allocated to this band, whole cents. */
  readonly band_basis_cents: number;
  /** The band's entries (0 on footprint-basis and closing-position legs). */
  readonly band_entries: number;
  /** floor(band_basis × band_rate_bps / 10000). */
  readonly band_royalty_cents: number;
};

/** The per-event zone allocation of record — the zone's sales routed to
 * the assigned IP owner's royalty waterfall, overhead-first. */
export type SpatialZoneAllocationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  row_class: SpatialZoneRowClass;
  venue_id: string;
  zone_code: string;
  period: string;
  gross_cents: number;
  overhead_security_cents: number;
  overhead_wristband_cents: number;
  overhead_ticketing_cents: number;
  overhead_total_cents: number;
  /** gross − overhead — the basis the owner's bps prices. */
  allocated_basis_cents: number;
  assigned_ip_owner_id: string;
  royalty_bps: number;
  royalty_cents: number;
  created_at: string;
};

/** The per-event micro-royalty of record — the dwell/session legs and the
 * exact unit-price math, pinned in CHECKs at the database. */
export type SpatialMicroRoyaltyRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  venue_id: string;
  zone_code: string;
  wristband_id: string;
  sensor_id: string;
  period: string;
  dwell_minutes: number;
  ride_sessions: number;
  /** The policy rates of record the math priced from (pinned, not joined). */
  micros_per_dwell_minute: number;
  micros_per_ride_session: number;
  dwell_royalty_micros: number;
  session_royalty_micros: number;
  total_royalty_micros: number;
  /** floor(total_royalty_micros / 1e6) — the payable cents. */
  royalty_cents: number;
  created_at: string;
};

/** Validates a zone assignment's royalty bps at registration — an integer
 * 0–10000 (a 0-bps assignment routes visibility, not money). */
export function isValidSpatialZoneRoyaltyBps(bps: number): boolean {
  return Number.isInteger(bps) && bps >= 0 && bps <= 10_000;
}

/**
 * Re-validates a stored schedule at walk time — a corrupt or mutated
 * schedule is a fail-closed refusal, never a guessed walk (the NIL
 * waterfall discipline).
 */
export function parseSpatialTierBands(
  bandsJson: string,
  scheduleRef: string,
): readonly SpatialTierBand[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bandsJson);
  } catch (error) {
    throw new Error(
      `spatial_tier_bands_corrupt: ${scheduleRef} schedule is not valid JSON`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`spatial_tier_bands_invalid: ${scheduleRef} — not an array`);
  }
  for (const band of parsed) {
    if (typeof band !== "object" || band === null) {
      throw new Error(`spatial_tier_bands_invalid: ${scheduleRef} — non-object band`);
    }
  }
  const bands = parsed as SpatialTierBand[];
  const outcome = validateSpatialTierSchedule(bands);
  if (!outcome.ok) {
    throw new Error(`spatial_tier_bands_invalid: ${scheduleRef} — ${outcome.reason}`);
  }
  return bands;
}

// ---------------------------------------------------------------------------
// PR 37 — spatial commitments (migration 0041): the CapEx recoupment
// offset ledger, the quarterly Minimum Spatial Guarantee, the temporary
// pop-up decommissioning audit, the SPATIAL_AUDIT_ESCROW, and the
// durable spatial payout-gate states. Money stays integer cents; the
// footprint-priced guarantee keeps its unit rate in statement micros so
// sub-cent per-square-foot pricing stays exact.
// ---------------------------------------------------------------------------

/** The allowable CapEx categories of record — exactly the two the
 *  directive names. Anything else refuses at registration (no unpriced
 *  build-cost shape enters the ledger). */
export type SpatialCapexCategory = "ride_construction" | "venue_buildout";
export const SPATIAL_CAPEX_CATEGORIES: readonly SpatialCapexCategory[] = [
  "ride_construction",
  "venue_buildout",
];

/** The spatial royalty streams the CapEx offset reads — the three
 *  append-only royalty ledgers of record (migration 0040). */
export type SpatialRoyaltyStream = "occupancy" | "zone" | "micro";
export const SPATIAL_ROYALTY_STREAMS: readonly SpatialRoyaltyStream[] = [
  "occupancy",
  "zone",
  "micro",
];

export type SpatialCapexCommitmentRecord = {
  id: string;
  /** `venue:{venueId}` — the build-out of record for the venue's space. */
  scope_key: string;
  /** The caller's content identity for the commitment — UNIQUE per scope. */
  capex_ref: string;
  /** Who built it — the recouping party of record. */
  operator_id: string;
  capex_category: SpatialCapexCategory;
  /** The allowable cost of record — integer cents, strictly positive. */
  capex_amount_cents: number;
  /** The recouped convergence counter (derived; the applications are the
   *  append-only truth). */
  recouped_cents: number;
  currency: string;
  created_at: string;
  updated_at: string;
};

export type SpatialCapexApplicationRecord = {
  id: string;
  commitment_id: string;
  scope_key: string;
  capex_category: SpatialCapexCategory;
  /** The spatial royalty event of record this pass offsets — UNIQUE per
   *  commitment is the replay guard. */
  source_event_id: string;
  royalty_stream: SpatialRoyaltyStream;
  /** The event's royalty of record (read from the append-only ledger,
   *  never the caller's numbers). */
  royalty_cents: number;
  /** The position lock — UNIQUE per (commitment, before). */
  offset_before_cents: number;
  offset_cents: number;
  offset_after_cents: number;
  created_at: string;
};

export type SpatialMsgCommitmentRecord = {
  id: string;
  /** `operator:{operatorId}:venue:{venueId}` — one guarantee of record
   *  per operator × venue. */
  scope_key: string;
  operator_id: string;
  /** Display name of the regional licensee or pop-up park operator —
   *  the invoice's payee of record. */
  operator_name: string;
  venue_id: string;
  /** The reserved venue footprint the guarantee prices from — positive
   *  integer square feet. */
  reserved_footprint_sqft: number;
  /** The quarterly rate in statement micros per square foot — positive
   *  integer micros (sub-cent per-sqft pricing stays exact). */
  quarterly_rate_micros_per_sqft: number;
  currency: string;
  created_at: string;
  updated_at: string;
};

export type SpatialMsgTermCloseRecord = {
  id: string;
  commitment_id: string;
  scope_key: string;
  /** Strict `YYYY-QN` — UNIQUE per (commitment, quarter): the once-only
   *  close. */
  quarter: string;
  msg_due_cents: number;
  /** The venue's spatial royalty earnings of record at close (the three
   *  append-only royalty ledgers' sum for the quarter's months). */
  earned_at_close_cents: number;
  /** floor(due − earned, 0) — zero when the guarantee is met. */
  shortfall_cents: number;
  /** The msg_shortfall_due invoice row of record; null when no
   *  shortfall existed. */
  invoice_ledger_id: string | null;
  closed_by: string;
  created_at: string;
  updated_at: string;
};

export type SpatialPopupExperienceRecord = {
  id: string;
  /** The pop-up's content identity — UNIQUE. */
  popup_ref: string;
  venue_id: string;
  zone_code: string;
  operator_id: string;
  /** The pop-up's kind of record (e.g. 'halloween', 'seasonal_ip') —
   *  non-empty free text; the directive's 90-day windows and seasonal
   *  IP experiences both land here. */
  experience_kind: string;
  /** The temporary window of record — strict YYYY-MM-DD, end ≥ start. */
  window_start_date: string;
  window_end_date: string;
  created_at: string;
  updated_at: string;
};

/** The post-event inventory write-off CALCULATION of record —
 *  writeoff_cents is pinned to unsold_units × unit_cost_cents by the
 *  store and the migration, so a mutated calculation is a constraint
 *  violation, never a silently re-priced write-off. */
export type SpatialPopupWriteoffRecord = {
  id: string;
  popup_experience_id: string;
  popup_ref: string;
  /** Replay guard — UNIQUE per (experience, event). */
  source_event_id: string;
  unsold_units: number;
  unit_cost_cents: number;
  writeoff_cents: number;
  evidence_ref: string;
  calculated_by: string;
  created_at: string;
};

export type SpatialPopupRestorationReserveRecord = {
  id: string;
  popup_experience_id: string;
  popup_ref: string;
  /** The site restoration reserve of record — non-negative integer
   *  cents. Insert-as-lock: one reserve per pop-up experience. */
  reserve_cents: number;
  evidence_ref: string;
  funded_by: string;
  created_at: string;
};

export type SpatialAuditEscrowPolicyRecord = {
  id: string;
  scope_key: string;
  /** The founder-banded 5–12% — inclusive bounds (500..1200 bps). */
  reserve_rate_bps: number;
  created_at: string;
  updated_at: string;
};

export type SpatialAuditEscrowDrawdownRecord = {
  id: string;
  reserve_ledger_id: string;
  scope_key: string;
  drawdown_class: SpatialAuditEscrowDrawdownClass;
  /** Replay guard — UNIQUE per (reserve, event). */
  source_event_id: string;
  /** Position lock — UNIQUE per (reserve, before). */
  drawn_before_cents: number;
  drawn_cents: number;
  remaining_cents: number;
  created_at: string;
};

export type SpatialAuditEscrowReconciliationRecord = {
  id: string;
  reserve_ledger_id: string;
  evidence_ref: string;
  reconciled_by: string;
  created_at: string;
};

/** The durable spatial payout-gate states of record (per payee × venue)
 *  — the two states the spatial payout gate reads, fail-closed when
 *  absent or unknown. */
export type SpatialPayoutGateStateRecord = {
  id: string;
  payee_id: string;
  venue_id: string;
  /** 'unknown' reads fail-closed at the gate; only 'cleared' passes. */
  territorial_zoning_state: "unknown" | "cleared";
  /** 'unknown' reads fail-closed at the gate; only 'verified' passes. */
  spatial_audit_state: "unknown" | "verified";
  evidence_ref: string;
  verified_by: string;
  created_at: string;
  updated_at: string;
};

// ---- scope keys -----------------------------------------------------------

/** A park venue's CapEx and escrow scope: `venue:{venueId}`. */
export function spatialCapexScopeKey(venueId: string): string {
  return `venue:${venueId}`;
}

/** An operator's guarantee scope: `operator:{operatorId}:venue:{venueId}`. */
export function spatialMsgScopeKey(operatorId: string, venueId: string): string {
  return `operator:${operatorId}:venue:${venueId}`;
}

/** The SPATIAL_AUDIT_ESCROW scope of record: a park's earnings scope is
 *  `venue:{venueId}`; a temporary pop-up's is
 *  `venue:{venueId}:popup:{popupRef}`. */
export function spatialAuditEscrowScopeKey(venueId: string, popupRef?: string): string {
  return popupRef === undefined
    ? `venue:${venueId}`
    : `venue:${venueId}:popup:${popupRef}`;
}

/** Whether an escrow scope is a temporary pop-up's — the decommissioning
 *  audit reads true for these (the release gate). */
export function isSpatialPopupScope(scopeKey: string): boolean {
  return scopeKey.includes(":popup:");
}

// ---- the quarterly MSG -----------------------------------------------------

/** Strict quarter of record — `YYYY-QN`, N ∈ 1..4. */
export function isSpatialMsgQuarter(quarter: string): boolean {
  return /^(\d{4})-Q([1-4])$/.test(quarter);
}

/** The quarter's three months of record — the earnings reads filter the
 *  append-only royalty ledgers by these period keys. */
export function spatialMsgQuarterMonths(quarter: string): readonly string[] {
  if (!isSpatialMsgQuarter(quarter)) {
    throw new Error(`spatial_msg_quarter_invalid: ${quarter} — expected YYYY-QN`);
  }
  const quarterIndex = Number(quarter.slice(6, 7));
  const year = quarter.slice(0, 4);
  const firstMonth = (quarterIndex - 1) * 3 + 1;
  return [1, 2, 3].map((offset) => {
    const month = firstMonth + offset - 1;
    return `${year}-${String(month).padStart(2, "0")}`;
  });
}

/**
 * The guarantee's face: floor(reservedFootprintSqft ×
 * quarterlyRateMicrosPerSqft / 1e6). BigInt arithmetic — the product of
 * a large footprint and a sub-cent rate stays exact before the floor.
 */
export function spatialMsgDueCents(
  reservedFootprintSqft: number,
  quarterlyRateMicrosPerSqft: number,
): number {
  const micros = (BigInt(reservedFootprintSqft) * BigInt(quarterlyRateMicrosPerSqft)) / 1_000_000n;
  return Number(micros);
}

// ---- the SPATIAL_AUDIT_ESCROW split ---------------------------------------

export type SpatialAuditEscrowSplitPlan = {
  escrow_cents: number;
  remainder_cents: number;
  dust_cents: number;
};

/**
 * The escrow split — floor(bps × held / 10000), remainder by exact
 * subtraction, dust up to the last sub-cent share. Same shape as the
 * NIL split plan; floor-only, never a guessed rounding.
 */
export function buildSpatialAuditEscrowSplitPlan(
  heldCents: number,
  reserveRateBps: number,
): SpatialAuditEscrowSplitPlan {
  const escrowCents = Math.floor((reserveRateBps * heldCents) / BPS_DENOMINATOR);
  const remainderCents = heldCents - escrowCents;
  const dustCents = escrowCents + remainderCents === heldCents
    ? 0
    : heldCents - escrowCents - remainderCents;
  return { escrow_cents: escrowCents, remainder_cents: remainderCents, dust_cents: dustCents };
}

// ---- the CapEx recoupment walk ---------------------------------------------

export type SpatialCapexRecoupmentStep = {
  commitment: SpatialCapexCommitmentRecord;
  offset_before_cents: number;
  offset_cents: number;
  offset_after_cents: number;
};

export type SpatialCapexRecoupmentPlan = {
  applications: readonly SpatialCapexRecoupmentStep[];
  offset_total_cents: number;
  /** The payout that survives the offset — the royalty the IP owner
   *  receives after the build amortizations take their walk. */
  payout_after_offset_cents: number;
  unrecouped_after_cents: number;
};

/**
 * The recoupment router — OLDEST-FIRST across the scope's unrecouped
 * commitments, each application clamped to the commitment's remaining
 * allowable cost, remainder by exact subtraction, nothing lost to
 * rounding. Pure — the caller commits the plan position-locked (UNIQUE
 * per (commitment, source_event) and per (commitment, before)).
 */
export function buildSpatialCapexRecoupmentPlan(
  commitments: readonly SpatialCapexCommitmentRecord[],
  royaltyCents: number,
): SpatialCapexRecoupmentPlan {
  const applications: SpatialCapexRecoupmentStep[] = [];
  let remainingRoyalty = royaltyCents;
  let offsetTotal = 0;
  for (const commitment of [...commitments].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (remainingRoyalty === 0) {
      break;
    }
    const unrecouped = commitment.capex_amount_cents - commitment.recouped_cents;
    if (unrecouped <= 0) {
      continue;
    }
    const applied = Math.min(unrecouped, remainingRoyalty);
    const before = commitment.recouped_cents;
    applications.push({
      commitment,
      offset_before_cents: before,
      offset_cents: applied,
      offset_after_cents: before + applied,
    });
    remainingRoyalty -= applied;
    offsetTotal += applied;
  }
  // The unrecouped position after the walk — every commitment's remaining
  // allowable cost, including the commitments the royalty never reached.
  const appliedByCommitment = new Map<string, number>();
  for (const step of applications) {
    appliedByCommitment.set(
      step.commitment.id,
      (appliedByCommitment.get(step.commitment.id) ?? 0) + step.offset_cents,
    );
  }
  const unrecoupedAfter = commitments.reduce(
    (sum, commitment) =>
      sum +
      Math.max(
        commitment.capex_amount_cents -
          commitment.recouped_cents -
          (appliedByCommitment.get(commitment.id) ?? 0),
        0,
      ),
    0,
  );
  return {
    applications,
    offset_total_cents: offsetTotal,
    payout_after_offset_cents: royaltyCents - offsetTotal,
    unrecouped_after_cents: unrecoupedAfter,
  };
}

// ---- validators ------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** The temporary-window discipline — end same day or after start. */
export function isSpatialPopupWindowValid(
  startDate: string,
  endDate: string,
): boolean {
  return isIsoDateString(startDate) && isIsoDateString(endDate) && endDate >= startDate;
}

export function isSpatialCapexCommitmentRecord(value: unknown): value is SpatialCapexCommitmentRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as SpatialCapexCommitmentRecord;
  return (
    isNonEmptyString(record.scope_key) &&
    isNonEmptyString(record.capex_ref) &&
    isNonEmptyString(record.operator_id) &&
    SPATIAL_CAPEX_CATEGORIES.includes(record.capex_category) &&
    isPositiveInt(record.capex_amount_cents) &&
    isNonNegativeInt(record.recouped_cents) &&
    record.recouped_cents <= record.capex_amount_cents &&
    isNonEmptyString(record.currency)
  );
}

export function isSpatialMsgCommitmentRecord(value: unknown): value is SpatialMsgCommitmentRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as SpatialMsgCommitmentRecord;
  return (
    isNonEmptyString(record.scope_key) &&
    isNonEmptyString(record.operator_id) &&
    isNonEmptyString(record.operator_name) &&
    isNonEmptyString(record.venue_id) &&
    isPositiveInt(record.reserved_footprint_sqft) &&
    isPositiveInt(record.quarterly_rate_micros_per_sqft) &&
    isNonEmptyString(record.currency)
  );
}

export function isSpatialPopupExperienceRecord(value: unknown): value is SpatialPopupExperienceRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as SpatialPopupExperienceRecord;
  return (
    isNonEmptyString(record.popup_ref) &&
    isNonEmptyString(record.venue_id) &&
    isNonEmptyString(record.zone_code) &&
    isNonEmptyString(record.operator_id) &&
    isNonEmptyString(record.experience_kind) &&
    isSpatialPopupWindowValid(record.window_start_date, record.window_end_date)
  );
}

export function isSpatialAuditEscrowPolicyRecord(
  value: unknown,
): value is SpatialAuditEscrowPolicyRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as SpatialAuditEscrowPolicyRecord;
  return (
    isNonEmptyString(record.scope_key) &&
    Number.isInteger(record.reserve_rate_bps) &&
    record.reserve_rate_bps >= SPATIAL_AUDIT_ESCROW_MIN_RATE_BPS &&
    record.reserve_rate_bps <= SPATIAL_AUDIT_ESCROW_MAX_RATE_BPS
  );
}

