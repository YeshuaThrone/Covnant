/**
 * The software revenue record vocabulary (PR 45, migration 0049) — the
 * founder software directive's durable facts of record for developer IP
 * payout protection:
 *
 *   software_audit_escrow_policies   — one scope's escrow policy of
 *                                      record: the founder-banded 5–10%
 *                                      share of the scope's developer IP
 *                                      payouts that locks into the
 *                                      SOFTWARE_AUDIT_ESCROW bucket at
 *                                      routing.
 *   software_audit_escrow_drawdowns  — the append-only escrow spend of
 *                                      record: uptime outage penalty
 *                                      refunds, API rate-limit breach
 *                                      credits, and quarterly security
 *                                      compliance audits.
 *   software_audit_escrow_reconciliations — the verified reconciliation
 *                                      of record per escrow bucket (the
 *                                      release gate's key).
 *   software_payout_gate_states      — the two durable states the
 *                                      software payout gate reads per
 *                                      (payee, API endpoint).
 *
 * Money is integer cents throughout; rates are basis points where they
 * price a share of a money basis. No foreign keys by design — the tables
 * key on the lane's developer/endpoint identifiers, content-derived
 * event ids, and ledger transaction ids (the 0036–0048 discipline).
 */

// ---------------------------------------------------------------------------
// Vocabulary — the bounded sets, byte-identical to the SQL CHECKs where a
// column carries both (the PR 129/130 lesson: drift between the engine's
// union and the schema's CHECK is a production rejection waiting to fire).
// ---------------------------------------------------------------------------

/** The SOFTWARE_AUDIT_ESCROW's three drawdown classes of record — exactly
 * the exposures the founder directive names: uptime outage penalty
 * refunds, API rate-limit breach credits, and quarterly security
 * compliance audits. Anything else refuses. This array is the TS side of
 * the vocabulary the SQL CHECKs enforce byte-identically (migration 0049;
 * the PR 129/130 lesson — verified byte-identical before CI). */
export const SOFTWARE_AUDIT_ESCROW_DRAWDOWN_CLASSES = [
  "uptime_outage_penalty_refund",
  "api_rate_limit_breach_credit",
  "quarterly_security_compliance_audit",
] as const;
export type SoftwareAuditEscrowDrawdownClass =
  (typeof SOFTWARE_AUDIT_ESCROW_DRAWDOWN_CLASSES)[number];

/**
 * The software payout gate's states of record for one payee on one API
 * endpoint (migration 0049) — the two states the payout gate's software
 * case reads, fail-closed: `api_uptime_sla_verified` is true only when
 * the SLA state is 'verified', `software_security_audit_cleared` is true
 * only when the audit state is 'verified'; an absent record resolves null
 * and 'unknown' resolves false.
 */
export interface SoftwarePayoutGateStateRecord {
  readonly id: string;
  /** The payout's beneficiary of record (the developer). */
  readonly payee_id: string;
  /** The API endpoint whose uptime SLA governs the payout. */
  readonly api_endpoint_id: string;
  /** API uptime SLA verification over the endpoint. */
  readonly api_uptime_sla_state: "unknown" | "verified";
  /** Security audit clearance over the developer's product. */
  readonly security_audit_state: "unknown" | "verified";
  /** The verification evidence of record. */
  readonly evidence_ref: string;
  /** Who verified the states of record. */
  readonly verified_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** One scope's escrow rate of record (migration 0049) — a founder-banded
 * 500–1000 bps share of the scope's developer IP payouts that locks into
 * the SOFTWARE_AUDIT_ESCROW bucket at routing. */
export interface SoftwareAuditEscrowPolicyRecord {
  readonly id: string;
  /** `developer:{developerId}:endpoint:{apiEndpointId}` — the scope key
   * the escrow's sentinel payee and GL account cite (the software lane's
   * own identifier space, the same identity columns the 0048 developer
   * tables key on). */
  readonly scope_key: string;
  /** The founder band: 500–1000 bps, checked at registration and again
   * at use (a hostile policy out-of-band refuses). */
  readonly reserve_rate_bps: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** One position-locked escrow drawdown (migration 0049) — append-only.
 * UNIQUE per (reserve_ledger_id, source_event_id) is the replay guard;
 * UNIQUE per (reserve_ledger_id, drawn_before_cents) is the position lock
 * the balance is derived from. */
export interface SoftwareAuditEscrowDrawdownRecord {
  readonly id: string;
  /** The escrow bucket's ledger_transactions row of record. */
  readonly reserve_ledger_id: string;
  readonly scope_key: string;
  readonly drawdown_class: SoftwareAuditEscrowDrawdownClass;
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
 * 0049) — insert-as-lock, one per bucket: the release refuses fail-closed
 * until this row exists. */
export interface SoftwareAuditEscrowReconciliationRecord {
  readonly id: string;
  readonly reserve_ledger_id: string;
  /** The reconciliation evidence of record (report ref, export hash). */
  readonly evidence_ref: string;
  /** Who verified the reconciliation of record. */
  readonly reconciled_by: string;
  readonly created_at: string;
}

/** The software audit escrow's scope key — injective in the (developer,
 * API endpoint) pair, the same identifier space the 0048 developer lane
 * keys on. The sentinel payee id, GL account, and policy row all cite
 * it. */
export function softwareAuditEscrowScopeKey(
  developerId: string,
  apiEndpointId: string,
): string {
  return `developer:${developerId}:endpoint:${apiEndpointId}`;
}
