/**
 * Luminate cross-referencing — the RESERVED ingest surface, v1.
 *
 * The build spec (art_MzwqTXym) reserves this surface for cross-referencing
 * collected royalty events and recovery candidates against Luminate's
 * dataset: "Luminate cross-referencing (later phase) reads the same ledger."
 * The concrete mapping CANNOT be built yet — the user supplies the full
 * Luminate statement layout structure alongside their streaming modules,
 * and the mapping lands then (this PR or a fast follow-up). Until it
 * arrives this module deliberately speculates NOTHING about the format:
 * no field names, no sheet organization, no money column, no identifier
 * columns. Inventing any of it would bake wrong guesses into a typed
 * contract.
 *
 * What v1 builds is the EXTENSION POINT, fail-closed:
 *
 * - `createLuminateIngest(null)` — and the exported `RESERVED_LUMINATE_INGEST`
 *   singleton — is the reserved surface: `parseStatement` refuses with the
 *   typed `luminate_not_configured` refusal, the repo's fail-closed posture
 *   (missing configuration never produces a guess; the
 *   SdkNotConfiguredError family from the node framework).
 * - When the layout arrives, wiring is a CONFIGURATION change, not a
 *   call-site change: `createLuminateIngest({ layout, mapStatement })`
 *   returns a wired surface that delegates to the supplied mapper, and
 *   call sites keep calling `parseStatement(statement)` unchanged.
 *
 * When the concrete mapping lands it must route through the canonical
 * royalty-event contract's parse boundary and the statement-parser
 * framework's provenance discipline — never a private shortcut.
 */

import type { CanonicalRoyaltyEvent } from '../contracts/royalty-event';
import { SdkMalformedInputError, SdkNotConfiguredError } from '../nodes/errors';

/** The reserved surface's fail-closed refusal code. */
export const LUMINATE_NOT_CONFIGURED = 'luminate_not_configured';

/** `reserved` — no layout supplied; `wired` — the mapping landed and is active. */
export type LuminateSurfaceState = 'reserved' | 'wired';

/**
 * The Luminate statement layout — RESERVED, and the extension point's data
 * slot. The user supplies the full layout structure (their streaming
 * modules define it); v1 types it as an opaque readonly record and the
 * concrete interface is finalized WITH the layout and the mapping that
 * consumes it. Nothing here presumes a field.
 */
export type LuminateStatementLayout = Readonly<Record<string, unknown>>;

/** One raw Luminate statement — verbatim bytes plus file provenance. */
export interface LuminateStatementInput {
  readonly fileName: string;
  readonly content: string;
}

/**
 * The mapper the concrete mapping supplies once the layout lands: raw
 * statement plus the user's layout in, canonical royalty events out.
 * Pure by contract — ingestion provenance stays with the statement-parser
 * framework, and the canonical contract's parse boundary stays the only
 * shape a mapped event can take.
 */
export type LuminateStatementMapper = (
  statement: LuminateStatementInput,
  layout: LuminateStatementLayout,
) => CanonicalRoyaltyEvent[];

export interface LuminateIngestConfig {
  readonly layout: LuminateStatementLayout;
  readonly mapStatement: LuminateStatementMapper;
}

export interface LuminateIngest {
  readonly state: LuminateSurfaceState;
  /**
   * Parses one Luminate statement into canonical royalty events. On the
   * reserved surface this ALWAYS throws SdkNotConfiguredError with the
   * `luminate_not_configured` code — no format is invented, no guess is
   * returned, ever.
   */
  parseStatement(statement: LuminateStatementInput): CanonicalRoyaltyEvent[];
}

/** The reserved surface singleton — every v1 call site holds one of these. */
export const RESERVED_LUMINATE_INGEST: LuminateIngest = {
  state: 'reserved',
  parseStatement(): CanonicalRoyaltyEvent[] {
    throw new SdkNotConfiguredError(LUMINATE_NOT_CONFIGURED);
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds the ingest surface. `null` (or any absent configuration) returns
 * the reserved singleton — the fail-closed stub. A configuration with a
 * layout and a mapper returns the wired surface; malformed configuration
 * throws at the wiring site, never at parse time.
 */
export function createLuminateIngest(config: LuminateIngestConfig | null): LuminateIngest {
  if (config === null) return RESERVED_LUMINATE_INGEST;
  if (!isPlainObject(config.layout)) {
    throw new SdkMalformedInputError('invalid_luminate_config:layout');
  }
  if (typeof config.mapStatement !== 'function') {
    throw new SdkMalformedInputError('invalid_luminate_config:mapStatement');
  }
  return {
    state: 'wired',
    parseStatement: (statement) => config.mapStatement(statement, config.layout),
  };
}
