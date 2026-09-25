/**
 * The Export Audit Package — the statement-data derivation for the
 * per-payee, window-aware audit statement page (spec art_qNu4T32F,
 * module 4). Same derivation family as `creatorAnalytics.ts` and
 * `catalogGrowth.ts` — the discipline is mirrored, not shared: the journal
 * scan, the holder-credit measure, the run resolution, and the window
 * arithmetic are re-implemented here privately so this module stays a pure
 * addition and the shipped modules stay untouched (zero edits to any
 * existing derivation; the statement page consumes this payload).
 *
 * WHAT THE STATEMENT CARRIES, all store-read: the payee's window game log
 * (the SAME real royalty-ledger transaction rows the tab's game log
 * renders, newest first), the itemized total (Σ the payee's own rows), the
 * leaderboard-basis window credits (the vault-credit measure the
 * leaderboard ranks — carried beside the itemized total so a divergence
 * is DISCLOSED, never smoothed over), the payee identity of record (the
 * UCT + ISNI projection through `Store.getCreatorUct` — the kernel's
 * read; absent facts are honest nulls), and the identifier mapping per
 * work.
 *
 * IDENTIFIERS, honestly (spec module 4): per work of record —
 *   1. `cbt_assets.mapped_identifiers` first (the asset registry's own
 *      UniversalAssetIdentifier — the 13 engine schemes; the page's
 *      `listAssets()` read passes the registry in), by the work ref
 *      matching the asset's cbtCode;
 *   2. the entity template seeds second — the bound class's industry code
 *      of record: MASTER_RECORDING → `isrcCode` (ISRC), FEATURE_FILM →
 *      `isanCode` (ISAN), LITERARY_WORK → `isbnNumber` (ISBN);
 *   3. every other form — TV, podcast, live, sports, esports, social,
 *      sponsorship — has NO industry code anywhere in the schemas, so it
 *      falls back to the platform's own code of record (templateId/CVT)
 *      LABELED AS SUCH (`codeOfRecord: true` — the section renders
 *      `Code of Record (CVT)`). An ISRC is never claimed for a form that
 *      has none.
 *   ISWC rides as a secondary row only where the mapped record carries it
 *   ("ISWC where mapped"). An unresolvable work ref renders its own ref
 *   verbatim as the code of record — never a guessed scheme.
 *
 * The payee identity block: `getCreatorUct` exposes the UCT number and
 * ISNI of record. The `creator_profiles` 0007 columns `ipi_cae` and
 * `pro_affiliation` have no Store read — they are omitted here rather
 * than reached around the Store (no invented reads, no parallel data
 * paths).
 *
 * Units: every money figure is integer CENTS as bigint — the ledger's own
 * unit. Integer math only; nothing here divides, formats, or converts
 * (rendering belongs to the statement page through `formatCentsBigint`).
 *
 * TIME: the same store clock as the siblings — the anchor is the newest
 * royalty journal day in the scan; bounded windows (7/30/90) are the
 * anchor day inclusive going back; `null` is ALL, unbounded.
 *
 * Honesty law: a store read that fails degrades the whole payload to the
 * honest `null` (the statement page's unavailable state). A payee with no
 * window rows is an honest empty statement (zero rows, zero totals) — a
 * blank page says so, it never invents a line. No placeholder
 * attribution, no invented names, no invented codes, ever.
 */

import type { CovenantBlockAsset } from '@/engine/covenant-master-sdk';
import type { RoyaltyLineItemRecord, SplitRunRecord } from '@/lib/don/types';
import type { Store } from '@/lib/server/store';
import type { CreatorWindowDays } from '@/lib/admin/creatorAnalytics';
import { entityRecordForWorkRef } from '@/lib/master/masterStore';
import type { SovereignAtomicEntity } from '@/lib/master/CovnantAtomicDataSDK';

// ─────────────────────────────────────────────────────────────────────────────
// The payload types — one safe read, bigint cents throughout, rendering
// happens downstream.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The statement route's window-param parse — the pure seam between the
 * URL and the derivation's `windowDays`. `'invalid'` marks an unrecognized
 * id so the route can render its honest error state; an absent param and
 * an explicit `all` both resolve to the ALL window (the export links emit
 * `window=all`, so `all` must parse — it can never double as the invalid
 * marker).
 */
export type StatementWindowParam = CreatorWindowDays | 'invalid';

export function statementWindowFromParam(param: string | undefined): StatementWindowParam {
  switch (param) {
    case '7d':
      return 7;
    case '30d':
      return 30;
    case '90d':
      return 90;
    case 'all':
    case undefined:
      return null;
    default:
      return 'invalid';
  }
}

/** The statement's identifier schemes — the industry codes of record and the labeled CVT fallback. */
export type StatementIdentifierScheme = 'ISRC' | 'ISWC' | 'ISAN' | 'ISBN' | 'CVT';

/**
 * One work's identifier of record. `codeOfRecord: true` marks the honest
 * fallback — the platform's own code (templateId/CVT), NOT an industry
 * identifier; the section renders it labeled as such. The scheme field
 * never claims an industry standard the record does not carry.
 */
export interface StatementWorkIdentifier {
  readonly scheme: StatementIdentifierScheme;
  /** The identifier value of record — verbatim, never reformatted. */
  readonly code: string;
  /** True exactly when this is the labeled code-of-record fallback. */
  readonly codeOfRecord: boolean;
}

/**
 * One distinct work in the statement's window — the identity of record
 * behind the itemized lines. Titles are the line items' own display
 * labels (first non-null of record).
 */
export interface StatementWorkRow {
  /** The work reference of record (`royalty_line_items.work_id`). */
  readonly workRef: string;
  /** The line items' display label of record — null when none carry one. */
  readonly title: string | null;
  /** The identifier mapping — primary first, ISWC after where mapped. */
  readonly identifiers: readonly StatementWorkIdentifier[];
}

/**
 * One itemized line — per royalty ledger transaction (the payee's net
 * split of record), newest first. The same real game-log rows the tab
 * renders; the statement adds the work ref (the identity behind the
 * title). Absent fields are honest nulls — the section renders dashes.
 */
export interface StatementLineRow {
  /** The journal's UTC day of record, `YYYY-MM-DD`. */
  readonly day: string;
  /** The run's unanimous bound entity — null when unresolved or mixed. */
  readonly entityId: string | null;
  /** The line item's work reference of record — null when the item is gone. */
  readonly workRef: string | null;
  /** The transaction's line-item display label — null when the item is gone. */
  readonly workTitle: string | null;
  /** The run's own source of record — null when the run record is gone. */
  readonly source: string | null;
  /** The transaction's net split allocation cents of record. */
  readonly creatorCents: bigint;
}

/** The one safe payload — the whole audit statement derives from this alone. */
export interface AuditStatementFlows {
  /** The statement's payee of record (the vault attribution key). */
  readonly payeeId: string;
  /** The store-carried payee name (the transactions' payee_name), null when none — the page then renders the payeeId. */
  readonly label: string | null;
  /** The statement's window — the export control's window, verbatim. */
  readonly windowDays: CreatorWindowDays;
  /** The payee's root UCT of record (`getCreatorUct`) — null when the projection carries none. */
  readonly uctNumber: string | null;
  /** The payee's ISNI of record (`getCreatorUct`) — null when absent. */
  readonly isni: string | null;
  /** The itemized lines — the payee's window game-log rows, newest first. */
  readonly lines: readonly StatementLineRow[];
  /** Σ the itemized lines' own cents — the statement's total of record. */
  readonly itemizedTotalCents: bigint;
  /**
   * The leaderboard-basis window credits (the vault-credit measure the
   * tab ranks). A divergence from `itemizedTotalCents` is disclosed by
   * the page, never smoothed — attribution the measures disagree on is
   * stated, not hidden.
   */
  readonly creditedCents: bigint;
  /** The distinct works behind the lines, first-appearance order, with their identifier mapping. */
  readonly works: readonly StatementWorkRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// The identifier mapping — cbt_assets first, template seeds second, the
// labeled code-of-record fallback third. Never an invented scheme.
// ─────────────────────────────────────────────────────────────────────────────

/** The class-slot identifier emitted when the mapped record carries it — else null. */
function identifierFromMappedAsset(
  asset: CovenantBlockAsset,
): readonly StatementWorkIdentifier[] | null {
  const mapped = asset.mappedIdentifiers ?? {};
  const medium = asset.medium;
  if (medium === 'MUSIC_TRACK' || medium === 'MUSIC_ALBUM' || medium === 'SHEET_MUSIC') {
    if (mapped.isrc === undefined) return null;
    const rows: StatementWorkIdentifier[] = [
      { scheme: 'ISRC', code: mapped.isrc, codeOfRecord: false },
    ];
    // ISWC where mapped — a secondary row, never a substitute for the ISRC.
    if (mapped.iswc !== undefined) {
      rows.push({ scheme: 'ISWC', code: mapped.iswc, codeOfRecord: false });
    }
    return rows;
  }
  if (medium === 'FEATURE_FILM') {
    if (mapped.isanHex === undefined) return null;
    return [{ scheme: 'ISAN', code: mapped.isanHex, codeOfRecord: false }];
  }
  if (
    medium === 'AUDIOBOOK' ||
    medium === 'PRINT_BOOK' ||
    medium === 'EBOOK' ||
    medium === 'MAGAZINE_SERIAL'
  ) {
    if (mapped.isbn === undefined) return null;
    return [{ scheme: 'ISBN', code: mapped.isbn, codeOfRecord: false }];
  }
  return null; // forms without an industry slot fall through honestly
}

/**
 * The bound entity class's industry code of record — the template seeds'
 * own fields (isrcCode music, isanCode film, isbnNumber publishing).
 * Null when the class carries no industry code (the CVT-fallback forms).
 */
function identifierFromEntitySeed(entity: SovereignAtomicEntity): string | null {
  switch (entity.entityType) {
    case 'MASTER_RECORDING':
      return entity.isrcCode;
    case 'FEATURE_FILM':
      return entity.isanCode;
    case 'LITERARY_WORK':
      return entity.isbnNumber;
    default:
      return null;
  }
}

/** The fallback row — the platform's own code of record, labeled as such. */
function codeOfRecordRow(code: string): StatementWorkIdentifier {
  return { scheme: 'CVT', code, codeOfRecord: true };
}

/**
 * The identifier mapping for one work reference of record: the CBT asset
 * registry's mapped identifiers first (keyed by cbtCode, the registry's
 * own case convention uppercased), the entity template seeds second, the
 * labeled code-of-record fallback third. An unresolvable ref renders its
 * own ref verbatim — never a guessed scheme.
 */
export function identifiersForWorkRef(
  workRef: string,
  assets: readonly CovenantBlockAsset[],
): readonly StatementWorkIdentifier[] {
  const asset = assets.find((candidate) => candidate.cbtCode === workRef.toUpperCase());
  if (asset !== undefined) {
    const fromMapped = identifierFromMappedAsset(asset);
    if (fromMapped !== null) return fromMapped;
    // The asset resolves but carries no class-slot industry code — its own
    // CVT/cbt code of record, labeled as such.
    return [codeOfRecordRow(asset.cvtCode ?? asset.cbtCode)];
  }

  const entity = entityRecordForWorkRef(workRef);
  if (entity !== null) {
    const seedCode = identifierFromEntitySeed(entity);
    if (seedCode !== null && seedCode !== '') {
      return [{ scheme: identifierFromEntitySeedScheme(entity), code: seedCode, codeOfRecord: false }];
    }
    // A class with no industry code — the templateId is the universal code
    // of record (spec: templateId/CVT), labeled as such.
    return [codeOfRecordRow(entity.templateId)];
  }

  // Unresolvable — the ref of record stands alone, labeled, never renamed.
  return [codeOfRecordRow(workRef)];
}

/** The scheme name of the entity class's industry code — the pair of identifierFromEntitySeed. */
function identifierFromEntitySeedScheme(entity: SovereignAtomicEntity): StatementIdentifierScheme {
  switch (entity.entityType) {
    case 'MASTER_RECORDING':
      return 'ISRC';
    case 'FEATURE_FILM':
      return 'ISAN';
    case 'LITERARY_WORK':
      return 'ISBN';
    default:
      return 'CVT';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The ledger scan — the creator module's treatment, mirrored privately:
// the royalty journals, the holder-credit measure, and the per-entry payee
// attribution from the vault account of record.
// ─────────────────────────────────────────────────────────────────────────────

/** Any rights holder's vault account — `vault:<payeeId>:…` — except the platform's own dust vault. */
function isHolderVaultCredit(entry: GlEntryRecordLike): boolean {
  return (
    entry.account.startsWith('vault:') &&
    !entry.account.startsWith('vault:platform:') &&
    entry.credit_cents > 0
  );
}

/** The vault account's payee segment — the `vault:<payeeId>:<bucket>` middle (vaultGlAccount's format). */
function payeeOfVaultAccount(account: string): string | null {
  if (!account.startsWith('vault:') || account.startsWith('vault:platform:')) return null;
  const segments = account.split(':');
  const payeeId = segments[1];
  return payeeId !== undefined && payeeId !== '' ? payeeId : null;
}

/** One cleared-run scan row — the journal of record plus its statement attributions. */
interface StatementRunScan {
  /** The journal's UTC day, `YYYY-MM-DD`. */
  readonly day: string;
  /** Per-payee attribution of this journal's vault credits (well-formed keys only). */
  readonly creditsByPayee: ReadonlyMap<string, bigint>;
  /** The run's own source of record — null when the run record is gone. */
  readonly source: string | null;
  /** The run's unanimous bound entity — null when unresolved or mixed. */
  readonly entityId: string | null;
  /** The payee's line rows — per royalty ledger transaction of a resolved run. */
  readonly lineRows: readonly (Omit<StatementLineRow, 'identifiers'> & {
    /** The transaction's payee of record — the statement filters on it. */
    readonly payeeId: string;
  })[];
  /** The store-carried payee names these transactions carry, payee_id keyed. */
  readonly labels: ReadonlyMap<string, string>;
}

/**
 * The record subset of GlEntryRecord this module reads — mirrored
 * privately so the module's import surface stays the record shapes only.
 */
interface GlEntryRecordLike {
  readonly account: string;
  readonly credit_cents: number;
}

/**
 * The ledger scan — every royalty-ingest journal with holder credits,
 * resolved to its run, its payees, and its per-transaction line rows.
 * Mirrors the siblings' scan exactly: runs resolved before they count,
 * the unanimity rule fails closed, unresolved runs keep their money in
 * the credited measure with no source or line attribution.
 */
async function scanStatementRuns(store: Store): Promise<readonly StatementRunScan[]> {
  const journals = (await store.listGlJournals()).filter(
    (journal) => journal.kind === 'royalty_ingest',
  );
  const entriesByJournal = new Map<string, { account: string; credit_cents: number }[]>();
  for (const entry of await store.listGlEntries()) {
    const group = entriesByJournal.get(entry.journal_id);
    if (group !== undefined) group.push({ account: entry.account, credit_cents: entry.credit_cents });
    else entriesByJournal.set(entry.journal_id, [{ account: entry.account, credit_cents: entry.credit_cents }]);
  }
  const runOf = new Map<string, SplitRunRecord | undefined>();
  for (const journal of journals) {
    if (journal.ref_type !== 'split_run' || journal.ref_id === null) continue;
    runOf.set(journal.id, await store.getSplitRun(journal.ref_id));
  }

  const scans: StatementRunScan[] = [];
  for (const journal of journals) {
    const entries = entriesByJournal.get(journal.id);
    const creditsByPayee = new Map<string, bigint>();
    for (const entry of entries ?? []) {
      if (!isHolderVaultCredit(entry)) continue;
      const payeeId = payeeOfVaultAccount(entry.account);
      if (payeeId === null) continue;
      creditsByPayee.set(payeeId, (creditsByPayee.get(payeeId) ?? 0n) + BigInt(entry.credit_cents));
    }
    if (creditsByPayee.size === 0) continue;

    // The run's own join: source, line items, unanimous entity, and the
    // payee's per-transaction line rows. An unresolved run contributes
    // none of these — its money stays in the credited measure.
    const run = journal.ref_type === 'split_run' ? runOf.get(journal.id) : undefined;
    let source: string | null = null;
    let entityId: string | null = null;
    let lineRows: { day: string; payeeId: string; entityId: string | null; workRef: string | null; workTitle: string | null; source: string | null; creatorCents: bigint }[] = [];
    const labels = new Map<string, string>();
    if (run !== undefined) {
      source = run.source;
      const lineItems = await store.listRoyaltyLineItemsByRun(run.id);
      const records = recordsOfLineItems(lineItems);
      entityId = records === null ? null : unanimousEntityIdentity(records);
      const itemOf = new Map(lineItems.map((item) => [item.id, item]));
      const ledger = await store.listLedgerTransactionsByRun(run.id);
      lineRows = ledger
        .filter((tx) => tx.kind === 'royalty')
        .map((tx) => {
          if (tx.payee_name !== '') labels.set(tx.payee_id, tx.payee_name);
          return {
            day: journal.created_at.slice(0, 10),
            payeeId: tx.payee_id,
            entityId,
            workRef: itemOf.get(tx.line_item_id)?.work_id ?? null,
            workTitle: itemOf.get(tx.line_item_id)?.work_title ?? null,
            source,
            creatorCents: BigInt(tx.amount_cents),
          };
        });
    }

    scans.push({ day: journal.created_at.slice(0, 10), creditsByPayee, source, entityId, lineRows, labels });
  }
  return scans;
}

/**
 * The run's bound atomic entity records — resolved when EVERY line item
 * of the run resolves (the settlement shape of record: one asset per
 * run). Mirrored from the creator module: a run whose line items resolve
 * to nothing contributes no entity attribution — the identity is never
 * misattributed.
 */
function recordsOfLineItems(
  lineItems: readonly RoyaltyLineItemRecord[],
): readonly SovereignAtomicEntity[] | null {
  if (lineItems.length === 0) return null;
  const records: SovereignAtomicEntity[] = [];
  for (const lineItem of lineItems) {
    const record = entityRecordForWorkRef(lineItem.work_id);
    if (record === null) return null;
    records.push(record);
  }
  return records;
}

/** The run's unanimous bound entity identity — the shared template id, null when they disagree. */
function unanimousEntityIdentity(records: readonly SovereignAtomicEntity[]): string | null {
  if (records.length === 0) return null;
  const identity = records[0].templateId;
  for (const record of records) {
    if (record.templateId !== identity) return null;
  }
  return identity;
}

// ─────────────────────────────────────────────────────────────────────────────
// Time — the store's own clock, mirrored from the siblings: windows are
// UTC-day arithmetic off the anchor, string-keyed on the journals' own ISO
// granularity (lexicographic order IS chronology).
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** The UTC day shifted by whole days — integer epoch math, deterministic. */
function shiftDay(day: string, offsetDays: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + offsetDays * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The window's inclusive lower bound, or null for ALL. Each arm covers
 * exactly its day count with the anchor day itself; the exhaustiveness
 * pin is the flowKinds pattern family — a new window without an arm
 * fails the build here, and the throw beneath is the runtime fail-closed
 * twin.
 */
function windowStartDay(anchorDay: string, windowDays: CreatorWindowDays): string | null {
  switch (windowDays) {
    case 7:
      return shiftDay(anchorDay, -6);
    case 30:
      return shiftDay(anchorDay, -29);
    case 90:
      return shiftDay(anchorDay, -89);
    case null:
      return null;
    default: {
      const unregistered: never = windowDays;
      throw new Error(`auditStatement: no window arm for ${String(unregistered)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The derivation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The audit statement payload for ONE payee and window. Never throws on a
 * store failure: it degrades to the honest `null` (the statement page's
 * unavailable state). A payee with no window rows is an honest empty
 * statement, not an error.
 */
export async function auditStatementFlows(
  store: Store,
  assets: readonly CovenantBlockAsset[],
  windowDays: CreatorWindowDays,
  payeeId: string,
): Promise<AuditStatementFlows | null> {
  let scan: readonly StatementRunScan[];
  let uct: { uctNumber: string; isni: string | null } | undefined;
  try {
    scan = await scanStatementRuns(store);
    uct = await store.getCreatorUct(payeeId);
  } catch {
    return null;
  }

  // The store clock — the newest royalty journal day in the scan.
  const anchorDay = scan.reduce((newest, run) => (run.day > newest ? run.day : newest), scan[0]?.day ?? '');
  const startDay = anchorDay === '' ? null : windowStartDay(anchorDay, windowDays);
  const windowScans =
    startDay === null
      ? scan
      : scan.filter((run) => run.day >= startDay && run.day <= anchorDay);

  // The itemized lines — the payee's own transactions, newest first (the
  // scan is journal order; the journals list newest first per the Store's
  // contract, so the concatenated rows inherit it).
  const lines: StatementLineRow[] = [];
  let creditedCents = 0n;
  for (const run of windowScans) {
    creditedCents += run.creditsByPayee.get(payeeId) ?? 0n;
    for (const row of run.lineRows) {
      if (row.payeeId !== payeeId) continue;
      lines.push({
        day: row.day,
        entityId: row.entityId,
        workRef: row.workRef,
        workTitle: row.workTitle,
        source: row.source,
        creatorCents: row.creatorCents,
      });
    }
  }

  return {
    payeeId,
    label: labelOf(scan, payeeId),
    windowDays,
    uctNumber: uct?.uctNumber ?? null,
    isni: uct?.isni ?? null,
    lines,
    itemizedTotalCents: lines.reduce((sum, line) => sum + line.creatorCents, 0n),
    creditedCents,
    works: worksFromLines(lines, assets),
  };
}

/**
 * The payee's store-carried name of record — the transactions' own
 * `payee_name` (the creator module's label rule). Null when the store's
 * transactions never name this payee; the page then renders the payeeId.
 */
function labelOf(scan: readonly StatementRunScan[], payeeId: string): string | null {
  for (const run of scan) {
    const label = run.labels.get(payeeId);
    if (label !== undefined) return label;
  }
  return null;
}

/**
 * The distinct works behind the itemized lines, first-appearance order
 * (newest first), each with its identifier mapping — the mapping is a
 * pure function of the work ref and the asset registry, computed once per
 * distinct ref. Titles are the first non-null display label of record.
 */
function worksFromLines(
  lines: readonly StatementLineRow[],
  assets: readonly CovenantBlockAsset[],
): readonly StatementWorkRow[] {
  const works = new Map<string, StatementWorkRow>();
  for (const line of lines) {
    if (line.workRef === null) continue; // an unresolved item contributes no work identity
    const known = works.get(line.workRef);
    if (known !== undefined) {
      if (known.title === null && line.workTitle !== null) {
        works.set(line.workRef, { ...known, title: line.workTitle });
      }
      continue;
    }
    works.set(line.workRef, {
      workRef: line.workRef,
      title: line.workTitle,
      identifiers: identifiersForWorkRef(line.workRef, assets),
    });
  }
  return [...works.values()];
}
