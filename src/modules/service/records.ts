/**
 * The service revenue record vocabulary (PR 42, migration 0046) — the
 * founder service directive's durable facts of record for salon, med-spa,
 * and hospitality franchise reconciliation:
 *
 *   service_franchise_schedules        — the franchise contract's
 *                                        commission and royalty terms of
 *                                        record per location: the master
 *                                        franchisor royalty, the
 *                                        technician service commission,
 *                                        and the house location margin
 *                                        (the founder's 5 / 45 / 50
 *                                        example), configurable per
 *                                        franchise contract.
 *   service_protocol_policies          — the per-treatment micro-fee of
 *                                        record per protocol: the
 *                                        protocol creator payee (the
 *                                        master esthetician or celebrity
 *                                        dermatologist) and the
 *                                        per-execution license fee.
 *   service_redemption_policies        — the cross-location redemption
 *                                        split's terms of record per home
 *                                        location: the franchisor royalty
 *                                        and home-location administrative
 *                                        cut taken off a redemption's
 *                                        service allocation fee (the
 *                                        visiting location routes the
 *                                        residual).
 *   service_breakage_policies          — the contractual breakage split's
 *                                        terms of record per home
 *                                        location: the franchisor and
 *                                        franchisee shares of unredeemed
 *                                        monthly subscription funds.
 *   service_rebate_waterfalls          — the location's rebate routing
 *                                        legs of record: the proportional
 *                                        shares a distributor's volume
 *                                        rebate routes back through to
 *                                        franchise location ledgers.
 *   service_booth_lease_policies       — the hybrid salon's booth-lease
 *                                        terms of record per location:
 *                                        the studio owner payee and the
 *                                        retail commission rate (the
 *                                        weekly flat chair rent is
 *                                        isolated from it).
 *   service_realization_applications   — the append-only Net Service
 *                                        Realization per service ticket
 *                                        event.
 *   service_franchise_split_applications — the append-only three-way
 *                                        gross partition per ticket
 *                                        event.
 *   service_protocol_micro_royalties   — the append-only per-treatment
 *                                        license fee per logged branded
 *                                        treatment.
 *   service_redemption_split_applications — the append-only cross-location
 *                                        redemption routing per
 *                                        redemption event.
 *   service_breakage_allocations       — the append-only unredeemed-funds
 *                                        split per breakage event.
 *   service_rebate_applications        — the append-only proportional
 *                                        rebate routing per rebate event.
 *   service_booth_lease_applications   — the append-only isolated
 *                                        chair-rent / retail-commission
 *                                        legs per booth-lease event.
 *
 * Money is integer cents throughout; per-treatment royalty rates are
 * statement micros (1 dollar = 1e8 micros) so sub-cent per-treatment
 * pricing stays exact. Rates are basis points where they price a share of
 * a money basis. No foreign keys by design — the tables key on
 * content-derived event ids, the feed's stylist/protocol/location
 * identifiers, and reporting months (the 0036–0045 discipline).
 */

// ---------------------------------------------------------------------------
// Vocabulary — the bounded sets, byte-identical to the SQL CHECKs where a
// column carries both (the PR 129/130 lesson: drift between the engine's
// union and the schema's CHECK is a production rejection waiting to fire).
// ---------------------------------------------------------------------------

/** The salon and spa POS platforms of record — the directive's four named
 * ticket streams. Profile-side vocabulary only; the platform never
 * constrains a column in SQL. */
export type ServicePosPlatform = "mindbody" | "boulevard" | "zenoti" | "square";

/** The bulk backbar distributors of record — the directive's two named
 * rebate programs. Byte-identical to the vendor rebate applications'
 * SQL CHECK. */
export type ServiceDistributor = "loreal" | "estee_lauder";

/** The booth-lease application's isolated legs of record. Byte-identical
 * to the booth lease applications' SQL CHECK. */
export type ServiceBoothLeaseLegKind = "chair_rent" | "retail_commission";

/** The service lane's application verdict of record. `paid` — the pool or
 * split priced and committed; `held_negative_net` — the realization's
 * deduction legs exceeded the gross ticket, the money pauses visible
 * (never dropped, never guessed into a route). Byte-identical to the
 * realization applications' SQL CHECK. */
export type ServiceApplicationVerdict = "paid" | "held_negative_net";

// ---------------------------------------------------------------------------
// Validators — every schedule and policy of record re-validated at read;
 // an unvalidated record is a counted fail-closed skip, never a guessed rate.
// ---------------------------------------------------------------------------

/**
 * Validates a franchise contract's three percentage legs at registration —
 * every rate a non-negative integer bps and the three legs partition the
 * gross EXACTLY (they sum to 10000 bps: the founder's 5% + 45% + 50%
 * example). A schedule that fails any clause is a hostile registration,
 * refused (the walk never guesses a split).
 */
export function validateServiceFranchiseLegs(input: {
  masterFranchisorRoyaltyBps: number;
  technicianCommissionBps: number;
  houseMarginBps: number;
}): { ok: true } | { ok: false; reason: string } {
  const { masterFranchisorRoyaltyBps, technicianCommissionBps, houseMarginBps } = input;
  for (const [name, bps] of [
    ["master_franchisor_royalty", masterFranchisorRoyaltyBps],
    ["technician_commission", technicianCommissionBps],
    ["house_margin", houseMarginBps],
  ] as const) {
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      return { ok: false, reason: `${name}_bps_out_of_range` };
    }
  }
  if (masterFranchisorRoyaltyBps + technicianCommissionBps + houseMarginBps !== 10_000) {
    return { ok: false, reason: "legs_do_not_sum_to_10000" };
  }
  return { ok: true };
}

/**
 * Validates a home location's redemption split terms at registration —
 * both rates non-negative integer bps summing to AT MOST 10000 (the
 * visiting location routes the residual; a sum past 10000 would owe more
 * than the fee). A policy that fails any clause is refused.
 */
export function validateServiceRedemptionBps(input: {
  franchisorRoyaltyBps: number;
  homeAdminBps: number;
}): { ok: true } | { ok: false; reason: string } {
  const { franchisorRoyaltyBps, homeAdminBps } = input;
  for (const [name, bps] of [
    ["franchisor_royalty", franchisorRoyaltyBps],
    ["home_admin", homeAdminBps],
  ] as const) {
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      return { ok: false, reason: `${name}_bps_out_of_range` };
    }
  }
  if (franchisorRoyaltyBps + homeAdminBps > 10_000) {
    return { ok: false, reason: "legs_sum_past_10000" };
  }
  return { ok: true };
}

/**
 * Validates a home location's breakage split terms at registration — both
 * rates non-negative integer bps summing to EXACTLY 10000 (the unredeemed
 * funds allocate fully across the two contractual legs). A policy that
 * fails any clause is refused.
 */
export function validateServiceBreakageLegs(input: {
  franchisorBreakageBps: number;
  franchiseeBreakageBps: number;
}): { ok: true } | { ok: false; reason: string } {
  const { franchisorBreakageBps, franchiseeBreakageBps } = input;
  for (const [name, bps] of [
    ["franchisor_breakage", franchisorBreakageBps],
    ["franchisee_breakage", franchiseeBreakageBps],
  ] as const) {
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      return { ok: false, reason: `${name}_bps_out_of_range` };
    }
  }
  if (franchisorBreakageBps + franchiseeBreakageBps !== 10_000) {
    return { ok: false, reason: "legs_do_not_sum_to_10000" };
  }
  return { ok: true };
}

/** One routing leg of a location's distributor rebate waterfall of record. */
export type ServiceRebateWaterfallLeg = {
  readonly ledger_id: string;
  readonly weight_bps: number;
};

/**
 * Validates a location's rebate waterfall at read — non-empty, unique
 * ledger ids, every weight a positive integer bps in band, and the weights
 * summing to EXACTLY 10000 (the routing conserves the rebate). An
 * unvalidated or absent waterfall is a counted fail-closed skip; the
 * routing never guesses a share.
 */
export function validateServiceRebateWaterfall(
  legs: readonly ServiceRebateWaterfallLeg[],
): { ok: true } | { ok: false; reason: string } {
  if (legs.length === 0) return { ok: false, reason: "empty_waterfall" };
  const seen = new Set<string>();
  let weightSum = 0;
  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index] as ServiceRebateWaterfallLeg;
    if (leg.ledger_id === "") {
      return { ok: false, reason: `leg_${index}:ledger_empty` };
    }
    if (seen.has(leg.ledger_id)) {
      return { ok: false, reason: `leg_${index}:duplicate_ledger` };
    }
    seen.add(leg.ledger_id);
    if (!Number.isInteger(leg.weight_bps) || leg.weight_bps <= 0 || leg.weight_bps > 10_000) {
      return { ok: false, reason: `leg_${index}:weight_bps_out_of_range` };
    }
    weightSum += leg.weight_bps;
  }
  if (weightSum !== 10_000) {
    return { ok: false, reason: "weights_do_not_sum_to_10000" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The records.
// ---------------------------------------------------------------------------

/** The franchise contract's commission and royalty terms of record per
 * salon location — the master franchisor royalty, the technician service
 * commission, and the house location margin, the three legs partitioning
 * the gross service ticket exactly (validated at registration and
 * re-validated at every read). */
export type ServiceFranchiseScheduleRecord = {
  id: string;
  salon_location_id: string;
  master_franchisor_royalty_bps: number;
  technician_commission_bps: number;
  house_margin_bps: number;
  created_at: string;
  updated_at: string;
};

/** The per-treatment micro-fee policy of record per protocol — the
 * protocol creator payee (the master esthetician or celebrity
 * dermatologist) and the per-execution license fee. */
export type ServiceProtocolPolicyRecord = {
  id: string;
  protocol_id: string;
  payee_id: string;
  micros_per_treatment: number;
  created_at: string;
  updated_at: string;
};

/** The cross-location redemption split's terms of record per home
 * location — the franchisor royalty and home-location administrative cut
 * taken off a redemption's service allocation fee (the visiting location
 * routes the residual). */
export type ServiceRedemptionPolicyRecord = {
  id: string;
  home_location_id: string;
  franchisor_royalty_bps: number;
  home_admin_bps: number;
  created_at: string;
  updated_at: string;
};

/** The breakage split's terms of record per home location — the
 * contractual franchisor and franchisee shares of unredeemed monthly
 * subscription funds. */
export type ServiceBreakagePolicyRecord = {
  id: string;
  home_location_id: string;
  franchisor_breakage_bps: number;
  franchisee_breakage_bps: number;
  created_at: string;
  updated_at: string;
};

/** One routing leg of a location's distributor rebate waterfall of record
 * — the proportional share a volume rebate routes to a franchise location
 * ledger. */
export type ServiceRebateWaterfallRecord = {
  id: string;
  salon_location_id: string;
  ledger_id: string;
  weight_bps: number;
  created_at: string;
  updated_at: string;
};

/** The hybrid salon's booth-lease terms of record per location — the
 * studio owner payee and the retail product sales commission rate (the
 * weekly flat chair rent routes around it). */
export type ServiceBoothLeasePolicyRecord = {
  id: string;
  salon_location_id: string;
  chair_rent_payee_id: string;
  retail_commission_bps: number;
  created_at: string;
  updated_at: string;
};

/** The per-event Net Service Realization of record — the founder's exact
 * identity keyed on the stylist_id, protocol_id, and salon_location_id
 * columns:
 *
 *   Net Realized Service Pool =
 *     gross service ticket
 *     − backbar product COGS
 *     − credit card processing engine cut
 *     − local service and sales taxes
 */
export type ServiceRealizationApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  /** The sender family whose sheet the row came from. */
  sender: "pos_ticket" | "hotel_folio";
  stylist_id: string;
  protocol_id: string;
  salon_location_id: string;
  period: string;
  currency: string;
  gross_service_ticket_cents: number;
  backbar_product_cogs_cents: number;
  card_processing_engine_cut_cents: number;
  service_sales_taxes_cents: number;
  /** gross − backbar COGS − card cut − taxes — the identity pinned in a
   * CHECK. */
  net_realized_service_pool_cents: number;
  verdict: ServiceApplicationVerdict;
  created_at: string;
};

/** The per-event franchise split of record — the gross service ticket's
 * three contractual routes (master franchisor royalty, technician service
 * commission, house location margin) partitioning the gross exactly at
 * the schedule of record. */
export type ServiceFranchiseSplitApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  /** The sender family whose sheet the row came from. */
  sender: "pos_ticket" | "hotel_folio";
  stylist_id: string;
  protocol_id: string;
  salon_location_id: string;
  period: string;
  currency: string;
  /** The gross service ticket of record — the split's basis. */
  gross_service_ticket_cents: number;
  /** The schedule of record the split priced at. */
  schedule_ref: string;
  master_franchisor_royalty_bps: number;
  /** floor(gross × bps / 10000). */
  master_franchisor_royalty_cents: number;
  technician_commission_bps: number;
  /** floor(gross × bps / 10000). */
  technician_commission_cents: number;
  house_margin_bps: number;
  /** The residual route — gross − royalty − commission (the house
   * location margin absorbs the floor dust). */
  house_margin_cents: number;
  created_at: string;
};

/** The per-event protocol micro-royalty of record — the per-treatment
 * license fee routed to the protocol creator every time a franchised
 * location logs the branded treatment. */
export type ServiceProtocolMicroRoyaltyRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  /** The sender family whose sheet the row came from. */
  sender: "pos_ticket" | "hotel_folio";
  stylist_id: string;
  protocol_id: string;
  salon_location_id: string;
  period: string;
  currency: string;
  /** The protocol creator payee of record. */
  payee_id: string;
  micros_per_treatment: number;
  /** One treatment per logged row — the fee is exact micros. */
  royalty_micros: number;
  royalty_cents: number;
  created_at: string;
};

/** The per-event cross-location redemption split of record — the service
 * allocation fee's contractual routes: the franchisor royalty and the
 * home-location administrative cut distribute, and the visiting location
 * routes the residual. */
export type ServiceRedemptionSplitApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  member_id: string;
  home_location_id: string;
  visiting_location_id: string;
  period: string;
  currency: string;
  /** The service allocation fee of record — the split's basis. */
  service_allocation_fee_cents: number;
  franchisor_royalty_bps: number;
  /** floor(fee × bps / 10000). */
  franchisor_royalty_cents: number;
  home_admin_bps: number;
  /** floor(fee × bps / 10000). */
  home_admin_cents: number;
  /** fee − royalty − admin — the visiting location's route of record. */
  visiting_location_cents: number;
  created_at: string;
};

/** The per-event breakage allocation of record — the unredeemed monthly
 * subscription funds split per the contractual franchisor and franchisee
 * breakage rules. */
export type ServiceBreakageAllocationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  member_id: string;
  home_location_id: string;
  period: string;
  currency: string;
  /** The unredeemed funds of record — the split's basis. */
  unredeemed_amount_cents: number;
  franchisor_breakage_bps: number;
  /** floor(unredeemed × bps / 10000). */
  franchisor_breakage_cents: number;
  /** The residual route — unredeemed − franchisor share. */
  franchisee_breakage_cents: number;
  created_at: string;
};

/** One proportional routing leg — the rebate application's committed
 * ledger share (largest-remainder exact). */
export type ServiceRebateRoutingLeg = {
  readonly ledger_id: string;
  readonly weight_bps: number;
  /** The leg's allocated share, integer cents. */
  readonly routed_cents: number;
};

/** The per-event distributor rebate routing of record — the bulk backbar
 * purchasing kickback (L'Oréal, Estée Lauder) passed proportionally back
 * to the franchise location ledgers. */
export type ServiceRebateApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  /** The distributor whose rebate program the row reports. */
  distributor: ServiceDistributor;
  salon_location_id: string;
  period: string;
  currency: string;
  /** The rebate program's purchase basis of record. */
  rebate_basis_cents: number;
  /** The volume kickback of record — the routing's pot. */
  volume_rebate_cents: number;
  /** The committed routing — JSON-encoded ServiceRebateRoutingLeg[]. */
  routing_legs: string;
  /** The legs' routed shares conserve the rebate exactly (pinned). */
  routed_total_cents: number;
  created_at: string;
};

/** The per-event booth-lease split of record — the isolated legs: the
 * weekly flat chair rent routes exact to the studio owner (never
 * commissioned) and the retail product sales route their floored
 * commission (never the flat rent). */
export type ServiceBoothLeaseApplicationRecord = {
  id: string;
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  salon_location_id: string;
  period: string;
  currency: string;
  /** The isolated leg of record — the rent or the commission. */
  leg_kind: ServiceBoothLeaseLegKind;
  /** The row's money basis of record (the rent payment or the retail
   * sale). */
  gross_cents: number;
  /** The retail commission rate applied (0 on chair-rent legs). */
  retail_commission_bps: number;
  /** The studio owner's released funds for the leg — the rent exact, the
   * commission floored (pinned in a CHECK). */
  studio_owner_cents: number;
  created_at: string;
};

// ---------------------------------------------------------------------------
// The service audit escrow (PR 43, the founder services directive) — the
// services twin of the NIL / spatial / fitness / culinary audit escrows:
// a founder-banded 5–10% share of a franchise service payout locks into
// the SERVICE_AUDIT_ESCROW per (stylist, salon location) scope while the
// location's compliance exposure runs, client refund allowances, product
// return chargebacks, and quarterly backbar inventory audits draw it down
// position-locked, and the verified reconciliation of record opens the
// release (fail-closed: no reconciliation of record, no release).
// ---------------------------------------------------------------------------

/** The escrow's three drawdown classes of record — exactly the exposures
 * the founder directive names. Anything else refuses. This array is the
 * TS side of the vocabulary the SQL CHECKs enforce byte-identically
 * (migration 0047; the PR 129/130 lesson). */
export const SERVICE_AUDIT_ESCROW_DRAWDOWN_CLASSES = [
  "refund_allowance",
  "product_return_chargeback",
  "backbar_inventory_audit",
] as const;
export type ServiceAuditEscrowDrawdownClass =
  (typeof SERVICE_AUDIT_ESCROW_DRAWDOWN_CLASSES)[number];

/** One scope's escrow rate of record (migration 0047) — a founder-banded
 * 500–1000 bps share of the scope's franchise service payouts that locks
 * into the SERVICE_AUDIT_ESCROW bucket at routing. */
export interface ServiceAuditEscrowPolicyRecord {
  readonly id: string;
  /** `stylist:{stylistId}:location:{salonLocationId}` — the scope key the
   * escrow's sentinel payee and GL account cite (the service lane's own
   * identifier space, the same columns the 0046 tables key on). */
  readonly scope_key: string;
  /** The founder band: 500–1000 bps, checked at registration and again
   * at use (a hostile policy out-of-band refuses). */
  readonly reserve_rate_bps: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** One position-locked escrow drawdown (migration 0047) — append-only.
 * UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard;
 * UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position lock
 * the balance is derived from. */
export interface ServiceAuditEscrowDrawdownRecord {
  readonly id: string;
  /** The escrow bucket's ledger_transactions row of record. */
  readonly reserve_ledger_id: string;
  readonly scope_key: string;
  readonly drawdown_class: ServiceAuditEscrowDrawdownClass;
  /** The drawing event's identity of record — the replay guard. */
  readonly source_event_id: string;
  /** The bucket balance this draw was taken against (the spend position). */
  readonly drawn_before_cents: number;
  /** The drawn amount: 0 < drawn_cents <= drawn_before_cents. */
  readonly drawn_cents: number;
  /** drawn_before_cents - drawn_cents, pinned in a CHECK. */
  readonly remaining_cents: number;
  readonly created_at: string;
}

/** The verified reconciliation of record for one escrow bucket (migration
 * 0047) — insert-as-lock, one per bucket: the release refuses fail-closed
 * until this row exists. */
export interface ServiceAuditEscrowReconciliationRecord {
  readonly id: string;
  readonly reserve_ledger_id: string;
  /** The reconciliation evidence of record (report ref, export hash). */
  readonly evidence_ref: string;
  /** Who verified the reconciliation of record. */
  readonly reconciled_by: string;
  readonly created_at: string;
}

/**
 * The services payout gate's states of record for one payee in one salon
 * location (migration 0047) — the two states the payout gate's services
 * case reads, fail-closed: `health_board_license_verified` is true only
 * when the license state is 'verified',
 * `territorial_franchise_exclusivity_verified` is true only when the
 * exclusivity state is 'verified'; an absent record resolves null and
 * 'unknown' resolves false.
 */
export interface ServicesPayoutGateStateRecord {
  readonly id: string;
  /** The payout's beneficiary of record (the stylist). */
  readonly payee_id: string;
  /** The salon location whose franchise exclusivity terms govern the
   * payout. */
  readonly salon_location_id: string;
  /** Health board licensing over the location's operation. */
  readonly health_license_state: "unknown" | "verified";
  /** Territorial franchise exclusivity verification. */
  readonly territorial_exclusivity_state: "unknown" | "verified";
  /** The verification evidence of record. */
  readonly evidence_ref: string;
  /** Who verified the states of record. */
  readonly verified_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** The service audit escrow's scope key — injective in the (stylist,
 * salon location) pair, the same identifier space the 0046 service lane
 * keys on. The sentinel payee id, GL account, and policy row all cite it. */
export function serviceAuditEscrowScopeKey(
  stylistId: string,
  salonLocationId: string,
): string {
  return `stylist:${stylistId}:location:${salonLocationId}`;
}
