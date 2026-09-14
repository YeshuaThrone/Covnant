/**
 * The node framework's typed failure vocabulary — the two ways a collection
 * node says no.
 *
 * `SdkNotConfiguredError` is the fail-closed configuration refusal: the
 * src/services/baas posture (`baas_not_configured`) carried over. Its `code`
 * is a stable machine string — `<platform>_not_configured` for registry
 * lookups, `statement_parser_not_configured` for unwired statement formats —
 * so callers branch on the code, never on prose.
 *
 * `SdkMalformedInputError` is the structural refusal: input a node cannot
 * affirm carries a stable `reason` (the canonical parser's rejection reasons,
 * plus node-level ones) and, for batch payloads, the offending item's index.
 * A node never drops or reshapes input silently — it either returns canonical
 * events or throws one of these.
 */

/** Fail-closed configuration refusal — the `*_not_configured` family. */
export class SdkNotConfiguredError extends Error {
  /** Stable machine code, e.g. `spotify_not_configured`. */
  readonly code: string;

  constructor(code: string) {
    super(`Universal Royalty Collection SDK: not configured — ${code}`);
    this.name = 'SdkNotConfiguredError';
    this.code = code;
  }
}

/** Structural refusal — input the node cannot affirm, with a stable reason. */
export class SdkMalformedInputError extends Error {
  /** Stable machine reason, e.g. `missing_key:currency` or `empty_webhook_payload`. */
  readonly reason: string;
  /** Index within a batch payload; null when the input is not item-scoped. */
  readonly index: number | null;

  constructor(reason: string, index: number | null = null) {
    super(
      `Universal Royalty Collection SDK: input rejected — ${reason}${
        index === null ? '' : ` [item ${index}]`
      }`,
    );
    this.name = 'SdkMalformedInputError';
    this.reason = reason;
    this.index = index;
  }
}
