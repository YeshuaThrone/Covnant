/**
 * The culinary audit escrow record vocabulary (PR 41, the founder culinary
 * directive) — the culinary twin of the fitness escrow's records
 * (migration 0043): the per-(chef, ghost kitchen) escrow policy, the
 * position-locked drawdowns (customer refund allowances, food spoilage
 * chargebacks, quarterly ingredient supplier quality audits), the verified
 * reconciliation of record, the culinary payout gate's fail-closed states,
 * and the virtual-brand pop-up decommissioning facts (the post-campaign
 * packaging write-off that gates a pop-up scope's release).
 */

/** The escrow's three drawdown classes of record — exactly the exposures
 * the founder directive names. Anything else refuses. This array is the
 * TS side of the vocabulary the SQL CHECKs enforce byte-identically
 * (migration 0045; the PR 129 lesson). */
export const CULINARY_AUDIT_ESCROW_DRAWDOWN_CLASSES = [
  "refund_allowance",
  "spoilage_chargeback",
  "supplier_quality_audit",
] as const;
export type CulinaryAuditEscrowDrawdownClass =
  (typeof CULINARY_AUDIT_ESCROW_DRAWDOWN_CLASSES)[number];

/** One scope's escrow rate of record (migration 0045) — a founder-banded
 * 500–1000 bps share of the scope's culinary IP payouts that locks into
 * the CULINARY_AUDIT_ESCROW bucket at routing. */
export interface CulinaryAuditEscrowPolicyRecord {
  readonly id: string;
  /** `chef:{chefId}:kitchen:{locationCode}` — the scope key the escrow's
   * sentinel payee and GL account cite. */
  readonly scope_key: string;
  /** The founder band: 500–1000 bps, checked at registration and again
   * at use (a hostile policy out-of-band refuses). */
  readonly reserve_rate_bps: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** One position-locked escrow drawdown (migration 0045) — append-only.
 * UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard;
 * UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position lock
 * the balance is derived from. */
export interface CulinaryAuditEscrowDrawdownRecord {
  readonly id: string;
  /** The escrow bucket's ledger_transactions row of record. */
  readonly reserve_ledger_id: string;
  readonly scope_key: string;
  readonly drawdown_class: CulinaryAuditEscrowDrawdownClass;
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
 * 0045) — insert-as-lock, one per bucket: the release refuses fail-closed
 * until this row exists. */
export interface CulinaryAuditEscrowReconciliationRecord {
  readonly id: string;
  readonly reserve_ledger_id: string;
  /** The reconciliation evidence of record (report ref, export hash). */
  readonly evidence_ref: string;
  /** Who verified the reconciliation of record. */
  readonly reconciled_by: string;
  readonly created_at: string;
}

/**
 * The culinary payout gate's states of record for one payee in one ghost
 * kitchen location (migration 0045) — the two states the payout gate's
 * culinary case reads, fail-closed: `health_inspection_cleared` is true
 * only when the health state is 'cleared',
 * `territorial_kitchen_exclusivity_verified` is true only when the
 * exclusivity state is 'verified'; an absent record resolves null and
 * 'unknown' resolves false.
 */
export interface CulinaryPayoutGateStateRecord {
  readonly id: string;
  /** The payout's beneficiary of record (the chef). */
  readonly payee_id: string;
  /** The ghost kitchen location whose exclusivity terms govern the payout. */
  readonly ghost_kitchen_location_code: string;
  /** Health inspection clearance over the kitchen's operation. */
  readonly health_inspection_state: "unknown" | "cleared";
  /** Territorial kitchen exclusivity verification. */
  readonly territorial_exclusivity_state: "unknown" | "verified";
  /** The verification evidence of record. */
  readonly evidence_ref: string;
  /** Who verified the states of record. */
  readonly verified_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

// --------------------------------------------------------------------------
// Virtual brand franchise decommissioning (PR 41): a temporary viral-menu
// pop-up — a 30-day limited time offer, a seasonal menu residency —
// registers its campaign window of record, and its post-campaign
// packaging inventory write-off is a fact of record the pop-up scope's
// escrow release reads, fail-closed: no write-off of record, no release.
// --------------------------------------------------------------------------

/** One pop-up campaign's registration of record (migration 0045) —
 * insert-as-lock on popup_ref: the FIRST registration wins; a re-shipped
 * sheet or a lost race throws. */
export interface CulinaryPopupExperienceRecord {
  readonly id: string;
  /** The pop-up campaign's identity of record — the scope key cites it. */
  readonly popup_ref: string;
  readonly chef_id: string;
  readonly ghost_kitchen_location_code: string;
  /** The viral menu's theme of record (the campaign's name). */
  readonly menu_theme: string;
  /** The campaign window of record (window_end >= window_start, CHECK). */
  readonly window_start_date: string;
  readonly window_end_date: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** One post-campaign packaging inventory write-off (migration 0045) —
 * append-only, UNIQUE per (popup_experience_id, source_event_id) — the
 * replay guard; never a double-priced write-off. */
export interface CulinaryPopupWriteoffRecord {
  readonly id: string;
  readonly popup_experience_id: string;
  /** The write-off calculation's identity of record — the replay guard. */
  readonly source_event_id: string;
  /** The counted unsold campaign packaging units of record. */
  readonly unsold_packages: number;
  /** The packaging unit cost of record (integer cents). */
  readonly unit_cost_cents: number;
  /** unsold_packages × unit_cost_cents, pinned in a CHECK. */
  readonly writeoff_cents: number;
  /** The write-off evidence of record (count sheet, inventory export). */
  readonly evidence_ref: string;
  /** Who calculated the write-off of record. */
  readonly calculated_by: string;
  readonly created_at: string;
}

/** The culinary audit escrow's scope key — injective in the (chef, ghost
 * kitchen) pair, the same identifier space the 0044 food lane keys on.
 * The sentinel payee id, GL account, and policy row all cite it. */
export function culinaryAuditEscrowScopeKey(
  chefId: string,
  ghostKitchenLocationCode: string,
): string {
  return `chef:${chefId}:kitchen:${ghostKitchenLocationCode}`;
}

/** A pop-up scope's escrow key — the campaign-window twin of the base
 * scope, the way the spatial lane scopes a pop-up park to its venue. */
export function culinaryPopupScopeKey(
  chefId: string,
  ghostKitchenLocationCode: string,
  popupRef: string,
): string {
  return `chef:${chefId}:kitchen:${ghostKitchenLocationCode}:popup:${popupRef}`;
}

/** True when a scope key is a pop-up scope (the release path reads its
 * packaging write-off of record; a base scope never does). */
export function isCulinaryPopupScope(scopeKey: string): boolean {
  return scopeKey.includes(":popup:");
}
