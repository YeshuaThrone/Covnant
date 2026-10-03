/**
 * The brand-licensing lane's record layer (PR 32, the founder Net Sales +
 * tiered royalties + sub-license cascade directive).
 *
 * Money follows the house fixed-point discipline: whole ledger cents on the
 * walk rows, exact 1e-8 micros as text on the statement provenance — never a
 * float. Every threshold/rate the tier table pins is integer cents / whole
 * basis points; a float anywhere in the licensing engine is a bug.
 *
 * The tables these mirror (migration 0036):
 *
 *   licensing_royalty_deals        — the versioned deal of record per
 *                                    license scope (`license:<license_id>`):
 *                                    the tier schedule, the agency
 *                                    commission band, the (dual-IP) licensor
 *                                    payees, and the running cumulative
 *                                    counters the tier walk advances.
 *   licensing_royalty_applications — the append-only per-event tier walk:
 *                                    position-locked, replay-guarded, the
 *                                    cumulative state's commit.
 *   licensing_treaty_rates         — the double-taxation treaty rate of
 *                                    record per (source, residence) pair.
 *   licensing_sub_licensees        — the registered regional sub-licensee
 *                                    of record with its master override.
 *   licensing_sub_license_reports  — the regional sub-licensee gross
 *                                    reports of record; the audit-trail
 *                                    gate the net-proceeds release reads.
 */

/** One marginal tier of the deal's royalty schedule. `upToCents` is the
 * tier's EXCLUSIVE upper bound on cumulative net sales — null on the final,
 * unbounded tier. Rates are whole basis points of the slice. */
export type LicensingTierSpec = {
  /** Exclusive upper cumulative bound, whole cents; null = unbounded. */
  upToCents: number | null;
  rateBps: number;
};

/** The tier schedule's shape validator — exported for the cascade's
 * registration gate and the store-backed tests. Rules: at least one tier,
 * every rate 0–10000 integer bps, every bound (when present) a positive
 * safe integer strictly ascending, and exactly one trailing null bound. */
export function validateLicensingTierSchedule(tiers: readonly LicensingTierSpec[]): string | null {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return "A royalty deal registers at least one tier.";
  }
  let previousBound = 0;
  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index]!;
    if (!Number.isInteger(tier.rateBps) || tier.rateBps < 0 || tier.rateBps > 10_000) {
      return `Tier ${index + 1}'s rate must be 0–10000 whole basis points.`;
    }
    if (tier.upToCents === null) {
      if (index !== tiers.length - 1) {
        return "Only the final tier may be unbounded.";
      }
      continue;
    }
    if (!Number.isSafeInteger(tier.upToCents) || tier.upToCents <= previousBound) {
      return "Tier bounds must be positive safe-integer cents, strictly ascending.";
    }
    previousBound = tier.upToCents;
  }
  return null;
}

/**
 * The versioned royalty deal of record per license scope — the contract
 * configuration the engine walks. A re-registration increments version and
 * preserves the cumulative counters (capital of record, the theatrical
 * recoupment discipline). `licensor_b_payee_id` present = the co-branded
 * dual-IP collaboration (the post-agency remainder divides 50/50).
 */
export type LicensingRoyaltyDealRecord = {
  id: string;
  /** UNIQUE — the license scope (`license:<license_id>`). */
  scope_key: string;
  /** The addendum 12 license_id the queue rows key on. */
  license_id: string;
  currency: string;
  /** The marginal tier schedule — ascending bounds, final tier unbounded. */
  tiers: LicensingTierSpec[];
  /** The licensing agency's commission, bps of earned gross royalties,
   * inside the founder band (1500–3500 — the 15–35% directive); null when
   * the contract names no agency. */
  agency_commission_bps: number | null;
  /** The first IP licensor of record — always present. */
  licensor_a_payee_id: string;
  licensor_a_payee_name: string;
  /** The licensor's residence country (ISO alpha-2) — the withholding
   * treaty's residence leg. */
  licensor_a_country: string;
  /** The second IP licensor of record — non-null only on co-branded
   * dual-IP deals (the 50-50 post-agency split's recipient). */
  licensor_b_payee_id: string | null;
  licensor_b_payee_name: string | null;
  licensor_b_country: string | null;
  /** The statutory default withholding rate (bps) applied when the row's
   * source territory and the licensor's residence name no registered
   * treaty pair; null = fail-closed (an uncovered international pair HOLDS
   * the payout rather than guessing). */
  withholding_default_bps: number | null;
  /** The running cumulative net-sales position — the tier walk's input and
   * the cross-period state. NEVER resets on re-registration. */
  cumulative_net_sales_cents: number;
  /** The running cumulative gross royalties earned (pre-agency, the tier
   * walk's own output), whole cents. */
  cumulative_royalty_cents: number;
  /** The tier table's version — incremented on re-registration. */
  version: number;
  created_at: string;
  updated_at: string;
};

/** One marginal slice of a tier walk — the audit detail of the application. */
export type LicensingTierSlice = {
  tierIndex: number;
  rateBps: number;
  /** The slice's net-sales portion, whole cents. */
  sliceCents: number;
  /** floor(slice × rate / 10000) — the slice's royalty, whole cents. */
  royaltyCents: number;
};

/**
 * One append-only royalty application — the per-event walk's commit row.
 * The position fields make the cumulative state self-auditing:
 * cumulative_before + net_sales = the walk's end position, and the slices
 * recover the royalty exactly. UNIQUE per (deal_id, source_event_id) is the
 * replay guard; UNIQUE per (deal_id, cumulative_before_cents) is the
 * position lock (the books/art/theatrical discipline).
 */
export type LicensingRoyaltyApplicationRecord = {
  id: string;
  deal_id: string;
  scope_key: string;
  /** The funding queue row's event id — the once-only key. */
  source_event_id: string;
  /** The statement's reporting period (YYYY-MM) — the cross-period audit. */
  period: string | null;
  /** The event's Net Licensed Sales, whole cents — the walk's basis. */
  net_sales_cents: number;
  /** The cumulative position the walk started from. */
  cumulative_before_cents: number;
  /** Σ slices — the event's earned GROSS royalty, whole cents. */
  royalty_cents: number;
  /** The marginal walk's slices (rates + portions), exact. */
  slices: LicensingTierSlice[];
  /** The agency commission deducted (0 when the deal names no agency). */
  agency_commission_cents: number;
  /** The post-agency royalty split across the licensor ledgers. */
  licensor_a_gross_cents: number;
  licensor_b_gross_cents: number;
  /** The 50-50 split's odd-cent residue on dual-IP deals (0 otherwise). */
  dust_cents: number;
  /** The withholding rate applied to both licensor legs — the deal's
   * resolved rate for this event's source territory (null = domestic, or
   * held-unknown — see licensor_*_withheld_cents). */
  withholding_rate_bps: number | null;
  /** The treaty-withheld legs, whole cents. The states are disjoint:
   * `0` with a null rate = a domestic sale (nothing applied, nothing
   * held); null = the payout leg is HELD (an uncovered international pair
   * the deal names no statutory default for — fail-closed). */
  licensor_a_withheld_cents: number | null;
  licensor_b_withheld_cents: number | null;
  /** The withholding provenance — treaty ref or 'default' or null. */
  withholding_ref: string | null;
  created_at: string;
};

/**
 * The double-taxation treaty rate of record per (source, residence) pair —
 * the withholding engine's lookup. Both codes are ISO alpha-2 uppercase.
 * UNIQUE per the pair: a re-registration converges (the newest rate governs).
 */
export type LicensingTreatyRateRecord = {
  id: string;
  /** The sale's source country (the withholding territory). */
  source_country: string;
  /** The payee's residence country. */
  residence_country: string;
  /** The treaty's withholding rate, whole basis points (US-GB 0, US-JP 1000). */
  rate_bps: number;
  /** The treaty's provenance (the instrument of record). */
  treaty_ref: string;
  created_at: string;
  updated_at: string;
};

/**
 * The registered regional sub-licensee of record — a master license's
 * grant-out. UNIQUE per (scope_key, sub_licensee_id): one region of record
 * per sub-licensee per master license; the region must cover the report
 * row's territory (the cascade refuses a mismatch, fail-closed).
 */
export type LicensingSubLicenseeRecord = {
  id: string;
  /** The master deal's scope (`license:<license_id>`). */
  scope_key: string;
  /** The sub-licensee's identity as the manifests name it. */
  sub_licensee_id: string;
  /** The granted region of record (ISO alpha-2). */
  region_code: string;
  /** THE MASTER ROYALTY OVERRIDE — bps of the sub-licensee's Net Licensed
   * Sales that pays the master licensor, replacing the tier walk for the
   * sub-licensed region's money. */
  master_override_bps: number;
  payee_id: string;
  payee_name: string;
  created_at: string;
  updated_at: string;
};

/** The sub-license gross report's audit states — fail-closed like the
 * promoter settlement audit close (0035): 'unknown' refuses the release,
 * only 'reconciled' passes. */
export const LICENSING_SUB_LICENSE_AUDIT_STATES = ["unknown", "reconciled"] as const;
export type LicensingSubLicenseAuditState = (typeof LICENSING_SUB_LICENSE_AUDIT_STATES)[number];

/**
 * One regional sub-licensee gross report of record — the cascade's tracked
 * fact. The master override royalty is computed at write time from the
 * report's own recorded legs; the net proceeds release reads the audit
 * state fail-closed and the holding post's per-source replay guard makes
 * the release once-only.
 */
export type LicensingSubLicenseReportRecord = {
  id: string;
  scope_key: string;
  sub_licensee_id: string;
  region_code: string;
  /** The statement's reporting period (YYYY-MM). */
  period: string | null;
  /** The funding queue row's event id — UNIQUE, the once-only key. */
  source_event_id: string;
  gross_cents: number;
  trade_discount_cents: number;
  returned_goods_cents: number;
  shipping_freight_cents: number;
  vat_cents: number;
  /** Net Licensed Sales — gross minus the four deduction legs, exact. */
  net_sales_cents: number;
  /** The override of record applied (the sub-licensee registration's). */
  master_override_bps: number;
  /** floor(net_sales × override / 10000) — the master licensor's royalty. */
  master_royalty_cents: number;
  audit_state: LicensingSubLicenseAuditState;
  evidence_ref: string | null;
  reconciled_by: string | null;
  created_at: string;
  updated_at: string;
};

/** The agency commission's founder band — 15% to 35% of earned gross royalties. */
export const LICENSING_AGENCY_MIN_BPS = 1500;
export const LICENSING_AGENCY_MAX_BPS = 3500;

export function validateAgencyCommissionBps(bps: number): string | null {
  if (!Number.isInteger(bps) || bps < LICENSING_AGENCY_MIN_BPS || bps > LICENSING_AGENCY_MAX_BPS) {
    return (
      `The agency commission must sit inside the founder band ` +
      `${LICENSING_AGENCY_MIN_BPS}–${LICENSING_AGENCY_MAX_BPS} bps of earned gross royalties.`
    );
  }
  return null;
}

/** ISO alpha-2 country code of record (the treaty keys' vocabulary). */
export function validateLicensingCountryCode(code: string): string | null {
  if (!/^[A-Z]{2}$/.test(code)) {
    return "A country of record is a two-letter ISO alpha-2 code.";
  }
  return null;
}
