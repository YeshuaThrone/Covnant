/**
 * The territory settlement seam — the read-side projection over the
 * tier-universe royalty ledger (universal_royalty_ledger) that extracts the
 * SDK-settled events' territory data (spec art_qNu4T32F, "Top Markets").
 *
 * WHERE the data lives: the wire (covnant-sdk/src/engine/wire.ts,
 * settlementMetadata) stamps every SDK settlement credit with a `sdk`
 * metadata payload — `territory` (the canonical event's ISO 3166-1 alpha-2,
 * null when the source carried none) and `split_run_id` (the Don-universe
 * split run the settlement drove). Territory exists NOWHERE else in the
 * readable analytics surfaces. This module is the honest read over that
 * stamp: SDK-settled credits ONLY (transaction_type of record below), every
 * absent fact an honest null, money as bigint cents.
 *
 * PURE on purpose: no store, no engine, no I/O — each Store backend
 * (SupabaseStore / SqliteStore / InMemoryStore) maps its raw rows through
 * `territorySettlementOfRow` so the projection exists exactly once.
 */

/** The wire's tier-credit transaction_type of record (SDK_SETTLEMENT_TRANSACTION_TYPE in covnant-sdk/src/engine/wire.ts). Restated here — importing the wire would pull the whole settlement engine into every store consumer for one string. */
export const SDK_SETTLEMENT_TRANSACTION_TYPE = 'SDK_ROYALTY_SETTLEMENT';

/**
 * One tier-ledger credit row — the shape the wire's INSERT writes (the
 * 0001 core columns the seam never reads are omitted). `amount_cents` is
 * the wire's own text-cents discipline; `metadata` is the stamped JSONB as
 * the client returns it (object) or as TEXT storage carries it (string).
 */
export interface UniversalRoyaltyLedgerRow {
  readonly transaction_id: string;
  readonly rights_holder_id: string | null;
  readonly amount_cents: string | number;
  readonly transaction_type: string | null;
  readonly reference_id: string | null;
  readonly metadata: unknown;
  readonly created_at: string;
}

/**
 * One SDK-settled credit's territory projection — the Store read's output
 * row. bigint cents (the derivation consumes it directly); the nullable
 * fields are the honest absences: a credit whose stamp predates run
 * provenance, whose event carried no territory, or whose holder of record
 * is unstated.
 */
export interface TerritorySettlementRecord {
  /** metadata.sdk.split_run_id — the join key to the Don-universe split run. */
  readonly split_run_id: string | null;
  /** metadata.sdk.territory — verbatim (ISO 3166-1 alpha-2 of the canonical event). */
  readonly territory: string | null;
  /** The credit's rights_holder_id of record. */
  readonly rights_holder_id: string | null;
  /** The credit's amount_cents — bigint, the ledger's own unit. */
  readonly amount_cents: bigint;
  /** The credit's created_at — the settlement instant of record. */
  readonly created_at: string;
}

/** True when the tier row's transaction_type marks an SDK settlement credit — the SDK-settled-only gate. */
export function isSdkSettlementTransactionType(transactionType: unknown): boolean {
  return transactionType === SDK_SETTLEMENT_TRANSACTION_TYPE;
}

/**
 * The stamped metadata as an object — a TEXT-stored JSON string parses once,
 * a client-decoded object passes through, anything else (null, corrupt
 * JSON, non-object) is an honest null. Never throws on bad data.
 */
export function parsedMetadataOf(metadata: unknown): Record<string, unknown> | null {
  let value = metadata;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The stamped `sdk` payload — null when the credit carries none. */
export function sdkPayloadOf(metadata: unknown): Record<string, unknown> | null {
  const parsed = parsedMetadataOf(metadata);
  if (parsed === null) return null;
  const sdk = parsed.sdk;
  return typeof sdk === 'object' && sdk !== null && !Array.isArray(sdk)
    ? (sdk as Record<string, unknown>)
    : null;
}

/** Projects one tier-credit row into the seam's record. A corrupt amount is a thrown failure (never a guessed cent); absent identity fields are honest nulls. */
export function territorySettlementOfRow(
  row: UniversalRoyaltyLedgerRow,
): TerritorySettlementRecord {
  const sdk = sdkPayloadOf(row.metadata);
  const territory = sdk?.territory;
  const splitRunId = sdk?.split_run_id;
  return {
    split_run_id: typeof splitRunId === 'string' && splitRunId !== '' ? splitRunId : null,
    territory: typeof territory === 'string' && territory !== '' ? territory : null,
    rights_holder_id: row.rights_holder_id,
    amount_cents: BigInt(row.amount_cents),
    created_at: row.created_at,
  };
}
