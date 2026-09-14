/**
 * MUL clearance — the Master Universal License state machine and the
 * dispatch gate every collection node's material must pass.
 *
 * Two disciplines shape this module:
 *
 * 1. The machine is the law. A clearance moves draft → requested → cleared;
 *    disputed and revoked are terminal states with exactly one recovery exit
 *    each (a resolved dispute or a re-granted license returns to cleared).
 *    Every other edge — including skipping the draft, jumping straight to
 *    cleared, or a same-state no-op — is a typed refusal. Transitions persist
 *    through the Store seam's mul_clearances methods (PR 3 of Generation 16):
 *    the current row plus an append-only history, so audit can replay an
 *    asset's clearance life oldest-first.
 *
 * 2. Fail-closed, always. `assertCollectible` is the dispatch gate the
 *    collection flow calls before an asset's material may leave a node for
 *    the matcher and the money lane: no clearance, a non-cleared state, a
 *    term that has not started, an expired term, or a malformed term each
 *    throw a typed ClearanceBlockedError with a stable machine code. An
 *    expired term is NOT cleared — the license ended, so dispatch ends with
 *    it (the build spec's Event lifecycle, Blocked row).
 *
 * Territory is ISO 3166-1 alpha-2, validated with the same shape discipline
 * as the canonical royalty event contract (`invalid_territory`, two capital
 * letters) so both SDK surfaces read the field identically. Terms are
 * timestamps: persisted canonically as ISO strings, parsed before use, and
 * never guessed.
 *
 * One seam note, on the record vocabulary: the Store seam's
 * `MulClearanceState` (src/modules/sdk/records.ts, PR 3) predates the spec's
 * fifth state — its union lacks 'revoked'. The column itself is unconstrained
 * TEXT in every backend (migration 0007: `state text not null default
 * 'draft'`, no CHECK; the SQLite schema is TEXT; the in-memory store keeps
 * the row verbatim), so 'revoked' persists correctly at runtime everywhere.
 * The widening is confined to `asStoreState`, which proves the runtime value
 * is a canonical clearance state before crossing; a store-vocabulary
 * follow-up folds the fifth state into the union and shrinks this to a
 * type-level identity.
 */

import type {
  MulClearanceRecord,
  MulClearanceTransitionRecord,
} from '@/modules/sdk/records';

// The seam's row vocabulary, re-exported — consumers of this module (and its
// tests) build rows through one import point.
export type { MulClearanceRecord, MulClearanceTransitionRecord };

/** The clearance lifecycle, in machine order — the spec's five states. */
export const CLEARANCE_STATES = [
  'draft',
  'requested',
  'cleared',
  'disputed',
  'revoked',
] as const;

export type ClearanceState = (typeof CLEARANCE_STATES)[number];

const CLEARANCE_STATE_SET: ReadonlySet<string> = new Set(CLEARANCE_STATES);

function isClearanceState(value: unknown): value is ClearanceState {
  return typeof value === 'string' && CLEARANCE_STATE_SET.has(value);
}

/**
 * The Master Universal License for one catalog asset — the spec's
 * Canonical contracts shape. `licensee` is who may collect; `territory` is
 * ISO 3166-1 alpha-2; `termEnd` bounds the grant because an expired term is
 * not cleared.
 */
export interface MulClearance {
  assetCbtCode: string;
  state: ClearanceState;
  licensee: string | null;
  territory: string | null;
  termStart: string | null;
  termEnd: string | null;
}

/**
 * The clearance slice of the Store seam (src/lib/server/store.ts) — stated
 * structurally so the real Store satisfies it and the SDK stays free of the
 * store graph. SDK PRs consume the PR 3 methods and never touch store files.
 */
export interface ClearanceStore {
  upsertClearance(row: MulClearanceRecord): Promise<MulClearanceRecord>;
  getClearanceForAsset(assetCbtCode: string): Promise<MulClearanceRecord | undefined>;
  insertClearanceTransition(
    row: Omit<MulClearanceTransitionRecord, 'id'>,
  ): Promise<MulClearanceTransitionRecord>;
  listClearanceTransitions(assetCbtCode: string): Promise<MulClearanceTransitionRecord[]>;
}

/** One machine edge, from the current state (null = no clearance yet). */
export const CLEARANCE_TRANSITIONS: Readonly<
  Record<ClearanceState, readonly ClearanceState[]>
> = {
  draft: ['requested'],
  requested: ['cleared'],
  cleared: ['disputed', 'revoked'],
  // Terminal with recovery: a resolved dispute or a re-granted license
  // returns the asset to cleared — the only exit either state has.
  disputed: ['cleared'],
  revoked: ['cleared'],
};

// ---------------------------------------------------------------------------
// Typed refusals — stable machine codes, the nodes/errors.ts posture.
// ---------------------------------------------------------------------------

/** Wire- or caller-supplied clearance data is invalid (field-scoped). */
export class MulClearanceValidationError extends Error {
  /** Stable machine code, e.g. `invalid_territory`. */
  readonly code: string;
  /** The offending field name in the SDK's camelCase vocabulary. */
  readonly field: string;

  constructor(code: string, field: string, detail: string) {
    super(`Universal Royalty Collection SDK: clearance rejected — ${detail}`);
    this.name = 'MulClearanceValidationError';
    this.code = code;
    this.field = field;
  }
}

/** The machine refuses an edge that does not exist. */
export class ClearanceTransitionError extends Error {
  /** Stable machine code, e.g. `invalid_transition:draft->cleared`. */
  readonly code: string;
  readonly fromState: ClearanceState | null;
  readonly toState: ClearanceState;

  constructor(fromState: ClearanceState | null, toState: ClearanceState) {
    const from = fromState ?? 'none';
    super(
      `Universal Royalty Collection SDK: transition refused — no ${from} -> ${toState} edge in the clearance machine.`,
    );
    this.name = 'ClearanceTransitionError';
    this.code = `invalid_transition:${from}->${toState}`;
    this.fromState = fromState;
    this.toState = toState;
  }
}

/**
 * The dispatch gate's refusal — the Event lifecycle's Blocked row. `code`
 * tells the node (and the dispatch queue it feeds) exactly why the asset may
 * not be collected: `clearance_missing`, `clearance_draft`,
 * `clearance_requested`, `clearance_disputed`, `clearance_revoked`,
 * `clearance_term_not_started`, `clearance_term_expired`, or
 * `clearance_term_invalid`.
 */
export class ClearanceBlockedError extends Error {
  /** Stable machine code — dispatch-queue routing reads this, never prose. */
  readonly code: string;
  /** The asset the gate refused, for the queue entry. */
  readonly assetCbtCode: string;

  constructor(code: string, assetCbtCode: string, detail: string) {
    super(`Universal Royalty Collection SDK: dispatch blocked — ${detail}`);
    this.name = 'ClearanceBlockedError';
    this.code = code;
    this.assetCbtCode = assetCbtCode;
  }
}

// ---------------------------------------------------------------------------
// Validation — fail-closed field rules, applied identically on write and read.
// ---------------------------------------------------------------------------

/** The catalog-asset key shape the engine mints: CBT-<TYPE>-<12 hex>. */
const ASSET_CBT_CODE_PATTERN = /^CBT-[A-Z]+-[0-9A-F]{12}$/;

/** ISO 3166-1 alpha-2 — the canonical event contract's territory discipline. */
const ISO_3166_1_ALPHA_2_PATTERN = /^[A-Z]{2}$/;

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The wire can lie about JS types — the admin route forwards request bodies
 * with only shape-level checks — so optional string fields are defended at
 * the module boundary: anything that is not a string, null, or undefined is
 * a typed refusal, never a TypeError escaping into the caller's logs.
 */
function requireStringOrNull(
  value: unknown,
  field: 'assetCbtCode' | 'licensee' | 'territory' | 'termStart' | 'termEnd' | 'note',
  code: string,
): string | null | undefined {
  if (value === null || value === undefined || typeof value === 'string') return value;
  throw new MulClearanceValidationError(code, field, `${field} must be a string or null.`);
}

/** Parses one term boundary; a present but unparseable value fails closed. */
function parseTerm(value: string | null, field: 'termStart' | 'termEnd'): string | null {
  if (value === null) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw new MulClearanceValidationError(
      'invalid_term',
      field,
      `${field} is not a parseable timestamp — terms are never guessed.`,
    );
  }
  return new Date(time).toISOString();
}

function parseTermInstant(value: string | null): number | null {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** Validates the merged field set for one clearance write. */
function validateFields(fields: {
  assetCbtCode: string;
  licensee: string | null;
  territory: string | null;
  termStart: string | null;
  termEnd: string | null;
}): void {
  if (!ASSET_CBT_CODE_PATTERN.test(fields.assetCbtCode)) {
    throw new MulClearanceValidationError(
      'invalid_asset_cbt_code',
      'assetCbtCode',
      'assetCbtCode must match the engine-minted shape CBT-<TYPE>-<12 hex>.',
    );
  }
  if (fields.licensee !== null && fields.licensee.length === 0) {
    throw new MulClearanceValidationError(
      'invalid_licensee',
      'licensee',
      'licensee, when present, names who may collect — it cannot be empty.',
    );
  }
  if (fields.territory !== null && !ISO_3166_1_ALPHA_2_PATTERN.test(fields.territory)) {
    throw new MulClearanceValidationError(
      'invalid_territory',
      'territory',
      'territory must be ISO 3166-1 alpha-2 (two capital letters) or null.',
    );
  }
  const start = parseTermInstant(fields.termStart);
  const end = parseTermInstant(fields.termEnd);
  if (start !== null && end !== null && start > end) {
    throw new MulClearanceValidationError(
      'invalid_term_range',
      'termStart',
      'termStart cannot fall after termEnd — the license cannot start after it ends.',
    );
  }
}

// ---------------------------------------------------------------------------
// The store-row boundary — camelCase domain shape in, snake_case rows out.
// ---------------------------------------------------------------------------

/**
 * Widens a canonical state through the PR 3 store vocabulary (see the seam
 * note above). The membership check proves the runtime value before the
 * widening — the column accepts it in every backend; only the seam's TS
 * union is narrower.
 */
function asStoreState(state: ClearanceState, field: 'state' | 'to_state'): MulClearanceState {
  if (!isClearanceState(state)) {
    throw new MulClearanceValidationError(
      'invalid_clearance_state',
      field,
      `state must be one of: ${CLEARANCE_STATES.join(', ')}.`,
    );
  }
  // The seam widening itself — the membership check above proved the runtime
  // value is a canonical clearance state, and every backend column is
  // unconstrained TEXT (see the seam note in the header). 'revoked' has no
  // member in the seam's TS union yet; this cast is the entire gap.
  return state as MulClearanceState;
}

/** The store's narrow vocabulary, imported as a type only — no runtime graph. */
type MulClearanceState = MulClearanceRecord['state'];

/** Serializes a domain clearance into the Store seam's current-state row. */
export function clearanceToRecord(clearance: MulClearance): MulClearanceRecord {
  return {
    asset_cbt_code: clearance.assetCbtCode,
    state: asStoreState(clearance.state, 'state'),
    licensee: clearance.licensee,
    territory: clearance.territory,
    term_start: clearance.termStart,
    term_end: clearance.termEnd,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Parses a stored row back into the domain shape — parse, don't cast: a row
 * this SDK version cannot affirm (unknown state, malformed territory or
 * terms) is a typed failure, never a silent passthrough.
 */
export function clearanceFromRecord(row: MulClearanceRecord): MulClearance {
  const state = row.state;
  if (!isClearanceState(state)) {
    throw new MulClearanceValidationError(
      'invalid_clearance_state',
      'state',
      `stored clearance state is not in this SDK's vocabulary: ${String(state)}.`,
    );
  }
  const territory = row.territory;
  if (territory !== null && !ISO_3166_1_ALPHA_2_PATTERN.test(territory)) {
    throw new MulClearanceValidationError(
      'invalid_territory',
      'territory',
      'stored territory is not ISO 3166-1 alpha-2.',
    );
  }
  const assetCbtCode = row.asset_cbt_code;
  if (!ASSET_CBT_CODE_PATTERN.test(assetCbtCode)) {
    throw new MulClearanceValidationError(
      'invalid_asset_cbt_code',
      'assetCbtCode',
      'stored asset_cbt_code does not match the engine-minted CBT shape.',
    );
  }
  return {
    assetCbtCode,
    state,
    licensee: row.licensee,
    territory,
    termStart: row.term_start,
    termEnd: row.term_end,
  };
}

/** Serializes a stored transition row into the audit history's wire entry. */
export function transitionFromRecord(row: MulClearanceTransitionRecord): {
  id: string;
  assetCbtCode: string;
  fromState: ClearanceState | null;
  toState: ClearanceState;
  note: string | null;
  createdAt: string;
} {
  if (!isClearanceState(row.to_state)) {
    throw new MulClearanceValidationError(
      'invalid_clearance_state',
      'toState',
      `stored transition to_state is not in this SDK's vocabulary: ${String(row.to_state)}.`,
    );
  }
  if (row.from_state !== null && !isClearanceState(row.from_state)) {
    throw new MulClearanceValidationError(
      'invalid_clearance_state',
      'fromState',
      `stored transition from_state is not in this SDK's vocabulary: ${String(row.from_state)}.`,
    );
  }
  return {
    id: row.id,
    assetCbtCode: row.asset_cbt_code,
    fromState: row.from_state,
    toState: row.to_state,
    note: row.note,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Reads and transitions — the machine's public surface.
// ---------------------------------------------------------------------------

/**
 * Reads one asset's current clearance; null when no clearance exists (the
 * Event lifecycle's "No clearance" blocked condition — absence is a distinct
 * state from draft, never conflated).
 */
export async function getClearance(
  store: ClearanceStore,
  assetCbtCode: string,
): Promise<MulClearance | null> {
  const row = await store.getClearanceForAsset(assetCbtCode);
  return row === undefined ? null : clearanceFromRecord(row);
}

/** One requested machine move. Fields persist canonically; history appends. */
export interface ClearanceTransitionInput {
  assetCbtCode: string;
  to: ClearanceState;
  /** Who may collect — set or updated on any transition; omitted preserves. */
  licensee?: string | null;
  /** ISO 3166-1 alpha-2 — set or updated on any transition; omitted preserves. */
  territory?: string | null;
  /** Parseable timestamp — set or updated on any transition; omitted preserves. */
  termStart?: string | null;
  /** Parseable timestamp — set or updated on any transition; omitted preserves. */
  termEnd?: string | null;
  /** Human-readable reason, carried on the append-only history row. */
  note?: string | null;
}

/**
 * Moves one asset's clearance along a legal machine edge and persists both
 * halves of the write: the current row (upsertClearance) and the append-only
 * history entry (insertClearanceTransition). Illegal edges, unknown states,
 * and invalid fields are typed refusals — nothing partial is written.
 */
export async function transitionClearance(
  store: ClearanceStore,
  input: ClearanceTransitionInput,
): Promise<MulClearance> {
  const assetCbtCode = nonEmpty(
    requireStringOrNull(input.assetCbtCode, 'assetCbtCode', 'invalid_asset_cbt_code'),
  );
  if (assetCbtCode === null) {
    throw new MulClearanceValidationError(
      'invalid_asset_cbt_code',
      'assetCbtCode',
      'assetCbtCode is required — the machine addresses assets, never vibes.',
    );
  }
  if (!isClearanceState(input.to)) {
    throw new MulClearanceValidationError(
      'invalid_clearance_state',
      'to',
      `to must be one of: ${CLEARANCE_STATES.join(', ')}.`,
    );
  }
  const licenseeInput = requireStringOrNull(input.licensee, 'licensee', 'invalid_licensee');
  const territoryInput = requireStringOrNull(input.territory, 'territory', 'invalid_territory');
  const termStartInput = requireStringOrNull(input.termStart, 'termStart', 'invalid_term');
  const termEndInput = requireStringOrNull(input.termEnd, 'termEnd', 'invalid_term');
  const noteInput = requireStringOrNull(input.note, 'note', 'invalid_note');

  const current = await store.getClearanceForAsset(assetCbtCode);
  const fromState = current === undefined ? null : clearanceFromRecord(current).state;
  const legal =
    fromState === null ? input.to === 'draft' : CLEARANCE_TRANSITIONS[fromState].includes(input.to);
  if (!legal) {
    throw new ClearanceTransitionError(fromState, input.to);
  }

  const merged = {
    assetCbtCode,
    state: input.to,
    licensee: licenseeInput !== undefined ? nonEmpty(licenseeInput) : (current?.licensee ?? null),
    territory:
      territoryInput !== undefined ? nonEmpty(territoryInput) : (current?.territory ?? null),
    termStart:
      termStartInput !== undefined
        ? parseTerm(nonEmpty(termStartInput), 'termStart')
        : (current?.term_start ?? null),
    termEnd:
      termEndInput !== undefined
        ? parseTerm(nonEmpty(termEndInput), 'termEnd')
        : (current?.term_end ?? null),
  };
  validateFields(merged);

  const next = clearanceToRecord(merged);
  await store.upsertClearance(next);
  await store.insertClearanceTransition({
    asset_cbt_code: assetCbtCode,
    from_state: fromState === null ? null : asStoreState(fromState, 'state'),
    to_state: asStoreState(input.to, 'to_state'),
    note: nonEmpty(noteInput),
    created_at: new Date().toISOString(),
  });
  return clearanceFromRecord(next);
}

// ---------------------------------------------------------------------------
// The dispatch gate — the check every collection node's material must pass.
// ---------------------------------------------------------------------------

/**
 * The MUL dispatch gate. Throws ClearanceBlockedError unless the asset is
 * cleared with a term that is currently open — fail-closed on missing,
 * disputed, revoked, expired, not-yet-started, malformed, and corrupt alike.
 * Term boundaries are inclusive: a license is collectible from termStart
 * through termEnd, and `now` one instant past termEnd is expired.
 *
 * Absent clearance is the Blocked row's "No clearance" condition, so null
 * and undefined are refusals too — a gate that skipped missing rows would be
 * a hole, not a convenience.
 */
export function assertCollectible(
  clearance: MulClearance | null | undefined,
  now: Date = new Date(),
): void {
  if (clearance === null || clearance === undefined) {
    throw new ClearanceBlockedError(
      'clearance_missing',
      '<none>',
      'no MUL clearance exists for this asset — dispatch is refused, fail-closed.',
    );
  }
  const { assetCbtCode, state } = clearance;
  if (state !== 'cleared') {
    throw new ClearanceBlockedError(
      `clearance_${state}`,
      assetCbtCode,
      `the asset's clearance is ${state}, not cleared — the node refuses, fail-closed.`,
    );
  }
  const start = parseTermInstant(clearance.termStart);
  const end = parseTermInstant(clearance.termEnd);
  if ((clearance.termStart !== null && start === null) || (clearance.termEnd !== null && end === null)) {
    throw new ClearanceBlockedError(
      'clearance_term_invalid',
      assetCbtCode,
      'a stored term boundary is unparseable — a corrupt term is never dispatched.',
    );
  }
  if (start !== null && now.getTime() < start) {
    throw new ClearanceBlockedError(
      'clearance_term_not_started',
      assetCbtCode,
      `the license term starts at ${clearance.termStart} — dispatch before the term is refused.`,
    );
  }
  if (end !== null && now.getTime() > end) {
    throw new ClearanceBlockedError(
      'clearance_term_expired',
      assetCbtCode,
      `the license term ended at ${clearance.termEnd} — an expired term is not cleared.`,
    );
  }
}

/**
 * The store-backed form of the gate: read the asset's clearance, then
 * `assertCollectible` it. This is the call a node's dispatch path makes
 * before an asset's material may flow to the matcher and the money lane;
 * the returned clearance is the proof the caller collected under.
 */
export async function assertDispatchable(
  store: ClearanceStore,
  assetCbtCode: string,
  now: Date = new Date(),
): Promise<MulClearance> {
  const clearance = await getClearance(store, assetCbtCode);
  if (clearance === null) {
    throw new ClearanceBlockedError(
      'clearance_missing',
      assetCbtCode,
      'no MUL clearance exists for this asset — dispatch is refused, fail-closed.',
    );
  }
  assertCollectible(clearance, now);
  return clearance;
}
