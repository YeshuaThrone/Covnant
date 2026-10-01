// Derivative asset royalty cascade — PR 16 (founder spatial directive).
//
// When a derivative micro-item or mod sells, the allocator walks the
// parent_asset_id dependency tree (the column the recon queue has carried
// since migration 0011) DEPTH-FIRST and distributes fractional royalties to
// the upstream 3D mesh, texture, and code script creators BEFORE allocating
// net profits to the downstream modder. Secondary marketplace resales run
// the identical cascade — the downstream seller's micro-payout is the same
// release path at resale scale.
//
// THE CONTRACT LAYER: migration 0021's derivative_royalty_edges — one row
// per (asset_id, parent_asset_id, upstream_creator_payee_id) carrying the
// edge's royalty_bps (a fraction of the downstream sale's gross). The walk
// reads the table per node (getDerivativeRoyaltyEdgesByAsset); the table's
// insertion order IS the reservation order — the deterministic
// upstream-first sequence. No payout state ships in a table: every cent
// moves through the canonical recon posting seam into UNCLAIMED_HOLDING
// (postToUnclaimedHolding) and releases through releaseUnclaimedHolding's
// clearance-gated settlement path — the ledger rows, GL journals,
// withholding escrow, recoupment sweeps, and the dust-to-platform variance
// sweep are the existing ledger contract. Replay idempotency rides the
// seam's journal-ref guard keyed on the sale event's unique event id —
// content-derived for resales (derivativeResaleEventId, the podcast:bonus:
// precedent), so a re-processed ingest is a 409, never a second credit.
//
// THE THREE MOVES:
//
//   buildDerivativeCascadePlan — the PURE allocator. Depth-first walk from
//                 the sold asset; per edge, in walk order: validate the
//                 contract, check the tree's total contracted bps have not
//                 breached the sale (fail-closed, naming the breaching
//                 edge), reserve floor(royalty_bps × gross / 10000). The
//                 downstream modder's remainder share is computed ONLY
//                 after the walk completes — upstream-first ordering is
//                 structural, not conventional. Cycles (D→P→D and longer)
//                 refuse the plan before a cent moves; diamonds (a DAG
//                 reaches one parent two ways) are NOT cycles — each EDGE
//                 contract fires exactly once (node-expansion dedup), so
//                 both co-holder edges pay. The plan's integer math is the
//                 house allocator's own (allocateWithCompanyDustSweep):
//                 every share floor(bps × gross / 10000), the rounding
//                 residue swept to the platform variance account.
//
//   postDerivativeSaleToHolding — the lane's post. A thin wrapper over the
//                 CANONICAL seam (the posting.ts discipline): the sale
//                 gross posts to UNCLAIMED_HOLDING with source
//                 { type: 'match_queue', event_id } — the quarantined sale
//                 event IS the line item, so the recovery discovery pairs
//                 the held credit with its queue row. No gate is skipped
//                 and no new journal kind is minted.
//
//   releaseDerivativeCascade — the verified release. Finds the sale's HELD
//                 holding credit (by the event id stamped in line_item_id),
//                 builds the plan from the store's edge table, and hands
//                 the upstream-first party list to releaseUnclaimedHolding
//                 — operator settlement approval, Plaid-backed verified
//                 KYC, and the SPATIAL vertical's compliance state
//                 (territorial zoning cleared AND spatial audit verified)
//                 run per credited payee, fail-closed, inside that path.
//                 A refusal anywhere leaves the credit HELD (nothing
//                 moved), never a partial payout.
//
// Upstream creators ride role 'creator' (withholding applies exactly as a
// talent split's does); the downstream seller is a creator too — the
// modder's net is their sale income. The vertical is spatial: the cascade
// pays spatial/location-based-entertainment derivative royalties.

import type { Store } from "@/lib/server/store";
import type { DerivativeRoyaltyEdgeRecord } from "@/modules/don/records";
import { BPS_DENOMINATOR } from "@/modules/don/constants";
import { allocateWithCompanyDustSweep } from "@/modules/don/dust";
import {
  postToUnclaimedHolding,
  releaseUnclaimedHolding,
  type UnclaimedHoldingPostSuccess,
  type UnclaimedHoldingReleaseSuccess,
} from "@/lib/server/unclaimedHolding";
import type { AssetVertical } from "@/modules/compliance/payoutGate";
import type { SplitPartyInput } from "@/lib/don/types";

/** House failure envelope — the unclaimed-holding / VTuber-agency shape. */
export type DerivativeCascadeFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

/** The cascade releases through the spatial vertical's compliance gate. */
export const DERIVATIVE_CASCADE_VERTICAL: AssetVertical = "spatial";

/** One sale's identity — the sold derivative and who sold it. */
export interface DerivativeCascadeSaleInput {
  /** The sold derivative asset — the walk's start node. */
  asset_id: string;
  /** The sale's gross, integer cents. */
  sale_gross_cents: number;
  /** The downstream modder (seller) — the remainder-share payee. */
  seller_payee_id: string;
  seller_payee_name: string;
}

/** One upstream reservation in walk order — the audit trail's row. */
export type DerivativeCascadeReservation = {
  /** 1-based reservation order (the depth-first, upstream-first sequence). */
  step: number;
  /** The contract edge that fired (child → parent). */
  asset_id: string;
  parent_asset_id: string;
  /** The upstream creator paid (id + the contract's name of record). */
  payee_id: string;
  payee_name: string;
  /** The edge's contracted fraction, basis points of the gross. */
  royalty_bps: number;
  /** floor(royalty_bps × gross / 10000) — the house allocator's exact math. */
  royalty_cents: number;
  /** The sale's gross minus every cent reserved through this step. */
  remaining_after_cents: number;
};

export type DerivativeCascadePlan = {
  asset_id: string;
  sale_gross_cents: number;
  /** Every upstream reservation, depth-first (upstream-first) order. */
  reservations: DerivativeCascadeReservation[];
  /** Σ reservation cents — what upstream held before the modder's net. */
  upstream_total_cents: number;
  /**
   * The downstream modder's remainder share: 10000 bps minus every
   * contracted edge — computed ONLY after the walk completed.
   */
  downstream: { payee_id: string; payee_name: string; share_bps: number; net_cents: number };
  /** The integer-cent rounding residue — swept to the platform variance account. */
  company_dust_cents: number;
  /**
   * The release's party list, upstream first and the seller LAST — the
   * ordering releaseUnclaimedHolding walks (and the compliance gate
   * evaluates) when the cascade settles.
   */
  party_splits: SplitPartyInput[];
};

// ---------------------------------------------------------------------------
// Input validation — fail-closed on malformed sales and malformed contracts.
// ---------------------------------------------------------------------------

/**
 * Validates one sale input. Returns the failure, or undefined when the sale
 * is well-formed: integer cents greater than zero, non-empty identities.
 */
export function validateDerivativeSaleInput(
  sale: DerivativeCascadeSaleInput,
): DerivativeCascadeFailure | undefined {
  if (!Number.isSafeInteger(sale.sale_gross_cents) || sale.sale_gross_cents <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_amount",
      message: "Cascade sales post integer cents greater than zero.",
    };
  }
  if (
    sale.asset_id === "" ||
    sale.seller_payee_id === "" ||
    sale.seller_payee_name === ""
  ) {
    return {
      ok: false,
      status: 422,
      code: "invalid_sale_input",
      message: "A cascade sale names the sold asset and the selling payee.",
    };
  }
  return undefined;
}

/** The one contract row's shape check — bps are a safe fraction, ids exist. */
function edgeIsValid(edge: DerivativeRoyaltyEdgeRecord): boolean {
  return (
    Number.isSafeInteger(edge.royalty_bps) &&
    edge.royalty_bps > 0 &&
    edge.royalty_bps <= BPS_DENOMINATOR &&
    edge.asset_id !== "" &&
    edge.parent_asset_id !== "" &&
    edge.upstream_creator_payee_id !== "" &&
    edge.upstream_creator_payee_name !== ""
  );
}

// ---------------------------------------------------------------------------
// The pure planner — the cascade's deterministic core.
// ---------------------------------------------------------------------------

/**
 * Loads every edge the depth-first walk reaches from one asset into a map
 * (the store-backed half of the planner's input). The walk awaits each
 * node's contract rows (getDerivativeRoyaltyEdgesByAsset), applies the SAME
 * path-based cycle detection the planner enforces (fail-closed before any
 * money moves), and dedups node expansion (diamonds stay finite). An asset
 * with no contracts loads an empty map — a pass-through sale, valid.
 */
export async function loadDerivativeRoyaltyEdgeMap(
  store: Store,
  assetId: string,
): Promise<{ ok: true; value: Map<string, DerivativeRoyaltyEdgeRecord[]> } | DerivativeCascadeFailure> {
  const edgesByAsset = new Map<string, DerivativeRoyaltyEdgeRecord[]>();
  const path = new Set<string>();
  const expanded = new Set<string>();

  const walk = async (node: string): Promise<DerivativeCascadeFailure | undefined> => {
    if (path.has(node)) {
      return {
        ok: false,
        status: 422,
        code: "derivative_royalty_cycle",
        message: `The dependency tree for asset "${assetId}" is malformed — the walk reached "${node}" twice on one path (a royalty cycle). Nothing releases from a tree that cannot be walked to the root.`,
      };
    }
    if (expanded.has(node)) return undefined;
    path.add(node);
    expanded.add(node);

    const edges = await store.getDerivativeRoyaltyEdgesByAsset(node);
    edgesByAsset.set(node, edges);
    for (const edge of edges) {
      const upstream = await walk(edge.parent_asset_id);
      if (upstream !== undefined) return upstream;
    }

    path.delete(node);
    return undefined;
  };

  const cycle = await walk(assetId);
  if (cycle !== undefined) return cycle;
  return { ok: true, value: edgesByAsset };
}

/**
 * Builds the cascade plan for one sale over an edge lookup (pure: no store,
 * no clock — tests pin the math with plain fixtures; the store-backed
 * caller preloads the reachable tree with loadDerivativeRoyaltyEdgeMap).
 * The walk:
 *
 *   1. depth-first from the sold asset, each node's edges in the table's
 *      insertion order (the deterministic reservation order),
 *   2. path-based cycle detection — a node repeated on the CURRENT path
 *      (D→P→D, D→P→Q→D, a self-edge) refuses the plan; a diamond is not a
 *      cycle (the node-expansion set dedups re-walking, while each edge
 *      contract still fires exactly once),
 *   3. per edge, in walk order: validate, check the tree's total
 *      contracted bps have not breached 10000 (fail-closed, naming the
 *      breaching edge — upstream reservations consume the sale's
 *      capacity before the downstream remainder exists), reserve
 *      floor(royalty_bps × gross / 10000),
 *   4. THEN the downstream modder's remainder bps — computed only after
 *      every upstream share is reserved,
 *   5. the house allocator does the integer math over the assembled party
 *      list (upstream first, seller last): every share
 *      floor(bps × gross / 10000), the residue is dust to the platform.
 */
export function buildDerivativeCascadePlan(
  sale: DerivativeCascadeSaleInput,
  edgesFor: (assetId: string) => readonly DerivativeRoyaltyEdgeRecord[],
): { ok: true; value: DerivativeCascadePlan } | DerivativeCascadeFailure {
  const invalidSale = validateDerivativeSaleInput(sale);
  if (invalidSale !== undefined) return invalidSale;

  const reservations: DerivativeCascadeReservation[] = [];
  let reservedBps = 0;
  let reservedCents = 0;
  const path = new Set<string>();
  const expanded = new Set<string>();

  const walk = (assetId: string): DerivativeCascadeFailure | undefined => {
    if (path.has(assetId)) {
      return {
        ok: false,
        status: 422,
        code: "derivative_royalty_cycle",
        message: `The dependency tree for asset "${sale.asset_id}" is malformed — the walk reached "${assetId}" twice on one path (a royalty cycle). Nothing releases from a tree that cannot be walked to the root.`,
      };
    }
    // A diamond reaches one parent by two routes: not a cycle — but the
    // node's own contracts must not fire twice (each EDGE contract is one
    // row; expansion dedup keeps the walk finite on DAGs).
    if (expanded.has(assetId)) return undefined;
    path.add(assetId);
    expanded.add(assetId);

    for (const edge of edgesFor(assetId)) {
      if (!edgeIsValid(edge)) {
        return {
          ok: false,
          status: 422,
          code: "derivative_royalty_edge_invalid",
          message: `The royalty contract for edge "${edge.asset_id}" → "${edge.parent_asset_id}" is malformed (bps must be a safe fraction 1..10000 and every field must be present).`,
        };
      }
      if (reservedBps + edge.royalty_bps > BPS_DENOMINATOR) {
        return {
          ok: false,
          status: 422,
          code: "derivative_royalty_exceeds_sale",
          message: `The dependency tree for asset "${sale.asset_id}" contracts more than the sale — edge "${edge.asset_id}" → "${edge.parent_asset_id}" (payee "${edge.upstream_creator_payee_id}") would take the total past 10000 bps (${reservedBps} reserved + ${edge.royalty_bps}). Nothing releases from a tree that promises money the sale does not carry.`,
        };
      }
      const royaltyCents = Math.floor(
        (sale.sale_gross_cents * edge.royalty_bps) / BPS_DENOMINATOR,
      );
      reservedBps += edge.royalty_bps;
      reservedCents += royaltyCents;
      reservations.push({
        step: reservations.length + 1,
        asset_id: edge.asset_id,
        parent_asset_id: edge.parent_asset_id,
        payee_id: edge.upstream_creator_payee_id,
        payee_name: edge.upstream_creator_payee_name,
        royalty_bps: edge.royalty_bps,
        royalty_cents: royaltyCents,
        remaining_after_cents: sale.sale_gross_cents - reservedCents,
      });
      const upstream = walk(edge.parent_asset_id);
      if (upstream !== undefined) return upstream;
    }

    path.delete(assetId);
    return undefined;
  };

  const cycle = walk(sale.asset_id);
  if (cycle !== undefined) return cycle;

  // Upstream-first ordering, enforced structurally: the remainder exists
  // only here — after the walk reserved every upstream share.
  const downstreamShareBps = BPS_DENOMINATOR - reservedBps;

  // The party list assembles from the CONTRACT rows (they carry the payee
  // names of record), upstream first, the seller LAST — the order the
  // release path walks and the compliance gate evaluates.
  const partySplits: SplitPartyInput[] = [
    ...reservations.map(
      (reservation): SplitPartyInput => ({
        payee_id: reservation.payee_id,
        payee_name: reservation.payee_name,
        role: "creator",
        share_bps: reservation.royalty_bps,
      }),
    ),
    {
      payee_id: sale.seller_payee_id,
      payee_name: sale.seller_payee_name,
      role: "creator",
      share_bps: downstreamShareBps,
    },
  ];

  // The house allocator's exact math over the assembled list — the same
  // floor(bps × gross / 10000) per party the release path will recompute.
  const allocation = allocateWithCompanyDustSweep(sale.sale_gross_cents, partySplits);
  if (!allocation.ok) {
    // Unreachable while the walk enforces Σ bps = 10000 — surfaced, never
    // swallowed (a silent fallback here would misroute real money).
    return {
      ok: false,
      status: 500,
      code: "cascade_plan_allocation_failed",
      message: allocation.message,
    };
  }

  const downstreamAllocated =
    allocation.splits[allocation.splits.length - 1]?.amount_cents ?? 0;

  return {
    ok: true,
    value: {
      asset_id: sale.asset_id,
      sale_gross_cents: sale.sale_gross_cents,
      reservations,
      upstream_total_cents: reservedCents,
      downstream: {
        payee_id: sale.seller_payee_id,
        payee_name: sale.seller_payee_name,
        share_bps: downstreamShareBps,
        net_cents: downstreamAllocated,
      },
      company_dust_cents: allocation.company_dust_cents,
      party_splits: partySplits,
    },
  };
}

// ---------------------------------------------------------------------------
// The resale event id — content-derived replay identity (the podcast:bonus:
// precedent). A secondary-marketplace resale has no statement line of its
// own; its id is DERIVED from the sale's content so a re-processed ingest
// derives the SAME id and the canonical seam's journal-ref guard turns the
// replay into a 409, never a second credit.
// ---------------------------------------------------------------------------

/** The inputs a resale's identity is derived from — every field is load-bearing. */
export interface DerivativeResaleEventInput {
  asset_id: string;
  seller_payee_id: string;
  /** The marketplace the resale cleared (its identity space discriminator). */
  marketplace: string;
  /** The resale leg's sequence for this asset+seller+marketplace (0-based). */
  resale_sequence: number;
  sale_gross_cents: number;
}

/**
 * Derives the resale event's unique id — deterministic across re-parses:
 * `derivative:resale:<asset>:<seller>:<marketplace>:<sequence>:<gross>`.
 * Throws on a structurally impossible input (the ingest's bug, not a
 * domain state): empty identities or a non-integer amount/sequence.
 */
export function derivativeResaleEventId(input: DerivativeResaleEventInput): string {
  if (
    input.asset_id === "" ||
    input.seller_payee_id === "" ||
    input.marketplace === "" ||
    !Number.isSafeInteger(input.sale_gross_cents) ||
    input.sale_gross_cents <= 0 ||
    !Number.isSafeInteger(input.resale_sequence) ||
    input.resale_sequence < 0
  ) {
    throw new Error(
      "derivative_resale_event_id_invalid: a resale's content-derived id needs non-empty asset/seller/marketplace identities, a positive integer gross, and a non-negative integer sequence.",
    );
  }
  return `derivative:resale:${input.asset_id}:${input.seller_payee_id}:${input.marketplace}:${input.resale_sequence}:${input.sale_gross_cents}`;
}

// ---------------------------------------------------------------------------
// The lane's post — a thin wrapper over the CANONICAL seam. The wrapper
// validates the sale shape and names the lane; the seam owns the money.
// ---------------------------------------------------------------------------

export interface DerivativeCascadePostInput {
  sale: DerivativeCascadeSaleInput;
  currency: string;
  /** The sale event's unique id (statement-line or content-derived resale id). */
  event_id: string;
  /** Run linkage when the sale arises inside a run's reconciliation. */
  split_run_id?: string | null;
}

export async function postDerivativeSaleToHolding(
  store: Store,
  input: DerivativeCascadePostInput,
  now: Date = new Date(),
): Promise<UnclaimedHoldingPostSuccess | DerivativeCascadeFailure> {
  const invalidSale = validateDerivativeSaleInput(input.sale);
  if (invalidSale !== undefined) return invalidSale;
  if (input.event_id === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_sale_input",
      message: "A cascade sale posts under a non-empty event id — the replay identity.",
    };
  }
  // A resale IS ingested as a match_queue row (the worker writes one queue
  // row per statement/resale line), so the source provenance is honest.
  return postToUnclaimedHolding(
    store,
    {
      amount_cents: input.sale.sale_gross_cents,
      currency: input.currency,
      source: { type: "match_queue", event_id: input.event_id },
      split_run_id: input.split_run_id ?? null,
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// The verified release — the plan, then the canonical clearance-gated path.
// ---------------------------------------------------------------------------

export interface DerivativeCascadeReleaseInput {
  /** The sale event whose holding credit releases (the line_item_id stamp). */
  event_id: string;
  /** The sale identity — must be the SAME sale the holding credit posted. */
  sale: DerivativeCascadeSaleInput;
  /** The clearance gate's first condition — fail-closed on anything but true. */
  operator_settlement_approved: boolean;
}

export type DerivativeCascadeReleaseSuccess = {
  ok: true;
  value: {
    /** The plan that was executed (the audit trail, upstream-first). */
    plan: DerivativeCascadePlan;
    /** The canonical release outcome (per-party credits, dust, journal). */
    release: UnclaimedHoldingReleaseSuccess["value"];
  };
};

/**
 * Releases one derivative sale's held gross through the cascade:
 *
 *   1. the sale's HELD holding credit is located by the event id the
 *      posting seam stamped into line_item_id (404 when nothing is held —
 *      a released or never-posted sale refuses here, fail-closed),
 *   2. the plan builds from the store's edge table (a cycle or an
 *      over-contracted tree refuses — 422, nothing moves),
 *   3. the upstream-first party list releases through
 *      releaseUnclaimedHolding: the standing payout gates (operator
 *      settlement approval, verified KYC, the SPATIAL vertical's state)
 *      evaluate per credited payee inside, withholding and recoupment run
 *      per creator, and the dust sweeps to the platform variance account.
 */
export async function releaseDerivativeCascade(
  store: Store,
  input: DerivativeCascadeReleaseInput,
  now: Date = new Date(),
): Promise<DerivativeCascadeReleaseSuccess | DerivativeCascadeFailure> {
  const invalidSale = validateDerivativeSaleInput(input.sale);
  if (invalidSale !== undefined) return invalidSale;
  if (input.event_id === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_sale_input",
      message: "A cascade release names the sale event whose credit it releases.",
    };
  }

  // 1. The HELD credit for this sale event. A released sale's row is
  // status 'settled' — it no longer matches, and the release below is the
  // one path that flips status, so a replayed release reads 404/409 from
  // here or from the CAS, never a double payout.
  const credits = await store.listLedgerTransactionsByLineItem(input.event_id);
  const held = credits.find(
    (row) => row.kind === "unclaimed_holding" && row.status === "unclaimed_holding",
  );
  if (held === undefined) {
    return {
      ok: false,
      status: 404,
      code: "holding_credit_not_found",
      message: `No held unclaimed-holding credit is stamped to sale event "${input.event_id}".`,
    };
  }

  // The plan is built over what is actually HELD — the credit's amount is
  // the sale's gross of record, not the caller's restatement of it.
  const sale: DerivativeCascadeSaleInput = {
    ...input.sale,
    sale_gross_cents: held.amount_cents,
  };

  // 2. The plan — the store-backed walk loads the reachable tree (cycle
  // detection included), then the pure planner runs over it. All of the
  // fail-closed refusals intact.
  const loaded = await loadDerivativeRoyaltyEdgeMap(store, sale.asset_id);
  if (!loaded.ok) return loaded;
  const plan = buildDerivativeCascadePlan(sale, (assetId) =>
    loaded.value.get(assetId) ?? [],
  );
  if (!plan.ok) return plan;

  // 3. The canonical clearance-gated release, upstream first.
  const release = await releaseUnclaimedHolding(
    store,
    {
      holding_ledger_id: held.id,
      splits: plan.value.party_splits,
      operator_settlement_approved: input.operator_settlement_approved,
      vertical: DERIVATIVE_CASCADE_VERTICAL,
    },
    now,
  );
  if (!release.ok) return release;

  return { ok: true, value: { plan: plan.value, release: release.value } };
}
