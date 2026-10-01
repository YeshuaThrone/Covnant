// Music sample cascade + statutory cover mechanicals — PR 17 (founder
// directive patch canon round 2).
//
// When a track's line releases, the allocator resolves its recorded
// dependencies off match_queue's addendum-6 columns (PR 1's migration 0011;
// PR 2's worker plumbing): a line flagged with a parent_composition_id walks
// the SAMPLE cascade; a line flagged is_cover_version routes the statutory
// mechanical pool to the covered composition's original publishers. The
// rights-type separation runs through both paths — master samples and
// publishing interpolations are separate sides of the queue, and a line's
// cascade fires only its own side's edges.
//
// THE SAMPLE CASCADE (master samples and publishing interpolations):
//
//   The clearance-agreement contract layer (migration 0022's
//   sample_clearance_edges, keyed on parent_composition_id) holds one row per
//   (work_id, parent_composition_id, rights_holder_payee_id, rights_type):
//   the work's licensed use of the upstream composition, the licensor of
//   record, and the license percentage extracted from the agreement of
//   record (parseClearanceAgreement — strict, fail-closed). When the work's
//   line releases, the allocator walks the dependency tree DEPTH-FIRST (the
//   loadSampleClearanceEdgeMap discipline — the derivative cascade's walk,
//   PR 16) and per edge, in walk order: validates the contract, checks the
//   tree's total contracted bps have not breached the line (fail-closed,
//   naming the breaching edge), and reserves floor(license_bps × line_gross /
//   10000) integer cents for the upstream rights holder. The TOP-LINE
//   deductions complete BEFORE any net artist/producer split math runs —
//   upstream-first ordering is structural, not conventional. The net pool
//   (gross − reservations) then divides among the downstream splits by
//   largest-remainder apportionment of the remaining bps: no contract bps
//   leak to the platform dust — only the integer-cent floor residue does
//   (the canonical allocator's own sweep).
//
//   Rights-type separation: an edge belongs to ONE side ('master' or
//   'publishing'); a master-side line's cascade fires only master edges, a
//   publishing-side line only publishing edges. Cycle detection runs over
//   the FULL graph regardless of the filter — a malformed tree refuses every
//   line that touches it (fail-closed). Diamonds are not cycles: each EDGE
//   contract fires exactly once (node-expansion dedup), so both co-holder
//   edges pay.
//
// THE STATUTORY COVER PATH (HFA/MLC-flagged cover versions):
//
//   A cover version's compulsory mechanical routes the statutory pool to the
//   covered composition's publishers of record (migration 0022's
//   composition_publishers) DIRECTLY — before the recording artist sees a
//   cent. The pool is floor(statutory_rate_bps × line_gross / 10000); the
//   publishers divide it by their registered shares (which must sum to
//   exactly 10000 — the registry of record is complete or the plan refuses);
//   the recording artist takes the remainder. The rate is an EXPLICIT
//   release input (rate_bps + rate_table_version stamped on the plan — the
//   rate that moved money is always on the record); the versioned reference
//   schedule (statutoryMechanicalBpsForYear) is the CRB Phonorecords IV
//   headline streaming schedule and refuses out-of-period years rather than
//   guess at a pending Phono V determination.
//
// THE THREE MOVES (the derivative cascade's shape, PR 16):
//
//   buildSampleCascadePlan / buildCoverMechanicalPlan — the PURE planners.
//                 Integer math only; every share floor(bps × gross / 10000)
//                 through the house allocator (allocateWithCompanyDustSweep),
//                 the rounding residue swept to the platform variance
//                 account. Fail-closed refusals: invalid edge, cycle,
//                 over-contracted tree, unbalanced publisher registry.
//
//   loadSampleClearanceEdgeMap — the store-backed walk (cycles refuse).
//
//   releaseSampleCascade / releaseCoverMechanical — the verified releases.
//                 The HELD holding credit is located by the event id the
//                 posting seam stamped into line_item_id (the music posting
//                 seam already credited the gross — a sample or cover line
//                 IS a music line, so no new post path exists to mint), the
//                 plan builds from the store's registry tables, and the
//                 party list releases through releaseUnclaimedHolding:
//                 operator settlement approval, Plaid-backed verified KYC,
//                 and the MUSIC vertical's compliance state
//                 (rights_separation_settled) evaluate per credited payee,
//                 withholding runs per creator, and the dust sweeps to the
//                 platform variance account. A refusal anywhere leaves the
//                 credit HELD (nothing moves); a replayed release reads 404
//                 — the settled row is no longer held.

import type { Store } from "@/lib/server/store";
import type {
  CompositionPublisherRecord,
  SampleClearanceEdgeRecord,
} from "@/modules/don/records";
import { BPS_DENOMINATOR } from "@/modules/don/constants";
import { allocateWithCompanyDustSweep } from "@/modules/don/dust";
import {
  releaseUnclaimedHolding,
  type UnclaimedHoldingReleaseSuccess,
} from "@/lib/server/unclaimedHolding";
import type { AssetVertical } from "@/modules/compliance/payoutGate";
import type { PayeeRole, SplitPartyInput } from "@/lib/don/types";

/** The vertical every music cascade release gates against. */
export const MUSIC_CASCADE_VERTICAL: AssetVertical = "music";

/** The two sides of the rights separation (match_queue.rights_type). */
export type MusicRightsType = "master" | "publishing";

export type SampleCascadeFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

function fail(
  status: 404 | 422 | 500,
  code: string,
  message: string,
): SampleCascadeFailure {
  return { ok: false, status, code, message };
}

// ---------------------------------------------------------------------------
// The queue-row discriminator — which release lane a music line rides.
// ---------------------------------------------------------------------------

/** The queue-row fields this module's lanes read (addendum 6, migration 0011). */
export interface MusicQueueLineIdentity {
  rights_type: string;
  parent_composition_id: string | null;
  is_cover_version: boolean | null;
}

export type MusicQueueLineRoute =
  | { ok: true; path: "plain" }
  | {
      ok: true;
      path: "sample_cascade";
      rights_type: MusicRightsType;
    }
  | {
      ok: true;
      path: "cover_mechanical";
      /** The covered composition (the queue row's parent_composition_id). */
      composition_id: string;
    }
  | SampleCascadeFailure;

/**
 * Routes one matched music queue line down its own side of the queue:
 *
 *   - `rights_type === "unknown"` refuses — the rights-type separation
 *     needs a resolved side before any sample or cover math runs
 *     (fail-closed).
 *   - `is_cover_version === true` routes the COVER lane. The covered
 *     composition is the queue row's parent_composition_id; a cover flagged
 *     without one refuses (statutory mechanicals have nowhere to route).
 *     A cover wins over a sample dependency on the same row: the statutory
 *     mechanical is full and the embedded-sample burden sits inside the
 *     covered work's own chain, not the cover's.
 *   - Otherwise a non-null parent_composition_id routes the SAMPLE cascade
 *     (the line's rights_type picks the side); a null one is a plain music
 *     line for the existing release path — no lane here, no refusal.
 */
export function routeMusicQueueLine(
  row: MusicQueueLineIdentity,
): MusicQueueLineRoute {
  if (row.rights_type !== "master" && row.rights_type !== "publishing") {
    return fail(
      422,
      "music_rights_type_unresolved",
      `Queue line rights_type "${row.rights_type}" is unresolved — master samples and publishing interpolations route only after the rights-type separation settles.`,
    );
  }
  if (row.is_cover_version === true) {
    if (
      row.parent_composition_id === null ||
      row.parent_composition_id === ""
    ) {
      return fail(
        422,
        "cover_missing_composition",
        "A cover version names no covered composition — the statutory mechanical pool has nowhere to route.",
      );
    }
    return {
      ok: true,
      path: "cover_mechanical",
      composition_id: row.parent_composition_id,
    };
  }
  if (row.parent_composition_id !== null && row.parent_composition_id !== "") {
    return { ok: true, path: "sample_cascade", rights_type: row.rights_type };
  }
  return { ok: true, path: "plain" };
}

// ---------------------------------------------------------------------------
// Clearance-agreement parsing — strict, fail-closed (the ingest discipline).
// ---------------------------------------------------------------------------

export interface ClearanceAgreementInput {
  /** The downstream work using the sample/interpolation. */
  work_id: string;
  /** The upstream composition the agreement licenses. */
  parent_composition_id: string;
  /** The agreement's stated side of the rights separation. */
  rights_type: string;
  /** The licensor of record — the sovereign payee identity. */
  licensor_payee_id: string;
  licensor_payee_name: string;
  /**
   * The license percentage exactly as the agreement states it — "12.5%" or
   * "12.5". At most two decimal places: basis points cannot represent more,
   * and a silently-rounded contract percentage is a forged contract.
   */
  license_percentage_text: string;
  /** The agreement of record the percentage was extracted from. */
  agreement_ref: string;
}

export type ClearanceAgreementParseSuccess = {
  ok: true;
  value: Omit<SampleClearanceEdgeRecord, "id">;
};

/** Extracts the license percentage's bps from the stated text, fail-closed. */
function parseLicenseBps(
  text: string,
): { ok: true; bps: number } | SampleCascadeFailure {
  const trimmed = text.trim();
  const withoutPercent = trimmed.endsWith("%")
    ? trimmed.slice(0, -1).trim()
    : trimmed;
  if (!/^\d+(\.\d{1,2})?$/.test(withoutPercent)) {
    return fail(
      422,
      "clearance_percentage_unparseable",
      `License percentage "${text}" is not a decimal percentage with at most two decimal places — bps cannot represent finer precision, and a silently-rounded contract percentage is a forged contract.`,
    );
  }
  const [intPart, fracPart = ""] = withoutPercent.split(".");
  // Basis points are hundredths of a percent: pad the stated fraction to
  // exactly two digits — "12.5" is 12.50% (1250 bps), never a truncation
  // to 125. Finer precision was already refused by the shape check.
  const bps = Number(intPart) * 100 + Number(fracPart.padEnd(2, "0"));
  if (!Number.isSafeInteger(bps) || bps <= 0 || bps > BPS_DENOMINATOR) {
    return fail(
      422,
      "clearance_percentage_out_of_range",
      `License percentage "${text}" does not land in (0, 100]% — refusing the agreement.`,
    );
  }
  return { ok: true, bps };
}

/**
 * Parses one clearance agreement of record into the edge registration row.
 * Strict: empty identities refuse, the percentage must land in (0, 100]
 * with at most two decimal places, and the rights type must be one of the
 * two queue sides. The bps conversion happens exactly here — the parse
 * boundary — and never inside the allocator (integer bps are the canonical
 * storage; percentages round-trip only at this edge).
 */
export function parseClearanceAgreement(
  input: ClearanceAgreementInput,
): ClearanceAgreementParseSuccess | SampleCascadeFailure {
  for (const [field, value] of [
    ["work_id", input.work_id],
    ["parent_composition_id", input.parent_composition_id],
    ["licensor_payee_id", input.licensor_payee_id],
    ["licensor_payee_name", input.licensor_payee_name],
    ["agreement_ref", input.agreement_ref],
  ] as const) {
    if (value === "" || value === undefined) {
      return fail(
        422,
        "clearance_agreement_incomplete",
        `The clearance agreement's ${field} is empty — a contract of record names every party and source.`,
      );
    }
  }
  if (input.work_id === input.parent_composition_id) {
    return fail(
      422,
      "sample_cascade_self_edge",
      "A work cannot license itself — the clearance agreement's work and parent composition are the same id.",
    );
  }
  if (input.rights_type !== "master" && input.rights_type !== "publishing") {
    return fail(
      422,
      "clearance_rights_type_invalid",
      `Clearance agreement rights_type "${input.rights_type}" is neither "master" nor "publishing" — the sides of the queue are exactly those two.`,
    );
  }
  const parsed = parseLicenseBps(input.license_percentage_text);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      work_id: input.work_id,
      parent_composition_id: input.parent_composition_id,
      rights_type: input.rights_type,
      rights_holder_payee_id: input.licensor_payee_id,
      rights_holder_payee_name: input.licensor_payee_name,
      license_bps: parsed.bps,
      clearance_agreement_ref: input.agreement_ref,
      created_at: "",
    },
  };
}

// ---------------------------------------------------------------------------
// The pure sample-cascade planner.
// ---------------------------------------------------------------------------

export interface SampleCascadeLineInput {
  /** The line's matched work (the walk's start) — a cbt_assets id. */
  work_id: string;
  /** The line's gross of record, integer cents. */
  line_gross_cents: number;
  /** Which side of the rights separation this line rides. */
  rights_type: MusicRightsType;
  /**
   * The downstream artist/producer splits of the NET pool — shares of what
   * remains after the top-line sample deductions. Shares are basis points
   * summing to exactly 10000 (fail-closed otherwise).
   */
  net_splits: readonly SplitPartyInput[];
}

export type SampleCascadePlan = {
  work_id: string;
  rights_type: MusicRightsType;
  line_gross_cents: number;
  /**
   * The top-line reservations, depth-first upstream-first (the walk order).
   * Each edge's royalty_cents is floor(license_bps × gross / 10000) — the
   * exact amount the release executes.
   */
  reservations: Array<{
    step: number;
    work_id: string;
    parent_composition_id: string;
    rights_type: MusicRightsType;
    rights_holder_payee_id: string;
    rights_holder_payee_name: string;
    license_bps: number;
    clearance_agreement_ref: string;
    royalty_cents: number;
  }>;
  upstream_total_cents: number;
  /** The net pool the downstream artist/producer splits divide. */
  downstream: {
    /** 10000 − the reserved bps. */
    net_bps: number;
    /** gross − the reserved cents. */
    net_cents: number;
    splits: Array<{
      payee_id: string;
      payee_name: string;
      role: PayeeRole;
      /** The contract share of the NET pool (basis points). */
      share_bps: number;
      /** The effective share of the line gross after apportionment. */
      allocated_bps: number;
      /** The integer cents that actually pay (the release executes these). */
      net_cents: number;
    }>;
  };
  /** The integer-cent floor residue — the platform variance sweep. */
  company_dust_cents: number;
  /**
   * The release party list — reservations FIRST (upstream-first ordering),
   * then the net splits; shares in effective bps of the line gross summing
   * to exactly 10000. Exactly what releaseUnclaimedHolding executes.
   */
  party_splits: SplitPartyInput[];
};

/**
 * Largest-remainder apportionment of `totalBps` across the parties by their
 * share_bps: each party floors its exact fractional bps, then the leftover
 * bps (< the party count) distribute one at a time to the largest
 * fractional remainder, ties broken by list order — deterministic, and no
 * contract bps leak to the platform dust.
 */
function apportionBps(
  totalBps: number,
  shares: ReadonlyArray<{ index: number; share_bps: number }>,
): number[] {
  const floored = shares.map((party) => ({
    index: party.index,
    exact: (party.share_bps * totalBps) / BPS_DENOMINATOR,
    bps: Math.floor((party.share_bps * totalBps) / BPS_DENOMINATOR),
  }));
  let remainder =
    totalBps - floored.reduce((total, party) => total + party.bps, 0);
  const byRemainder = [...floored].sort((a, b) => {
    const diff = b.exact - b.bps - (a.exact - a.bps);
    if (diff !== 0) return diff;
    return a.index - b.index;
  });
  for (const party of byRemainder) {
    if (remainder <= 0) break;
    party.bps += 1;
    remainder -= 1;
  }
  const allocated = new Array<number>(shares.length);
  for (const party of floored) allocated[party.index] = party.bps;
  return allocated;
}

function isSafePositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validateNetSplits(
  netSplits: readonly SplitPartyInput[],
): SampleCascadeFailure | undefined {
  if (netSplits.length === 0) {
    return fail(
      422,
      "invalid_line_input",
      "A sample cascade line names its downstream artist/producer splits — an empty net split list leaves the net pool unallocated.",
    );
  }
  const totalBps = netSplits.reduce(
    (total, party) => total + party.share_bps,
    0,
  );
  if (totalBps !== BPS_DENOMINATOR) {
    return fail(
      422,
      "net_splits_do_not_balance",
      `The net artist/producer splits sum to ${totalBps} bps, not 10000 — the net pool's shares must be complete.`,
    );
  }
  const seen = new Set<string>();
  for (const party of netSplits) {
    if (party.payee_id === "" || party.payee_name === "") {
      return fail(
        422,
        "invalid_line_input",
        "Every net split names a payee id and display name.",
      );
    }
    if (party.share_bps <= 0) {
      return fail(
        422,
        "invalid_line_input",
        `Net split for payee "${party.payee_id}" carries ${party.share_bps} bps — every net split holds a positive share.`,
      );
    }
    if (seen.has(party.payee_id)) {
      return fail(
        422,
        "invalid_line_input",
        `Net split payee "${party.payee_id}" appears twice — one payee, one split row.`,
      );
    }
    seen.add(party.payee_id);
  }
  return undefined;
}

/**
 * Builds the sample cascade plan for one line over an edge lookup (pure: no
 * store, no clock — tests pin the math with plain fixtures; the store-backed
 * caller preloads the reachable tree with loadSampleClearanceEdgeMap).
 *
 * The walk fires only edges matching the line's rights_type (the sides of
 * the queue are separate); the loader's cycle detection ran over the FULL
 * graph. Per edge, depth-first in insertion order: validate, check the
 * line's total contracted bps, reserve floor(license_bps × gross / 10000).
 * The net split math runs only after the walk completes.
 */
export function buildSampleCascadePlan(
  input: SampleCascadeLineInput,
  edgesFor: (workId: string) => readonly SampleClearanceEdgeRecord[],
): { ok: true; value: SampleCascadePlan } | SampleCascadeFailure {
  if (!isSafePositiveInteger(input.line_gross_cents)) {
    return fail(
      422,
      "invalid_line_input",
      `Line gross ${input.line_gross_cents} is not a positive safe integer — money math runs in integer cents only.`,
    );
  }
  if (input.work_id === "") {
    return fail(
      422,
      "invalid_line_input",
      "A sample cascade line names its matched work.",
    );
  }
  const invalidSplits = validateNetSplits(input.net_splits);
  if (invalidSplits !== undefined) return invalidSplits;

  const reservations: SampleCascadePlan["reservations"] = [];
  let reservedBps = 0;
  let reservedCents = 0;
  const path = new Set<string>();
  const expanded = new Set<string>();

  const walk = (workId: string): SampleCascadeFailure | undefined => {
    if (path.has(workId)) {
      return fail(
        422,
        "sample_cascade_cycle",
        `The dependency tree for work "${input.work_id}" is malformed — the walk reached "${workId}" twice on one path (a sample cycle, e.g. D→P→D). Nothing releases from a tree that cannot be walked to the root.`,
      );
    }
    // A diamond reaches one parent by two routes: not a cycle — but the
    // node's own contracts must not fire twice (each EDGE contract is one
    // row; expansion dedup keeps the walk finite on DAGs).
    if (expanded.has(workId)) return undefined;
    path.add(workId);
    expanded.add(workId);

    for (const edge of edgesFor(workId)) {
      // The sides of the queue are separate: a line's cascade fires only
      // its own rights_type's edges.
      if (edge.rights_type !== input.rights_type) continue;
      if (
        edge.rights_holder_payee_id === "" ||
        edge.rights_holder_payee_name === "" ||
        edge.clearance_agreement_ref === ""
      ) {
        return fail(
          422,
          "sample_cascade_invalid_edge",
          `Clearance edge ${edge.id ?? "(unregistered)"} on work "${workId}" is missing its licensor identity or agreement of record — an incomplete contract never reserves.`,
        );
      }
      if (
        !isSafePositiveInteger(edge.license_bps) ||
        edge.license_bps > BPS_DENOMINATOR
      ) {
        return fail(
          422,
          "sample_cascade_invalid_edge",
          `Clearance edge for work "${workId}" → composition "${edge.parent_composition_id}" carries ${edge.license_bps} bps — a license is a positive fraction of the line, at most the whole line.`,
        );
      }
      if (reservedBps + edge.license_bps > BPS_DENOMINATOR) {
        return fail(
          422,
          "sample_cascade_exceeds_line",
          `Clearance edge for work "${workId}" → composition "${edge.parent_composition_id}" ("${edge.clearance_agreement_ref}") would push the tree's contracted total to ${reservedBps + edge.license_bps} bps of a ${BPS_DENOMINATOR}-bps line — the tree over-contracts the line, so nothing releases.`,
        );
      }
      const royaltyCents = Math.floor(
        (edge.license_bps * input.line_gross_cents) / BPS_DENOMINATOR,
      );
      reservedBps += edge.license_bps;
      reservedCents += royaltyCents;
      reservations.push({
        step: reservations.length + 1,
        work_id: workId,
        parent_composition_id: edge.parent_composition_id,
        rights_type: edge.rights_type,
        rights_holder_payee_id: edge.rights_holder_payee_id,
        rights_holder_payee_name: edge.rights_holder_payee_name,
        license_bps: edge.license_bps,
        clearance_agreement_ref: edge.clearance_agreement_ref,
        royalty_cents: royaltyCents,
      });
      // Depth-first PER EDGE: the parent's own contracts reserve before the
      // child's sibling edges do — upstream-first ordering is the walk
      // order, not a sort afterward.
      const upstream = walk(edge.parent_composition_id);
      if (upstream !== undefined) return upstream;
    }

    path.delete(workId);
    return undefined;
  };

  const cycleOrInvalid = walk(input.work_id);
  if (cycleOrInvalid !== undefined) return cycleOrInvalid;

  const netBps = BPS_DENOMINATOR - reservedBps;
  const netCents = input.line_gross_cents - reservedCents;

  // The net split math — only after the walk completes. Contract shares of
  // the net pool convert to effective bps of the line gross by
  // largest-remainder apportionment (no contract bps leak to the dust).
  const shares = input.net_splits.map((party, index) => ({
    index,
    share_bps: party.share_bps,
  }));
  const allocatedBps = apportionBps(netBps, shares);

  const partySplits: SplitPartyInput[] = reservations.map((reservation) => ({
    payee_id: reservation.rights_holder_payee_id,
    payee_name: reservation.rights_holder_payee_name,
    // Master samples pay master-side (label) holders; publishing
    // interpolations pay publishing-side (publisher) holders.
    role: reservation.rights_type === "master" ? "label" : "publisher",
    share_bps: reservation.license_bps,
  }));
  const downstreamSplits: SampleCascadePlan["downstream"]["splits"] = [];
  for (let index = 0; index < input.net_splits.length; index += 1) {
    const party = input.net_splits[index];
    partySplits.push({
      payee_id: party.payee_id,
      payee_name: party.payee_name,
      role: party.role,
      share_bps: allocatedBps[index],
    });
    downstreamSplits.push({
      payee_id: party.payee_id,
      payee_name: party.payee_name,
      role: party.role,
      share_bps: party.share_bps,
      allocated_bps: allocatedBps[index],
      net_cents: Math.floor(
        (allocatedBps[index] * input.line_gross_cents) / BPS_DENOMINATOR,
      ),
    });
  }

  // The canonical allocator — the same computation the release executes.
  const allocation = allocateWithCompanyDustSweep(
    input.line_gross_cents,
    partySplits,
  );
  if (!allocation.ok) {
    return fail(422, allocation.code, allocation.message);
  }
  // Pin the plan's declared cents to the allocator's (they are the same
  // arithmetic; this makes the invariant structural rather than hoped-for).
  for (let index = 0; index < reservations.length; index += 1) {
    reservations[index].royalty_cents = allocation.splits[index].amount_cents;
  }
  for (let index = 0; index < downstreamSplits.length; index += 1) {
    downstreamSplits[index].net_cents =
      allocation.splits[reservations.length + index].amount_cents;
  }

  return {
    ok: true,
    value: {
      work_id: input.work_id,
      rights_type: input.rights_type,
      line_gross_cents: input.line_gross_cents,
      reservations,
      upstream_total_cents: reservedCents,
      downstream: {
        net_bps: netBps,
        net_cents: netCents,
        splits: downstreamSplits,
      },
      company_dust_cents: allocation.company_dust_cents,
      party_splits: partySplits,
    },
  };
}

// ---------------------------------------------------------------------------
// The store-backed walk — the full graph, cycles refuse (fail-closed).
// ---------------------------------------------------------------------------

export async function loadSampleClearanceEdgeMap(
  store: Store,
  workId: string,
): Promise<
  | {
      ok: true;
      value: Map<string, SampleClearanceEdgeRecord[]>;
    }
  | SampleCascadeFailure
> {
  const edgesByWork = new Map<string, SampleClearanceEdgeRecord[]>();
  const path = new Set<string>();
  const expanded = new Set<string>();

  const walk = async (
    node: string,
  ): Promise<SampleCascadeFailure | undefined> => {
    if (path.has(node)) {
      return fail(
        422,
        "sample_cascade_cycle",
        `The dependency tree for work "${workId}" is malformed — the walk reached "${node}" twice on one path (a sample cycle, e.g. D→P→D). Nothing releases from a tree that cannot be walked to the root.`,
      );
    }
    if (expanded.has(node)) return undefined;
    path.add(node);
    expanded.add(node);

    const edges = await store.getSampleClearanceEdgesByWork(node);
    edgesByWork.set(node, edges);
    for (const edge of edges) {
      const upstream = await walk(edge.parent_composition_id);
      if (upstream !== undefined) return upstream;
    }

    path.delete(node);
    return undefined;
  };

  const cycle = await walk(workId);
  if (cycle !== undefined) return cycle;
  return { ok: true, value: edgesByWork };
}

// ---------------------------------------------------------------------------
// The pure cover-mechanical planner.
// ---------------------------------------------------------------------------

export interface CoverMechanicalLineInput {
  /** The covered composition (the queue row's parent_composition_id). */
  composition_id: string;
  /** The line's gross of record, integer cents. */
  line_gross_cents: number;
  /** The recording artist — the remainder after the statutory pool routes. */
  recording_artist: { payee_id: string; payee_name: string };
  /**
   * The statutory rate that governs this release — explicit, with the
   * schedule version stamped (the rate that moved money is on the record).
   * statutoryMechanicalBpsForYear is the reference default.
   */
  statutory_mechanical: { rate_bps: number; rate_table_version: string };
}

export type CoverMechanicalPlan = {
  composition_id: string;
  line_gross_cents: number;
  /** The statutory rate that governed (stamped — the audit trail). */
  statutory_mechanical: { rate_bps: number; rate_table_version: string };
  /** The statutory pool: floor(rate_bps × gross / 10000). */
  mechanical_pool_cents: number;
  /** The publishers of record, routed first, by registered share. */
  publisher_cents: Array<{
    payee_id: string;
    payee_name: string;
    /** The registered share of the mechanical pool (basis points). */
    share_bps: number;
    /** The effective share of the line gross after apportionment. */
    allocated_bps: number;
    mechanical_cents: number;
  }>;
  /** The recording artist's remainder — routed LAST. */
  artist: {
    payee_id: string;
    payee_name: string;
    allocated_bps: number;
    net_cents: number;
  };
  /** The integer-cent floor residue — the platform variance sweep. */
  company_dust_cents: number;
  /** Publishers FIRST (statutory priority), artist LAST; Σ 10000. */
  party_splits: SplitPartyInput[];
};

/**
 * Builds the cover mechanical plan for one cover line (pure: no store, no
 * clock). The statutory pool routes to the covered composition's publishers
 * of record by share — the registry must be present and balanced (Σ shares
 * = 10000) or the plan refuses; the recording artist takes the remainder.
 * Publishers precede the artist in the party list: the compulsory
 * mechanical pays the original publishers directly, before the artist.
 */
export function buildCoverMechanicalPlan(
  input: CoverMechanicalLineInput,
  publishers: readonly CompositionPublisherRecord[],
): { ok: true; value: CoverMechanicalPlan } | SampleCascadeFailure {
  if (!isSafePositiveInteger(input.line_gross_cents)) {
    return fail(
      422,
      "invalid_line_input",
      `Line gross ${input.line_gross_cents} is not a positive safe integer — money math runs in integer cents only.`,
    );
  }
  if (input.composition_id === "") {
    return fail(
      422,
      "invalid_line_input",
      "A cover mechanical line names the covered composition it routes against.",
    );
  }
  if (
    input.recording_artist.payee_id === "" ||
    input.recording_artist.payee_name === ""
  ) {
    return fail(
      422,
      "invalid_line_input",
      "A cover mechanical line names its recording artist — the remainder pays someone.",
    );
  }
  const { rate_bps, rate_table_version } = input.statutory_mechanical;
  if (
    !Number.isSafeInteger(rate_bps) ||
    rate_bps <= 0 ||
    rate_bps > BPS_DENOMINATOR ||
    rate_table_version === ""
  ) {
    return fail(
      422,
      "statutory_rate_invalid",
      `Statutory mechanical rate ${rate_bps} bps (version "${rate_table_version}") is not a positive fraction of the line with a named schedule — refusing the release rather than guessing a rate.`,
    );
  }
  if (publishers.length === 0) {
    return fail(
      422,
      "composition_publishers_empty",
      `Composition "${input.composition_id}" has no publishers of record — a cover's statutory mechanical has nowhere to route until the registry is complete.`,
    );
  }
  const shareTotal = publishers.reduce(
    (total, publisher) => total + publisher.share_bps,
    0,
  );
  if (shareTotal !== BPS_DENOMINATOR) {
    return fail(
      422,
      "composition_publishers_unbalanced",
      `Composition "${input.composition_id}"'s publishers of record hold ${shareTotal} bps of the mechanical pool, not 10000 — the registry of record is incomplete, so the statutory pool cannot route.`,
    );
  }

  // The publishers' shares of the statutory pool convert to effective bps
  // of the line gross by largest-remainder apportionment; the artist takes
  // exactly the remaining bps (10000 − rate_bps).
  const shares = publishers.map((publisher, index) => ({
    index,
    share_bps: publisher.share_bps,
  }));
  const allocatedBps = apportionBps(rate_bps, shares);
  const artistBps = BPS_DENOMINATOR - rate_bps;

  const partySplits: SplitPartyInput[] = publishers.map((publisher, index) => ({
    payee_id: publisher.publisher_payee_id,
    payee_name: publisher.publisher_payee_name,
    role: "publisher",
    share_bps: allocatedBps[index],
  }));
  partySplits.push({
    payee_id: input.recording_artist.payee_id,
    payee_name: input.recording_artist.payee_name,
    role: "creator",
    share_bps: artistBps,
  });

  // The canonical allocator — the same computation the release executes.
  const allocation = allocateWithCompanyDustSweep(
    input.line_gross_cents,
    partySplits,
  );
  if (!allocation.ok) {
    return fail(422, allocation.code, allocation.message);
  }

  const publisherCents: CoverMechanicalPlan["publisher_cents"] = publishers.map(
    (publisher, index) => ({
      payee_id: publisher.publisher_payee_id,
      payee_name: publisher.publisher_payee_name,
      share_bps: publisher.share_bps,
      allocated_bps: allocatedBps[index],
      mechanical_cents: allocation.splits[index].amount_cents,
    }),
  );

  return {
    ok: true,
    value: {
      composition_id: input.composition_id,
      line_gross_cents: input.line_gross_cents,
      statutory_mechanical: { rate_bps, rate_table_version },
      mechanical_pool_cents: Math.floor(
        (rate_bps * input.line_gross_cents) / BPS_DENOMINATOR,
      ),
      publisher_cents: publisherCents,
      artist: {
        payee_id: input.recording_artist.payee_id,
        payee_name: input.recording_artist.payee_name,
        allocated_bps: artistBps,
        net_cents: allocation.splits[allocation.splits.length - 1].amount_cents,
      },
      company_dust_cents: allocation.company_dust_cents,
      party_splits: partySplits,
    },
  };
}

// ---------------------------------------------------------------------------
// The statutory mechanical rate — the versioned reference schedule.
// ---------------------------------------------------------------------------
//
// The CRB Phonorecords IV final determination's headline rate for
// interactive streaming (the configuration recon queue lines carry revenue
// for): 15.1% of revenue in 2023, 15.2% in 2024, then +0.05 points per year
// to 15.35% in 2027 (grounded this session against the CRB's final rule and
// WMG's FY2025 10-Q: "escalate from 15.1% of total music revenue in 2023 to
// 15.2% in 2024 and then a half-of-a-tenth-of-a-percentage-point increase in
// each of the remaining three years, peaking at 15.35% in 2027"). The
// per-unit physical/download configuration (12.4¢/work, 2.38¢/minute at the
// 2023 base, CPI-U adjusted) is out of scope here — queue lines carry
// revenue micros, never unit counts, so a per-unit rate has nothing to
// multiply.
//
// Out-of-period years return undefined and the release refuses: Phonorecords
// V is pending, and guessing a rate is minting law. When a new schedule is
// determined, add its versioned rows here — the release input's
// rate_table_version stamps which schedule governed.

export const STATUTORY_MECHANICAL_RATE_TABLE_VERSION =
  "phonorecords_iv_streaming";

const PHONORECORDS_IV_STREAMING_BPS: ReadonlyMap<number, number> = new Map([
  [2023, 1510],
  [2024, 1520],
  [2025, 1525],
  [2026, 1530],
  [2027, 1535],
]);

export function statutoryMechanicalBpsForYear(
  year: number,
): { rate_bps: number; rate_table_version: string } | undefined {
  const rateBps = PHONORECORDS_IV_STREAMING_BPS.get(year);
  if (rateBps === undefined) return undefined;
  return {
    rate_bps: rateBps,
    rate_table_version: STATUTORY_MECHANICAL_RATE_TABLE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// The verified releases — the plan, then the canonical clearance-gated path.
// ---------------------------------------------------------------------------

export interface SampleCascadeReleaseInput {
  /** The line event whose holding credit releases (the line_item_id stamp). */
  event_id: string;
  /** The line identity — must be the SAME line the holding credit posted. */
  line: SampleCascadeLineInput;
  /** The clearance gate's first condition — fail-closed on anything but true. */
  operator_settlement_approved: boolean;
}

export type SampleCascadeReleaseSuccess = {
  ok: true;
  value: {
    /** The plan that was executed (the audit trail, upstream-first). */
    plan: SampleCascadePlan;
    /** The canonical release outcome (per-party credits, dust, journal). */
    release: UnclaimedHoldingReleaseSuccess["value"];
  };
};

async function locateHeldCredit(
  store: Store,
  eventId: string,
): Promise<{ ok: true; id: string; amount_cents: number } | SampleCascadeFailure> {
  const credits = await store.listLedgerTransactionsByLineItem(eventId);
  const held = credits.find(
    (row) =>
      row.kind === "unclaimed_holding" && row.status === "unclaimed_holding",
  );
  if (held === undefined) {
    return fail(
      404,
      "holding_credit_not_found",
      `No held unclaimed-holding credit is stamped to line event "${eventId}".`,
    );
  }
  return { ok: true, id: held.id, amount_cents: held.amount_cents };
}

/**
 * Releases one music line's held gross through the sample cascade:
 *
 *   1. the line's HELD holding credit is located by the event id the
 *      posting seam stamped into line_item_id (404 when nothing is held —
 *      a released or never-posted line refuses here, fail-closed),
 *   2. the plan builds from the store's clearance-edge table (a cycle, an
 *      invalid edge, or an over-contracted tree refuses — 422, nothing
 *      moves),
 *   3. the upstream-first party list releases through
 *      releaseUnclaimedHolding: the standing payout gates (operator
 *      settlement approval, verified KYC, the MUSIC vertical's
 *      rights-separation state) evaluate per credited payee inside,
 *      withholding runs per creator, and the dust sweeps to the platform
 *      variance account.
 */
export async function releaseSampleCascade(
  store: Store,
  input: SampleCascadeReleaseInput,
  now: Date = new Date(),
): Promise<SampleCascadeReleaseSuccess | SampleCascadeFailure> {
  if (input.event_id === "") {
    return fail(
      422,
      "invalid_line_input",
      "A sample cascade release names the line event whose credit it releases.",
    );
  }
  const invalidSplits = validateNetSplits(input.line.net_splits);
  if (invalidSplits !== undefined) return invalidSplits;

  // 1. The HELD credit for this line event. A released line's row is status
  // 'settled' — it no longer matches, and the release below is the one path
  // that flips status, so a replayed release reads 404/409 from here or
  // from the CAS, never a double payout.
  const held = await locateHeldCredit(store, input.event_id);
  if (!held.ok) return held;

  // The plan is built over what is actually HELD — the credit's amount is
  // the line's gross of record, not the caller's restatement of it.
  const line: SampleCascadeLineInput = {
    ...input.line,
    line_gross_cents: held.amount_cents,
  };

  // 2. The plan — the store-backed walk loads the reachable tree (cycle
  // detection over the full graph included), then the pure planner runs
  // over it, rights-type filtered. All of the fail-closed refusals intact.
  const loaded = await loadSampleClearanceEdgeMap(store, line.work_id);
  if (!loaded.ok) return loaded;
  const plan = buildSampleCascadePlan(
    line,
    (workId) => loaded.value.get(workId) ?? [],
  );
  if (!plan.ok) return plan;

  // 3. The canonical clearance-gated release, upstream first.
  const release = await releaseUnclaimedHolding(
    store,
    {
      holding_ledger_id: held.id,
      splits: plan.value.party_splits,
      operator_settlement_approved: input.operator_settlement_approved,
      vertical: MUSIC_CASCADE_VERTICAL,
    },
    now,
  );
  if (!release.ok) return release;

  return { ok: true, value: { plan: plan.value, release: release.value } };
}

export interface CoverMechanicalReleaseInput {
  /** The line event whose holding credit releases (the line_item_id stamp). */
  event_id: string;
  /** The cover line identity — must be the SAME line the credit posted. */
  line: Omit<CoverMechanicalLineInput, "line_gross_cents">;
  /** The clearance gate's first condition — fail-closed on anything but true. */
  operator_settlement_approved: boolean;
}

export type CoverMechanicalReleaseSuccess = {
  ok: true;
  value: {
    /** The plan that was executed (the audit trail, statutory-first). */
    plan: CoverMechanicalPlan;
    /** The canonical release outcome (per-party credits, dust, journal). */
    release: UnclaimedHoldingReleaseSuccess["value"];
  };
};

/**
 * Releases one cover version's held gross through the statutory mechanical
 * path: the HELD credit located by the event id, the plan built from the
 * store's composition-publisher registry, and the publisher-first party
 * list released through releaseUnclaimedHolding (the standing gates per
 * credited payee; the recording artist is a creator — withholding runs;
 * the publishers are businesses — it does not).
 */
export async function releaseCoverMechanical(
  store: Store,
  input: CoverMechanicalReleaseInput,
  now: Date = new Date(),
): Promise<CoverMechanicalReleaseSuccess | SampleCascadeFailure> {
  if (input.event_id === "") {
    return fail(
      422,
      "invalid_line_input",
      "A cover mechanical release names the line event whose credit it releases.",
    );
  }
  if (input.line.composition_id === "") {
    return fail(
      422,
      "invalid_line_input",
      "A cover mechanical release names the covered composition it routes against.",
    );
  }

  const held = await locateHeldCredit(store, input.event_id);
  if (!held.ok) return held;

  const publishers = await store.listCompositionPublishers(
    input.line.composition_id,
  );
  const plan = buildCoverMechanicalPlan(
    { ...input.line, line_gross_cents: held.amount_cents },
    publishers,
  );
  if (!plan.ok) return plan;

  const release = await releaseUnclaimedHolding(
    store,
    {
      holding_ledger_id: held.id,
      splits: plan.value.party_splits,
      operator_settlement_approved: input.operator_settlement_approved,
      vertical: MUSIC_CASCADE_VERTICAL,
    },
    now,
  );
  if (!release.ok) return release;

  return { ok: true, value: { plan: plan.value, release: release.value } };
}
