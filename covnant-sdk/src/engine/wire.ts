/**
 * The engine wire — the ONLY path from collection to money (build spec
 * art_MzwqTXym, "Canonical contracts": this module is the spec's wire.ts).
 *
 * One function, one direction: a matched, cleared royalty event becomes a
 * settled split run through the LOCKED Don Engine orchestrator —
 * `calculateUdrSplits` (src/lib/server/udrSplits.ts) — and nothing else in
 * the SDK ever touches money. The three disciplines this wire must honor:
 *
 * 1. Call, never reimplement. Allocation, the 10,000-bps gate, floor-based
 *    shares, company dust, withholding, recoupment, GL posting — all of it
 *    belongs to the engine and its sanctified dust core (dust.ts,
 *    splitEngine.ts). The wire converts units and carries results; it adds
 *    no math of its own. The three-gate 100% ladder (engine ±1-unit,
 *    exact 10,000-bps, strict 1,000,000-unit save gate) stands untouched.
 *
 * 2. The floor+dust invariant, applied one level up. The canonical event's
 *    `grossMicros` is 1e-8 fixed point (src/lib/fixed-point.ts); the Don
 *    lane is LOCKED to integer cents. The wire floors the gross to cents
 *    for the engine run, and the sub-cent remainder is swept to the COMPANY
 *    as dust — never to a payee — recorded on the settlement credit at full
 *    fixed-point precision (`company_dust_micros`, text micros, never a
 *    float). One level up means exactly that: the wire floors, the engine's
 *    own floor+dust discipline runs inside it on the integer cents.
 *
 * 3. event_id / reference_id replay idempotency. The settlement credit this
 *    wire writes into the Covnant tier ledger (universal_royalty_ledger)
 *    keys its UNIQUE `reference_id` off the canonical event's id —
 *    `sdk_settlement:<eventId>` — so a replayed statement or webhook
 *    produces EXACTLY ONE credit: the replay is detected before any money
 *    moves (check-first, the DSP ingest discipline), and the ledger's
 *    UNIQUE index is the final guard (23505 → the existing credit is
 *    returned, idempotent). The credit carries the deterministic CBT
 *    settlement stamp (withCbtSettlementCode — same reference_id, same
 *    code, forever), extending PR #30's stamp-site pin to this write site.
 *
 * Fail-closed, always. The MUL dispatch gate (`assertCollectible`) throws
 * before anything moves; an asset without a resolvable row, a split sheet
 * that does not read exactly 100.0000% (the studio save gate's promise), or
 * a corrupt holder entry is a typed refusal; a database failure other than
 * the two handled codes propagates — the wire never guesses money.
 *
 * Two ledger universes, as applicable. The Don-universe rows the engine
 * writes (ledger_transactions, company_dust_ledger, GL) carry no metadata
 * column — stamping does not apply there. The tier-universe credit the wire
 * writes DOES — and is stamped at INSERT, with the same 42703 fallback every
 * other stamped site follows (money never blocks on provenance).
 *
 * Honesty note, on record: the check-first replay guard leaves the same
 * concurrent-race window the DSP webhook lane accepts (two same-event calls
 * racing could both pass the check). The UNIQUE reference_id index still
 * guarantees exactly one tier credit; the idempotent branch returns the
 * existing credit in that case rather than a second one.
 */

import type { Db, DbClient } from '@/lib/db';
import type {
  LedgerTransactionRecord,
  PayeeRole,
  RoyaltyLineItemInput,
  SplitCalculateInput,
  SplitPartyInput,
  SplitRunRecord,
} from '@/lib/don/types';
import type { CompanyDustRecord } from '@/modules/don/records';
import {
  isMissingMetadataColumnError,
  METADATA_COLUMN_DDL_NOTE,
  withCbtSettlementCode,
} from '@/lib/ledger/cbt-settlement';
import { MICRO_SCALE } from '@/lib/fixed-point';
import { RIGHTS_HOLDER_ROLES, TARGET_UNITS, type RightsHolderRole } from '@/lib/splits/shared';
import type { Store } from '@/lib/server/store';
import { calculateUdrSplits } from '@/lib/server/udrSplits';
import type { CanonicalRoyaltyEvent } from '../contracts/royalty-event';
import { assertCollectible, type MulClearance } from '../mul/clearance';
import { SdkMalformedInputError } from '../nodes/errors';

/** 10⁸ micros per currency unit ÷ 100 cents per unit — 1 cent in micros. */
const MICROS_PER_CENT = MICRO_SCALE / 100n;

/**
 * The tier-ledger transaction_type for SDK settlements. Open TEXT by design
 * (the increase lane's vertical-agnostic guarantee); this value is the SDK's.
 */
export const SDK_SETTLEMENT_TRANSACTION_TYPE = 'SDK_ROYALTY_SETTLEMENT';

/** The deterministic tier-credit reference for one canonical event id. */
export function settlementReferenceId(eventId: string): string {
  return `sdk_settlement:${eventId}`;
}

/** The split_runs.source provenance for wire-driven runs. */
export function settlementSource(event: CanonicalRoyaltyEvent): string {
  return `covnant-sdk:${event.rightsPipeline}`;
}

/** A matched event — what the matcher hands the wire. */
export interface MatchedEvent {
  /** The canonical event (already boundary-parsed; never re-guessed here). */
  readonly event: CanonicalRoyaltyEvent;
  /** The exact-match resolution: the asset's canonical CBT code. */
  readonly cbtCode: string;
  /** The clearance proof the dispatch gate runs on. */
  readonly clearance: MulClearance;
}

/** The settlement credit the wire writes into the Covnant tier ledger. */
export interface SettlementCredit {
  /** universal_royalty_ledger.transaction_id — this wire's row identity. */
  readonly transactionId: string;
  /** The UNIQUE replay key: sdk_settlement:<eventId>. */
  readonly referenceId: string;
  /** The stamped metadata payload; null when the additive column is absent. */
  readonly metadata: Record<string, unknown> | null;
}

/** The wire's success shape. */
export interface WireSettlementSuccess {
  readonly ok: true;
  /** True when the event was already settled — exactly one credit stands. */
  readonly idempotent: boolean;
  /**
   * The engine's split run. Null only for a replay whose original run id is
   * unrecoverable (a credit written before split-run provenance existed).
   */
  readonly splitRun: SplitRunRecord | null;
  readonly ledger: LedgerTransactionRecord[];
  readonly companyDustLedger: CompanyDustRecord[];
  readonly varianceAccountCents: number;
  /** The sub-cent remainder swept to the company, at full precision. */
  readonly subCentDustMicros: bigint | null;
  readonly credit: SettlementCredit;
}

/** The wire's failure shape — calculateUdrSplits' refusal vocabulary. */
export interface WireSettlementFailure {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

export type WireSettlement = WireSettlementSuccess | WireSettlementFailure;

// ---------------------------------------------------------------------------
// Unit conversion — percent-units sheet → Don-lane bps, and micros → cents.
// ---------------------------------------------------------------------------

/** The gross's integer-cent floor plus the sub-cent remainder swept to dust. */
export interface GrossConversion {
  /** Integer cents for the Don lane — LOCKED integer discipline. */
  readonly grossCents: number;
  /** grossMicros % one cent, in micros — company dust, never a payee's. */
  readonly subCentDustMicros: bigint;
}

/**
 * Floors the event's fixed-point gross into Don-lane integer cents. The
 * locked floor+dust invariant, applied one level up: the engine receives
 * integer cents only; the sub-cent remainder is company dust. A gross whose
 * cent value exceeds the Don lane's number space is a typed refusal — the
 * SDK never loses money precision to a float.
 */
export function convertGross(grossMicros: bigint): GrossConversion {
  const grossCents = grossMicros / MICROS_PER_CENT;
  const subCentDustMicros = grossMicros % MICROS_PER_CENT;
  if (grossCents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SdkMalformedInputError('gross_cents_exceed_safe_integer');
  }
  return { grossCents: Number(grossCents), subCentDustMicros };
}

/**
 * One stored rights holder, parsed (never cast) out of cbt_assets
 * rights_holders JSONB. Every field the split needs is verified; anything
 * else is a typed refusal — a silently dropped holder would reshape money.
 */
interface ParsedHolder {
  readonly payeeId: string;
  readonly payeeName: string;
  readonly role: PayeeRole;
  /** The stored sheet's units (percentage × 10,000; the save gate's space). */
  readonly units: number;
  /** Sub-bp remainder units, for the residual distribution below. */
  readonly subBpsUnits: number;
  /** The holder's UCT when stored (signup-minted), else the holder id. */
  readonly holderReference: string;
}

const HOLDER_ROLE_TO_PAYEE_ROLE: Readonly<Record<RightsHolderRole, PayeeRole>> = {
  // Composition-side creators — creator-role parties carry the locked
  // backup-withholding rule inside the engine.
  COMPOSER: 'creator',
  LYRICIST: 'creator',
  PRODUCER: 'producer',
  PUBLISHER: 'publisher',
  STUDIO: 'label',
  DISTRIBUTOR: 'label',
  DIRECTOR: 'other',
  ACTOR: 'other',
  HOST: 'other',
};

function parseHolder(raw: unknown, index: number): ParsedHolder {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SdkMalformedInputError(`corrupt_rights_holder:${index}`);
  }
  const holder = raw as Record<string, unknown>;
  const payeeId = holder.id;
  const payeeName = holder.name;
  const role = holder.role;
  const splitPercentage = holder.splitPercentage;
  if (typeof payeeId !== 'string' || payeeId.length === 0) {
    throw new SdkMalformedInputError(`corrupt_rights_holder_id:${index}`);
  }
  if (typeof payeeName !== 'string' || payeeName.length === 0) {
    throw new SdkMalformedInputError(`corrupt_rights_holder_name:${index}`);
  }
  if (typeof role !== 'string' || !RIGHTS_HOLDER_ROLES.includes(role as RightsHolderRole)) {
    throw new SdkMalformedInputError(`corrupt_rights_holder_role:${index}`);
  }
  if (typeof splitPercentage !== 'number' || !Number.isFinite(splitPercentage) || splitPercentage < 0) {
    throw new SdkMalformedInputError(`corrupt_rights_holder_split:${index}`);
  }
  const uct = holder.uct;
  const holderReference =
    typeof uct === 'string' && uct.length > 0 ? uct : payeeId;
  // The sheet builder's own rebuild: units = percentage × SPLIT_SCALE
  // (multi-pool.ts buildPoolWeightedSheet). The units are the stored truth
  // the strict save gate sums to exactly 1,000,000.
  const units = Math.round(splitPercentage * 10_000);
  return {
    payeeId,
    payeeName,
    role: HOLDER_ROLE_TO_PAYEE_ROLE[role as RightsHolderRole],
    units,
    subBpsUnits: units % 100,
    holderReference,
  };
}

/**
 * The minimal sheet slice holderSplitBps converts — ParsedHolder satisfies
 * it structurally; tests hand the same slice.
 */
export interface SheetUnitsSlice {
  readonly units: number;
  readonly subBpsUnits: number;
}

/**
 * Converts the stored sheet (units summing EXACTLY to 1,000,000 — the studio
 * save gate's promise, re-verified here before anything moves) into Don-lane
 * integer bps summing EXACTLY to the engine's 10,000 gate: per-holder floor
 * (units ÷ 100) plus the sub-bp residue distributed one unit at a time to
 * the largest fractional remainder — the sheet builder's own residual-unit
 * convention. Deterministic; a holder shifts at most +1 bp (0.01%) from its
 * floor. The engine re-validates the result through its own exact gate
 * inside calculateUdrSplits — the wire adds no validation of its own beyond
 * refusing sheets that are not at the strict gate.
 */
export function holderSplitBps(sheet: readonly SheetUnitsSlice[]): number[] {
  const unitsTotal = sheet.reduce((total, holder) => total + holder.units, 0);
  if (unitsTotal !== TARGET_UNITS) {
    throw new SdkMalformedInputError('split_sheet_not_at_strict_gate');
  }
  const bps = sheet.map((holder) => Math.floor(holder.units / 100));
  let residue = TARGET_UNITS / 100 - bps.reduce((total, value) => total + value, 0);
  const order = sheet
    .map((holder, index) => ({ index, remainder: holder.subBpsUnits }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (residue <= 0) break;
    bps[index] += 1;
    residue -= 1;
  }
  return bps;
}

// ---------------------------------------------------------------------------
// The tier-credit write site — the SDK's own ledger write, CBT-stamped.
// ---------------------------------------------------------------------------

/** The asset sheet the wire settles against (cbt_assets, read-only). */
interface AssetSheetRow {
  cbt_code: string;
  title: string;
  rights_holders: unknown;
}

const ASSET_SHEET_SQL =
  'SELECT cbt_code, title, rights_holders FROM cbt_assets WHERE cbt_code = $1 LIMIT 1';

/** The replay guard's read — the additive metadata column degrades gracefully. */
const CREDIT_SELECT_SQL =
  'SELECT transaction_id, reference_id, metadata FROM universal_royalty_ledger WHERE reference_id = $1 LIMIT 1';
const CREDIT_SELECT_WITHOUT_METADATA_SQL =
  'SELECT transaction_id, reference_id FROM universal_royalty_ledger WHERE reference_id = $1 LIMIT 1';

/**
 * The settlement credit's INSERT — the increase webhook's exact column set
 * (the pinned live money path): additive columns only, never the 0001 core.
 * Stamped at INSERT with the deterministic CBT settlement code; the 42703
 * fallback below keeps money moving when the additive metadata column is
 * absent, the same discipline every stamped site follows.
 */
const CREDIT_INSERT_SQL =
  'INSERT INTO universal_royalty_ledger (rights_holder_id, amount_cents, transaction_type, reference_id, created_at, metadata) VALUES ($1, $2, $3, $4, NOW(), $5::jsonb)';
const CREDIT_INSERT_WITHOUT_METADATA_SQL =
  'INSERT INTO universal_royalty_ledger (rights_holder_id, amount_cents, transaction_type, reference_id, created_at) VALUES ($1, $2, $3, $4, NOW())';

interface CreditRow {
  transaction_id: string | null;
  reference_id: string | null;
  metadata?: Record<string, unknown> | null;
}

/** PostgreSQL unique-violation vocabulary (the 23505 replay guard). */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === '23505') return true;
  const message = error instanceof Error ? error.message : '';
  return /UNIQUE constraint failed|duplicate key/i.test(message);
}

/** Reads the replay guard row; 42703 (no additive column yet) degrades. */
async function selectCreditByReference(
  db: Db | DbClient,
  referenceId: string,
): Promise<CreditRow | null> {
  try {
    const result = await db.query<CreditRow>(CREDIT_SELECT_SQL, [referenceId]);
    return result.rows[0] ?? null;
  } catch (error) {
    if (!isMissingMetadataColumnError(error)) throw error;
    const result = await db.query<CreditRow>(CREDIT_SELECT_WITHOUT_METADATA_SQL, [referenceId]);
    return result.rows[0] ?? null;
  }
}

function creditFromRow(row: CreditRow, referenceId: string): SettlementCredit {
  return {
    transactionId: row.transaction_id ?? referenceId,
    referenceId: row.reference_id ?? referenceId,
    metadata: row.metadata ?? null,
  };
}

/** Reads one prior run back out of the store seam for a replayed event. */
async function reconstructRun(
  store: Store,
  metadata: Record<string, unknown> | null,
): Promise<{
  splitRun: SplitRunRecord | null;
  ledger: LedgerTransactionRecord[];
  companyDustLedger: CompanyDustRecord[];
  varianceAccountCents: number;
}> {
  const sdk = (metadata?.sdk ?? null) as Record<string, unknown> | null;
  const splitRunId = typeof sdk?.split_run_id === 'string' ? sdk.split_run_id : null;
  if (splitRunId === null) {
    return { splitRun: null, ledger: [], companyDustLedger: [], varianceAccountCents: 0 };
  }
  const splitRun = (await store.getSplitRun(splitRunId)) ?? null;
  const ledger = splitRun ? await store.listLedgerTransactionsByRun(splitRunId) : [];
  const companyDustLedger = splitRun ? await store.listCompanyDustByRun(splitRunId) : [];
  return {
    splitRun,
    ledger,
    companyDustLedger,
    varianceAccountCents: splitRun?.variance_account_cents ?? 0,
  };
}

/** Parses a stored fixed-point micros text back to bigint; null when absent. */
function microsFromMetadata(metadata: Record<string, unknown> | null): bigint | null {
  const sdk = (metadata?.sdk ?? null) as Record<string, unknown> | null;
  const dust = sdk?.company_dust_micros;
  if (typeof dust !== 'string' || !/^\d+$/.test(dust)) return null;
  return BigInt(dust);
}

// ---------------------------------------------------------------------------
// The conversion — event + asset sheet → the engine's split input.
// ---------------------------------------------------------------------------

/** The plan toSplitInput hands the engine: one line item plus the swept dust. */
export interface SplitInputPlan {
  readonly lineItems: readonly RoyaltyLineItemInput[];
  /** The sub-cent remainder swept to the company — never a payee's. */
  readonly subCentDustMicros: bigint;
  /** The tier credit's rights_holder_id (first holder's UCT, else its id). */
  readonly rightsHolderId: string | null;
}

/**
 * Builds calculateUdrSplits' input from the canonical event and the matched
 * asset's stored sheet — the spec's toSplitInput. The sheet's holders become
 * the line item's SplitPartyInput[] (strict parse, exact bps conversion);
 * the gross floors to integer cents with the sub-cent remainder reserved as
 * company dust. Pure — no I/O, no math beyond the conversions above.
 */
export function toSplitInput(
  event: CanonicalRoyaltyEvent,
  cbtCode: string,
  title: string,
  rightsHolders: unknown,
): SplitInputPlan {
  if (!Array.isArray(rightsHolders)) {
    throw new SdkMalformedInputError('corrupt_rights_holders');
  }
  const holders = rightsHolders.map(parseHolder);
  const bps = holderSplitBps(holders);
  const { grossCents, subCentDustMicros } = convertGross(event.grossMicros);
  const splits: SplitPartyInput[] = holders.map((holder, index) => ({
    payee_id: holder.payeeId,
    payee_name: holder.payeeName,
    role: holder.role,
    share_bps: bps[index]!,
  }));
  return {
    lineItems: [
      {
        work_id: cbtCode,
        work_title: title,
        amount_cents: grossCents,
        splits,
      },
    ],
    subCentDustMicros,
    rightsHolderId: holders[0]?.holderReference ?? null,
  };
}

/** The settlement credit's stamped metadata payload. */
function settlementMetadata(
  event: CanonicalRoyaltyEvent,
  cbtCode: string,
  splitRunId: string,
  subCentDustMicros: bigint,
  referenceId: string,
): Record<string, unknown> {
  return withCbtSettlementCode(
    {
      cbt_asset: cbtCode,
      sdk: {
        event_id: event.eventId,
        rights_pipeline: event.rightsPipeline,
        source: event.source,
        ...(event.statementFormat === undefined ? {} : { statement_format: event.statementFormat }),
        period: event.period,
        platform: event.platform,
        territory: event.territory,
        currency: event.currency,
        gross_micros: event.grossMicros.toString(),
        company_dust_micros: subCentDustMicros.toString(),
        split_run_id: splitRunId,
      },
    },
    referenceId,
  );
}

// ---------------------------------------------------------------------------
// The one path from collection to money.
// ---------------------------------------------------------------------------

/**
 * Settles one matched, cleared canonical event through the locked split
 * engine — the ONLY path from collection to money.
 *
 * Order is the money-safety order: the clearance gate throws before
 * anything moves; the replay guard reads before any money moves; the engine
 * runs before the tier credit is written, so a refused engine run leaves NO
 * credit behind and a later retry starts clean; the credit's UNIQUE
 * reference_id is the final guard. Throws (never swallows):
 * ClearanceBlockedError on a failed gate, SdkMalformedInputError on a
 * corrupt sheet, and any database failure outside the two handled codes.
 */
export async function settleEvent(
  store: Store,
  db: Db | DbClient,
  matched: MatchedEvent,
  now: Date = new Date(),
): Promise<WireSettlement> {
  // 1. The MUL dispatch gate — uncleared throws, fail-closed.
  assertCollectible(matched.clearance, now);

  // 2. The replay guard — check before any money moves.
  const referenceId = settlementReferenceId(matched.event.eventId);
  const prior = await selectCreditByReference(db, referenceId);
  if (prior) {
    const metadata = prior.metadata ?? null;
    const run = await reconstructRun(store, metadata);
    return {
      ok: true,
      idempotent: true,
      ...run,
      subCentDustMicros: microsFromMetadata(metadata),
      credit: creditFromRow(prior, referenceId),
    };
  }

  // 3. The matched asset's stored sheet — the split source. Exact code match
  //    only; an asset that cannot be resolved is a refusal, never a guess.
  const sheet = await db.query<AssetSheetRow>(ASSET_SHEET_SQL, [matched.cbtCode]);
  const asset = sheet.rows[0];
  if (!asset) {
    return {
      ok: false,
      status: 422,
      code: 'asset_not_found',
      message: `Universal Royalty Collection SDK: no cbt_assets row for ${matched.cbtCode} — settlement refused, fail-closed.`,
    };
  }
  const plan = toSplitInput(
    matched.event,
    matched.cbtCode,
    asset.title,
    asset.rights_holders,
  );

  // 4. The locked engine — called, never reimplemented. Its refusals (the
  //    exact 10,000-bps gate, zeroBalanceHolds) propagate verbatim.
  const input: SplitCalculateInput = {
    source: settlementSource(matched.event),
    period: matched.event.period,
    currency: matched.event.currency,
    settle: false,
    rail: 'rtp',
    line_items: [...plan.lineItems],
  };
  const split = await calculateUdrSplits(store, input, now);
  if (!split.ok) {
    return { ok: false, status: split.status, code: split.code, message: split.message };
  }

  // 5. The tier credit — the SDK's own ledger-write site, CBT-stamped,
  //    UNIQUE on reference_id: exactly one credit per canonical event.
  const metadata = settlementMetadata(
    matched.event,
    matched.cbtCode,
    split.value.split_run.id,
    plan.subCentDustMicros,
    referenceId,
  );
  try {
    await db.query(CREDIT_INSERT_SQL, [
      plan.rightsHolderId,
      String(plan.lineItems[0]?.amount_cents ?? 0),
      SDK_SETTLEMENT_TRANSACTION_TYPE,
      referenceId,
      JSON.stringify(metadata),
    ]);
    return {
      ok: true,
      idempotent: false,
      splitRun: split.value.split_run,
      ledger: split.value.ledger,
      companyDustLedger: split.value.company_dust_ledger,
      varianceAccountCents: split.value.variance_account_cents,
      subCentDustMicros: plan.subCentDustMicros,
      credit: {
        transactionId: referenceId,
        referenceId,
        metadata,
      },
    };
  } catch (error) {
    if (isMissingMetadataColumnError(error)) {
      // The additive metadata column is absent — the money settles without
      // the stamp (money never blocks on provenance), with the DDL note on
      // the record for whoever runs the schema.
      console.warn(
        `universal_royalty_ledger.metadata is missing — the SDK settlement credit is recorded WITHOUT the CBT stamp. ${METADATA_COLUMN_DDL_NOTE}`,
      );
      await db.query(CREDIT_INSERT_WITHOUT_METADATA_SQL, [
        plan.rightsHolderId,
        String(plan.lineItems[0]?.amount_cents ?? 0),
        SDK_SETTLEMENT_TRANSACTION_TYPE,
        referenceId,
      ]);
      return {
        ok: true,
        idempotent: false,
        splitRun: split.value.split_run,
        ledger: split.value.ledger,
        companyDustLedger: split.value.company_dust_ledger,
        varianceAccountCents: split.value.variance_account_cents,
        subCentDustMicros: plan.subCentDustMicros,
        credit: { transactionId: referenceId, referenceId, metadata: null },
      };
    }
    if (isUniqueViolation(error)) {
      // A concurrent settlement of the same event won the reference_id race.
      // Exactly one credit stands in the tier ledger — return it, idempotent,
      // alongside this call's (duplicate) Don-lane run, per the documented
      // race-window note in the header.
      const existing = await selectCreditByReference(db, referenceId);
      if (!existing) throw error;
      return {
        ok: true,
        idempotent: true,
        splitRun: split.value.split_run,
        ledger: split.value.ledger,
        companyDustLedger: split.value.company_dust_ledger,
        varianceAccountCents: split.value.variance_account_cents,
        subCentDustMicros: plan.subCentDustMicros,
        credit: creditFromRow(existing, referenceId),
      };
    }
    throw error;
  }
}
