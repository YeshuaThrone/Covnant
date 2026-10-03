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
