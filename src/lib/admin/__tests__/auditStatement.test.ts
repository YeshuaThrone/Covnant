/**
 * auditStatementFlows — the Export Audit Package derivation's unit suite
 * (spec art_qNu4T32F, module 4), mirroring the catalogGrowth suite's
 * fixture patterns: a fake store over the REAL record shapes
 * (GlJournalRecord / GlEntryRecord, SplitRunRecord, RoyaltyLineItemRecord,
 * LedgerTransactionRecord) with no parallel arithmetic. Pinned here:
 *
 * 1. The identifier mapping per class — music→ISRC (ISWC as a secondary
 *    row where mapped), film→ISAN, publishing→ISBN, the forms with NO
 *    industry code falling back to the code of record labeled as such
 *    (the CVT scheme — never a claimed industry standard), the template
 *    seeds' own codes (isrcCode music, isanCode film, isbnNumber
 *    publishing), and the unresolvable ref rendered verbatim.
 * 2. The statement derivation — the payee's own itemized lines (only
 *    `royalty` transactions of resolved runs), the leaderboard-basis
 *    credited measure beside the itemized total (a divergence is
 *    representable and disclosed downstream, never smoothed), the honest
 *    empty statement for a payee with no window rows, the ALL window and
 *    the bounded windows off the store's own clock, the UCT/ISNI
 *    projection (absent → the honest null), and the fail-closed null on
 *    EVERY store failure.
 * 3. The REAL dev-seed pins booted through createSeededStore — the
 *    statement renders real itemized lines with real template works.
 *
 * Store-read integer math (bigint), nothing invented.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import type { GlEntryRecord, GlJournalRecord } from '@/modules/don/records';
import type { LedgerTransactionRecord, RoyaltyLineItemRecord, SplitRunRecord } from '@/lib/don/types';
import type { CovenantBlockAsset } from '@/engine/covenant-master-sdk';
import type { Store } from '@/lib/server/store';
import { createSeededStore } from '@/lib/server/devSeed';
import type { InMemoryStore } from '@/lib/server/inMemoryStore';
import { auditStatementFlows, identifiersForWorkRef, statementWindowFromParam } from '../auditStatement';

const JOURNAL_BASE = {
  ref_type: 'split_run' as const,
  prev_hash: '0x0',
  entry_hash: '0x0',
  state: 'posted' as const,
};

function journal(
  id: string,
  refId: string,
  sequence: number,
  createdAt: string,
): GlJournalRecord {
  return { id, kind: 'royalty_ingest', ref_id: refId, sequence, created_at: createdAt, ...JOURNAL_BASE };
}

function entry(journalId: string, account: string, creditCents: number): GlEntryRecord {
  return {
    id: `e-${journalId}-${account}-${creditCents}`,
    journal_id: journalId,
    account,
    debit_cents: 0,
    credit_cents: creditCents,
    created_at: '2026-09-22T00:00:00.000Z',
  };
}

function run(id: string, source: string): SplitRunRecord {
  return {
    id,
    source,
    period: '2026-09',
    currency: 'USD',
    gross_cents: 0,
    line_item_count: 0,
    variance_account_cents: 0,
    created_at: '2026-09-22T00:00:00.000Z',
    status: 'posted',
  };
}

function lineItem(id: string, runId: string, workId: string, workTitle: string): RoyaltyLineItemRecord {
  return {
    id,
    split_run_id: runId,
    work_id: workId,
    work_title: workTitle,
    amount_cents: 0,
    splits_json: '{}',
    created_at: '2026-09-22T00:00:00.000Z',
  };
}

/** One ledger transaction of record — the derivation reads only the royalty subset's fields. */
function tx(
  id: string,
  runId: string,
  lineItemId: string,
  payeeId: string,
  payeeName: string,
  amountCents: number,
): LedgerTransactionRecord {
  return {
    id,
    split_run_id: runId,
    line_item_id: lineItemId,
    payee_id: payeeId,
    payee_name: payeeName,
    role: 'payee',
    share_bps: 10_000,
    amount_cents: amountCents,
    currency: 'USD',
    status: 'settled',
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: '2026-09-22T00:00:00.000Z',
    settled_at: null,
    kind: 'royalty',
  } as unknown as LedgerTransactionRecord;
}

function asset(
  overrides: Partial<CovenantBlockAsset> & Pick<CovenantBlockAsset, 'cbtCode' | 'medium'>,
): CovenantBlockAsset {
  return {
    title: 'A Work of Record',
    mappedIdentifiers: {},
    rightsHolders: [],
    createdTimestamp: 1,
    ...overrides,
  };
}

interface FakeStoreInput {
  readonly journals: GlJournalRecord[];
  readonly entries: GlEntryRecord[];
  readonly runs: Record<string, SplitRunRecord | undefined>;
  readonly lineItems?: RoyaltyLineItemRecord[];
  readonly ledgerTxs?: LedgerTransactionRecord[];
  readonly uct?: Record<string, { uctNumber: string; isni: string | null }>;
  /** When set, the named read rejects — the store-failure states. */
  readonly failure?: 'journals' | 'entries' | 'lines' | 'ledger' | 'uct';
}

/** Minimal store — the derivation touches exactly these reads. */
function fakeStore(input: FakeStoreInput): Store {
  const reject = async (what: string): Promise<never> => {
    throw new Error(`store read failed: ${what}`);
  };
  return {
    listGlJournals: async () =>
      input.failure === 'journals' ? reject('journals') : input.journals,
    listGlEntries: async () =>
      input.failure === 'entries' ? reject('entries') : input.entries,
    getSplitRun: async (id: string) => input.runs[id],
    listRoyaltyLineItemsByRun: async (runId: string) =>
      input.failure === 'lines'
        ? reject('line items')
        : input.lineItems?.filter((row) => row.split_run_id === runId) ?? [],
    listLedgerTransactionsByRun: async (runId: string) =>
      input.failure === 'ledger'
        ? reject('ledger transactions')
        : input.ledgerTxs?.filter((row) => row.split_run_id === runId) ?? [],
    getCreatorUct: async (payeeId: string) =>
      input.failure === 'uct' ? reject('creator UCT') : input.uct?.[payeeId],
  } as unknown as Store;
}

/** The derivation's payload, or the test failure — never a null read. */
async function readPayload(
  store: Store,
  assets: readonly CovenantBlockAsset[],
  windowDays: 7 | 30 | 90 | null,
  payeeId = 'payeeA',
) {
  const payload = await auditStatementFlows(store, assets, windowDays, payeeId);
  expect(payload).not.toBeNull();
  if (payload === null) throw new Error('auditStatementFlows degraded to null');
  return payload;
}

describe('identifiersForWorkRef — the per-class identifier mapping', () => {
  it('maps music to ISRC with ISWC as a secondary row where mapped', () => {
    const assets = [
      asset({
        cbtCode: 'CBT-MUS-1',
        medium: 'MUSIC_TRACK',
        mappedIdentifiers: { isrc: 'US-S1Z-26-00001', iswc: 'T-034.524.280-1' },
      }),
    ];
    expect(identifiersForWorkRef('CBT-MUS-1', assets)).toEqual([
      { scheme: 'ISRC', code: 'US-S1Z-26-00001', codeOfRecord: false },
      { scheme: 'ISWC', code: 'T-034.524.280-1', codeOfRecord: false },
    ]);
  });

  it('maps film to ISAN', () => {
    const assets = [
      asset({ cbtCode: 'CBT-FILM-1', medium: 'FEATURE_FILM', mappedIdentifiers: { isanHex: '0000-0000-4A5E-0000-I' } }),
    ];
    expect(identifiersForWorkRef('CBT-FILM-1', assets)).toEqual([
      { scheme: 'ISAN', code: '0000-0000-4A5E-0000-I', codeOfRecord: false },
    ]);
  });

  it('maps publishing to ISBN', () => {
    const assets = [
      asset({ cbtCode: 'CBT-BOOK-1', medium: 'PRINT_BOOK', mappedIdentifiers: { isbn: '978-3-16-148410-0' } }),
    ];
    expect(identifiersForWorkRef('CBT-BOOK-1', assets)).toEqual([
      { scheme: 'ISBN', code: '978-3-16-148410-0', codeOfRecord: false },
    ]);
  });

  it('falls back to the code of record labeled as such for forms with no industry code — never a claimed ISRC', () => {
    // A TV episode carries no ISRC/ISAN/ISBN slot — its CVT code of
    // record stands in, labeled, never renamed to an industry standard.
    const assets = [
      asset({ cbtCode: 'CBT-TV-1', cvtCode: 'CVT-TV-0001', medium: 'TV_EPISODE', mappedIdentifiers: {} }),
    ];
    expect(identifiersForWorkRef('CBT-TV-1', assets)).toEqual([
      { scheme: 'CVT', code: 'CVT-TV-0001', codeOfRecord: true },
    ]);
    // Without a cvtCode, the CBT code of record stands in.
    expect(
      identifiersForWorkRef('CBT-TV-1', [asset({ cbtCode: 'CBT-TV-1', medium: 'TV_EPISODE' })]),
    ).toEqual([{ scheme: 'CVT', code: 'CBT-TV-1', codeOfRecord: true }]);
  });

  it("reads the template seeds' own industry codes — isrcCode for the music class", () => {
    // TPL-MUS-001 is the telemetry library's canonical music template —
    // its seed carries an isrcCode of record.
    const rows = identifiersForWorkRef('TPL-MUS-001', []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scheme).toBe('ISRC');
    expect(rows[0]?.codeOfRecord).toBe(false);
    expect(rows[0]?.code.length).toBeGreaterThan(0);
  });

  it('renders an unresolvable ref verbatim as the code of record — never renamed or guessed', () => {
    expect(identifiersForWorkRef('gone-work-42', [])).toEqual([
      { scheme: 'CVT', code: 'gone-work-42', codeOfRecord: true },
    ]);
  });
});

describe("auditStatementFlows — the payee's statement of record", () => {
  // One resolved run: the vault credits both payees, the line items and
  // ledger transactions attribute the split money per payee.
  function fixtureStore(overrides: Partial<FakeStoreInput> = {}): Store {
    return fakeStore({
      journals: [journal('j1', 'r1', 1, '2026-09-22T15:00:00.000Z')],
      entries: [
        entry('j1', 'vault:payeeA:royalty', 300_00),
        entry('j1', 'vault:payeeB:royalty', 200_00),
      ],
      runs: { r1: run('r1', 'Spotify') },
      lineItems: [lineItem('li1', 'r1', 'CBT-MUS-1', 'Midnight Clear')],
      ledgerTxs: [
        tx('lt1', 'r1', 'li1', 'payeeA', 'Payee A', 180_00),
        tx('lt2', 'r1', 'li1', 'payeeB', 'Payee B', 120_00),
      ],
      uct: { payeeA: { uctNumber: 'UCT-COV-0001-8', isni: '0000 0001 2345 6789' } },
      ...overrides,
    });
  }

  const registry = [
    asset({
      cbtCode: 'CBT-MUS-1',
      medium: 'MUSIC_TRACK',
      mappedIdentifiers: { isrc: 'US-S1Z-26-00001' },
    }),
  ];

  it("itemizes only the payee's own royalty transactions and totals them exactly", async () => {
    const flows = await readPayload(fixtureStore(), registry, null);
    expect(flows.payeeId).toBe('payeeA');
    expect(flows.label).toBe('Payee A'); // the transactions' own payee_name
    expect(flows.uctNumber).toBe('UCT-COV-0001-8');
    expect(flows.isni).toBe('0000 0001 2345 6789');
    expect(flows.lines).toHaveLength(1);
    expect(flows.lines[0]).toEqual({
      day: '2026-09-22',
      entityId: null, // the run's line items resolve to no template here
      workRef: 'CBT-MUS-1',
      workTitle: 'Midnight Clear',
      source: 'Spotify',
      creatorCents: 180_00n,
    });
    expect(flows.itemizedTotalCents).toBe(180_00n);
    expect(flows.creditedCents).toBe(300_00n); // the leaderboard basis
  });

  it('maps the works table from the asset registry in first-appearance order', async () => {
    const flows = await readPayload(fixtureStore(), registry, null);
    expect(flows.works).toHaveLength(1);
    expect(flows.works[0]?.workRef).toBe('CBT-MUS-1');
    // The title of record is the line item's own work title — the record
    // that produced the money; the registry supplies the identifier mapping.
    expect(flows.works[0]?.title).toBe('Midnight Clear');
    expect(flows.works[0]?.identifiers).toEqual([
      { scheme: 'ISRC', code: 'US-S1Z-26-00001', codeOfRecord: false },
    ]);
  });

  it("filters bounded windows off the store's own clock — the anchor day inclusive", async () => {
    // Journal 1 is nine days older than the anchor — the 7-day window
    // excludes it; ALL keeps it.
    const store = fixtureStore({
      journals: [
        journal('j1', 'r1', 1, '2026-09-13T15:00:00.000Z'),
        journal('j2', 'r2', 2, '2026-09-22T15:00:00.000Z'),
      ],
      entries: [
        entry('j1', 'vault:payeeA:royalty', 100_00),
        entry('j2', 'vault:payeeA:royalty', 50_00),
      ],
      runs: { r1: run('r1', 'Spotify'), r2: run('r2', 'Netflix') },
      ledgerTxs: [
        tx('lt1', 'r1', 'li1', 'payeeA', 'Payee A', 100_00),
        tx('lt2', 'r2', 'li1', 'payeeA', 'Payee A', 50_00),
      ],
    });
    const all = await readPayload(store, registry, null);
    expect(all.lines).toHaveLength(2);
    expect(all.itemizedTotalCents).toBe(150_00n);
    const seven = await readPayload(store, registry, 7);
    expect(seven.lines).toHaveLength(1);
    expect(seven.lines[0]?.source).toBe('Netflix');
    expect(seven.itemizedTotalCents).toBe(50_00n);
  });

  it("keeps an unresolved run's credited money with no source or line attribution", async () => {
    const store = fixtureStore({
      runs: { r1: undefined }, // the run record is gone
    });
    const flows = await readPayload(store, registry, null);
    expect(flows.creditedCents).toBe(300_00n); // the money stays
    expect(flows.lines).toEqual([]); // no invented attribution
    expect(flows.itemizedTotalCents).toBe(0n);
    expect(flows.works).toEqual([]);
  });

  it('represents a divergence between the itemized total and the credited basis — never smoothed', async () => {
    // The vault credit (300_00) and the payee's itemized transactions
    // (180_00) disagree — attribution the measures disagree on stays
    // visible in the payload for the page to disclose.
    const flows = await readPayload(fixtureStore(), registry, null);
    expect(flows.itemizedTotalCents).not.toBe(flows.creditedCents);
  });

  it('renders an honest zero statement for a payee with no window rows', async () => {
    const flows = await readPayload(fixtureStore(), registry, null, 'payee_ghost');
    expect(flows.lines).toEqual([]);
    expect(flows.works).toEqual([]);
    expect(flows.itemizedTotalCents).toBe(0n);
    expect(flows.creditedCents).toBe(0n);
    expect(flows.label).toBe(null); // the store never names this payee
    expect(flows.uctNumber).toBe(null); // no projection — the honest dash
  });

  it('degrades to the honest null when any store read fails', async () => {
    for (const failure of ['journals', 'entries', 'lines', 'ledger', 'uct'] as const) {
      const flows = await auditStatementFlows(fixtureStore({ failure }), registry, null, 'payeeA');
      expect(flows).toBeNull();
    }
  });
});

describe('auditStatementFlows — the real dev-seed pins', () => {
  let seeded: InMemoryStore;

  beforeAll(async () => {
    seeded = await createSeededStore();
  });

  it('itemizes real seed money for a credited payee through the template-seed identifier mapping', async () => {
    const flows = await readPayload(seeded, [], null, 'rh_thrones_label_don');
    // The statement is not empty — the seed credits this payee, the
    // transactions name it, and the money is real.
    expect(flows.lines.length).toBeGreaterThan(0);
    expect(flows.creditedCents).toBeGreaterThan(0n);
    expect(flows.itemizedTotalCents).toBeGreaterThan(0n);
    expect(flows.label).not.toBe(null);
    // The works table carries the seed's template refs with their
    // identifier mapping of record — every row mapped, none invented.
    expect(flows.works.length).toBeGreaterThan(0);
    for (const work of flows.works) {
      expect(work.identifiers.length).toBeGreaterThan(0);
      for (const identifier of work.identifiers) {
        expect(identifier.code.length).toBeGreaterThan(0);
      }
    }
  });

  it('renders the honest zero statement for a payee the seed never credits', async () => {
    const flows = await readPayload(seeded, [], null, 'rh_ghost');
    expect(flows.lines).toEqual([]);
    expect(flows.itemizedTotalCents).toBe(0n);
    expect(flows.creditedCents).toBe(0n);
  });
});

describe("statementWindowFromParam — the route's window-param parse", () => {
  it('resolves every export-link window id to its derivation window — including window=all', () => {
    // The leaderboard's export links emit `window=all` for the ALL window,
    // so `all` MUST parse — it can never double as the invalid marker.
    expect(statementWindowFromParam('7d')).toBe(7);
    expect(statementWindowFromParam('30d')).toBe(30);
    expect(statementWindowFromParam('90d')).toBe(90);
    expect(statementWindowFromParam('all')).toBe(null);
  });

  it('treats an absent param as the ALL window and an unknown id as invalid', () => {
    expect(statementWindowFromParam(undefined)).toBe(null);
    expect(statementWindowFromParam('bogus')).toBe('invalid');
    expect(statementWindowFromParam('7')).toBe('invalid'); // days values are not ids
  });
});

