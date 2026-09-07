import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../route';
import { getDb } from '@/lib/db';
import { parseExternalReferences } from '@/lib/covenant/lineage';

/**
 * POST /api/covenant/webhooks/increase — ledger lineage acceptance tests
 * (W1–W6). The credit lane is PR #26's, unchanged: Standard Webhooks HMAC,
 * authoritative transfer GET, account-number holder resolution, replay
 * idempotency. Lineage is the NEW parallel lane: memo identifiers parsed
 * from the fetched transfer, exact-matched against cbt_assets, merged into
 * the ledger row's metadata WITHOUT disturbing any provenance key, skipped
 * entirely on any failure. Money never blocks on enrichment.
 */

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }));
vi.mock('@/lib/covenant/lineage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/covenant/lineage')>();
  return { ...actual, parseExternalReferences: vi.fn(actual.parseExternalReferences) };
});

const mockGetDb = vi.mocked(getDb);
const mockParseExternalReferences = vi.mocked(parseExternalReferences);

const SECRET_RAW = 'test-increase-webhook-secret';
const SECRET_WHSEC = `whsec_${Buffer.from(SECRET_RAW).toString('base64')}`;
const SECRET_RAW_BYTES = Buffer.from(SECRET_RAW, 'utf8');
const EVENT_ID = 'event_001test';
const ACCOUNT_NUMBER_ID = 'account_number_v18nkfqm6afpsrvy82b2';
const HOLDER_ID = 'rh_lineage';
const REGISTERED_ISRC = 'USS1M2677777';
const REGISTERED_ASSET_CODE = 'CBT-TRACK-test0isrc';
const REGISTERED_UCT = 'UCT-US-2026-9F3A7C21-K4';

function eventEnvelope(category: string, objectId: string): Record<string, unknown> {
  return {
    id: EVENT_ID,
    created_at: '2026-09-07T00:00:00Z',
    category,
    associated_object_type: 'inbound_transfer',
    associated_object_id: objectId,
    type: 'event',
  };
}

const ACH_TRANSFER_ID = 'inbound_ach_transfer_tdrwqr3fq9gnnq49odev';
const WIRE_TRANSFER_ID = 'inbound_wire_transfer_f228m6bmhtcxjco9pwp0';

function achTransferObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ACH_TRANSFER_ID,
    account_id: 'account_in71c4amph0vgo2qllky',
    account_number_id: ACCOUNT_NUMBER_ID,
    amount: 1500000,
    direction: 'credit',
    status: 'pending',
    created_at: '2026-09-07T00:00:00Z',
    originator_company_name: 'ASCAP',
    originator_company_id: '0987654321',
    trace_number: '021000038461022',
    acceptance: null,
    decline: null,
    transfer_return: null,
    type: 'inbound_ach_transfer',
    ...overrides,
  };
}

function wireTransferObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WIRE_TRANSFER_ID,
    account_id: 'account_in71c4amph0vgo2qllky',
    account_number_id: ACCOUNT_NUMBER_ID,
    amount: 250000,
    status: 'accepted',
    created_at: '2026-09-07T00:00:00Z',
    creditor_name: 'Test Holder',
    debtor_name: 'DISTROKID',
    debtor_account_number: '987654321',
    debtor_routing_number: '101050001',
    end_to_end_identification: 'Invoice 29582',
    input_message_accountability_data: '20220118MMQFMP0P000001',
    instruction_identification: '202201180000001',
    reversal: null,
    unique_end_to_end_transaction_reference: '9a21e10a-7600-4a24-8ff3-2cbc5943c27a',
    unstructured_remittance_information: 'INVOICE 2468',
    acceptance: { accepted_at: '2026-09-07T00:00:00Z', transaction_id: 'transaction_wire_accept_1' },
    type: 'inbound_wire_transfer',
    ...overrides,
  };
}

function signedHeaders(
  rawBody: string,
  secret: Buffer = SECRET_RAW_BYTES,
  timestamp = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const signature = `v1,${createHmac('sha256', secret)
    .update(`${EVENT_ID}.${timestamp}.${rawBody}`)
    .digest('base64')}`;
  return {
    'webhook-id': EVENT_ID,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': signature,
  };
}

function signedRequest(envelope: unknown): Request {
  const rawBody = JSON.stringify(envelope);
  return new Request('http://localhost/api/covenant/webhooks/increase', {
    method: 'POST',
    headers: signedHeaders(rawBody),
    body: rawBody,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
}

function undefinedColumn(): Error {
  return Object.assign(
    new Error('column "metadata" of relation "universal_royalty_ledger" does not exist'),
    { code: '42703' },
  );
}

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

interface LedgerRow {
  rights_holder_id: string;
  amount_cents: string;
  transaction_type: string;
  reference_id: string;
}

/**
 * Ledger-backed fake with lineage awareness — the PR #26 fake plus:
 *  - holder resolution via the payoutRouting path (matched FIRST: the
 *    lineage lookup's UCT subquery also contains jsonb_array_elements),
 *  - the exact-match lineage lookup keyed by the canonical value,
 *  - capture of the full metadata param (index 4, JSON) of each insert.
 */
function lineageBackedDb(
  options: {
    lineageByValue?: Record<string, { cbt_code: string; uct: string | null }>;
    throwUniqueAfterFirstInsert?: boolean;
    metadataColumnMissing?: boolean;
  } = {},
) {
  const ledgerRows: LedgerRow[] = [];
  const insertedMetadata: Record<string, unknown>[] = [];
  const txQueries: QueryCall[] = [];
  const txQuery = vi.fn((sql: string, params?: unknown[]) => {
    txQueries.push({ sql, params });
    if (sql.includes("rh->'payoutRouting'")) {
      return Promise.resolve({ rows: [{ rights_holder_id: HOLDER_ID }] });
    }
    if (sql.includes("mapped_identifiers->>'")) {
      const match = options.lineageByValue?.[String(params?.[0])] ?? null;
      return Promise.resolve(
        match ? { rows: [{ cbt_code: match.cbt_code, uct: match.uct }] } : { rows: [] },
      );
    }
    if (sql.includes('SAVEPOINT')) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('INSERT INTO universal_royalty_ledger')) {
      // UNIQUE (reference_id): the second identical insert 23505s — replays
      // reach the route's dedup handler, never a second lineage write.
      if (options.throwUniqueAfterFirstInsert && ledgerRows.length >= 1) {
        throw uniqueViolation();
      }
      if (sql.includes('metadata') && options.metadataColumnMissing) throw undefinedColumn();
      ledgerRows.push({
        rights_holder_id: String(params?.[0]),
        amount_cents: String(params?.[1]),
        transaction_type: String(params?.[2]),
        reference_id: String(params?.[3]),
      });
      if (params?.[4] !== undefined) {
        insertedMetadata.push(JSON.parse(String(params[4])) as Record<string, unknown>);
      }
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
  const tx = { query: txQuery };
  const db = {
    query: vi.fn(),
    transaction: vi.fn(
      async <T>(work: (tx: { query: typeof txQuery }) => Promise<T>): Promise<T> => work(tx),
    ),
  };
  return { db, ledgerRows, insertedMetadata, txQueries };
}

function stubTransferFetch(transfer: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
  // A fresh Response per call — a Response body is single-use, and the
  // replay test fetches the same transfer twice.
  fetchMock.mockImplementation(async () => jsonResponse(transfer));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubEnv('INCREASE_WEBHOOK_SECRET', SECRET_WHSEC);
  vi.stubEnv('INCREASE_API_KEY', 'test-increase-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('W1 — registered ISRC memo: credited once + exact lineage with assetCode and uct', () => {
  it('credits the row and merges resolution exact with the matched asset code and holder UCT', async () => {
    const { db, ledgerRows, insertedMetadata } = lineageBackedDb({
      lineageByValue: { [REGISTERED_ISRC]: { cbt_code: REGISTERED_ASSET_CODE, uct: REGISTERED_UCT } },
    });
    mockGetDb.mockReturnValue(db as never);
    stubTransferFetch(
      achTransferObject({ company_entry_description: 'ROYALTY PAYOUT ISRC: US-S1M-26-77777' }),
    );

    const res = await POST(
      signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
    );
    expect(res.status).toBe(200);
    expect(ledgerRows).toHaveLength(1); // credited exactly once
    expect(ledgerRows[0]).toMatchObject({
      rights_holder_id: HOLDER_ID,
      amount_cents: '1500000',
      reference_id: ACH_TRANSFER_ID,
    });
    const lineage = insertedMetadata[0]?.lineage as Record<string, unknown> | undefined;
    expect(lineage).toBeDefined();
    expect(lineage).toMatchObject({
      resolution: 'exact',
      assetCode: REGISTERED_ASSET_CODE,
      uct: REGISTERED_UCT,
      references: [{ kind: 'ISRC', value: REGISTERED_ISRC, raw: 'ISRC: US-S1M-26-77777' }],
    });
    expect(Number.isNaN(Date.parse(String(lineage?.parsedAt)))).toBe(false);
  });

  it('resolves via ISWC when the memo carries a work identifier', async () => {
    const { db, insertedMetadata } = lineageBackedDb({
      lineageByValue: {
        'T-0123456789-9': { cbt_code: REGISTERED_ASSET_CODE, uct: REGISTERED_UCT },
      },
    });
    mockGetDb.mockReturnValue(db as never);
    stubTransferFetch(
      wireTransferObject({ unstructured_remittance_information: 'Pub royalty T-0123456789-9' }),
    );
    const res = await POST(
      signedRequest(eventEnvelope('inbound_wire_transfer.created', WIRE_TRANSFER_ID)),
    );
    expect(res.status).toBe(200);
    const lineage = insertedMetadata[0]?.lineage as Record<string, unknown> | undefined;
    expect(lineage).toMatchObject({
      resolution: 'exact',
      assetCode: REGISTERED_ASSET_CODE,
      uct: REGISTERED_UCT,
      references: [{ kind: 'ISWC', value: 'T-0123456789-9', raw: 'T-0123456789-9' }],
    });
  });
});

describe('W2 — unregistered ISRC: credit + resolution unmatched, no mutation', () => {
  it('credits the row, marks lineage unmatched, and never touches cbt_assets rows', async () => {
    const { db, ledgerRows, insertedMetadata, txQueries } = lineageBackedDb({
      lineageByValue: {}, // nothing registered
    });
    mockGetDb.mockReturnValue(db as never);
    stubTransferFetch(
      achTransferObject({ company_entry_description: 'Payout for ISRC: US-S1M-26-77777' }),
    );

    const res = await POST(
      signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
    );
    expect(res.status).toBe(200);
    expect(ledgerRows).toHaveLength(1);
    const lineage = insertedMetadata[0]?.lineage as Record<string, unknown> | undefined;
    expect(lineage).toMatchObject({
      resolution: 'unmatched',
      references: [{ kind: 'ISRC', value: REGISTERED_ISRC }],
    });
    expect('assetCode' in (lineage ?? {})).toBe(false);
    expect('uct' in (lineage ?? {})).toBe(false);
    // NO asset mutation — ever. Lineage only READS cbt_assets.
    const mutating = txQueries.filter(
      (q) => /UPDATE\s+cbt_assets/i.test(q.sql) || /DELETE\s+FROM\s+cbt_assets/i.test(q.sql),
    );
    expect(mutating).toEqual([]);
  });
});

describe('W3 — no identifiers: credit, no lineage key', () => {
  it('credits the row and writes metadata with NO lineage key at all', async () => {
    const { db, ledgerRows, insertedMetadata } = lineageBackedDb();
    mockGetDb.mockReturnValue(db as never);
    stubTransferFetch(achTransferObject()); // default object carries no memo identifiers

    const res = await POST(
      signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
    );
    expect(res.status).toBe(200);
    expect(ledgerRows).toHaveLength(1);
    expect(insertedMetadata).toHaveLength(1);
    expect('lineage' in insertedMetadata[0]).toBe(false);
  });
});

describe('W4 — malformed memo / parse exception / missing column: credit unaffected', () => {
  it('credits the row when the memo is garbage (no parseable identifier)', async () => {
    const { db, ledgerRows, insertedMetadata } = lineageBackedDb();
    mockGetDb.mockReturnValue(db as never);
    stubTransferFetch(
      achTransferObject({ company_entry_description: 'ISRC: @@garbage@@ no code here' }),
    );

    const res = await POST(
      signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
    );
    expect(res.status).toBe(200);
    expect(ledgerRows).toHaveLength(1); // the credit stands
    expect('lineage' in insertedMetadata[0]).toBe(false); // and no lineage key
  });

  it('skips lineage (savepoint rollback) when parsing throws, credit stands', async () => {
    const { db, ledgerRows, insertedMetadata, txQueries } = lineageBackedDb();
    mockGetDb.mockReturnValue(db as never);
    stubTransferFetch(
      achTransferObject({ company_entry_description: 'Payout for ISRC: US-S1M-26-77777' }),
    );
    // Force the parse step to explode inside the enrichment path.
    mockParseExternalReferences.mockImplementationOnce(() => {
      throw new Error('memo parse exploded');
    });

    const res = await POST(
      signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
    );
    expect(res.status).toBe(200);
    expect(ledgerRows).toHaveLength(1); // money never blocks on enrichment
    expect(insertedMetadata).toHaveLength(1);
    expect('lineage' in insertedMetadata[0]).toBe(false);
    // The savepoint pattern ran: rolled back, then released.
    expect(
      txQueries.some((q) => q.sql.includes('ROLLBACK TO SAVEPOINT covenant_lineage_enrich')),
    ).toBe(true);
    expect(
      txQueries.some((q) => q.sql.includes('RELEASE SAVEPOINT covenant_lineage_enrich')),
    ).toBe(true);
  });

  it('credits the row WITHOUT metadata when the column is missing (42703 fallback)', async () => {
    const { db, ledgerRows, insertedMetadata } = lineageBackedDb({
      lineageByValue: { [REGISTERED_ISRC]: { cbt_code: REGISTERED_ASSET_CODE, uct: REGISTERED_UCT } },
      metadataColumnMissing: true,
    });
    mockGetDb.mockReturnValue(db as never);
    stubTransferFetch(
      achTransferObject({ company_entry_description: 'Payout for ISRC: US-S1M-26-77777' }),
    );

    const res = await POST(
      signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
    );
    expect(res.status).toBe(200);
    expect(ledgerRows).toHaveLength(1); // the credit stands, unmetadata'd
    expect(insertedMetadata).toHaveLength(0);
  });
});

describe('W5 — replay: no double credit, no duplicate lineage', () => {
  it('answers the duplicate delivery with deduplicated and writes lineage exactly once', async () => {
    const { db, ledgerRows, insertedMetadata } = lineageBackedDb({
      lineageByValue: { [REGISTERED_ISRC]: { cbt_code: REGISTERED_ASSET_CODE, uct: REGISTERED_UCT } },
      throwUniqueAfterFirstInsert: true, // UNIQUE (reference_id) — first-insert only
    });
    mockGetDb.mockReturnValue(db as never);
    const transfer = achTransferObject({
      company_entry_description: 'Payout for ISRC: US-S1M-26-77777',
    });
    stubTransferFetch(transfer); // mockResolvedValue → answers BOTH fetches

    const envelope = eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID);
    const first = await POST(signedRequest(envelope));
    const replay = await POST(signedRequest(envelope));
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { deduplicated?: boolean };
    expect(replayBody.deduplicated).toBe(true);

    expect(ledgerRows).toHaveLength(1); // credited once
    const lineageWrites = insertedMetadata.filter((metadata) => 'lineage' in metadata);
    expect(lineageWrites).toHaveLength(1); // lineage written exactly once
    expect((lineageWrites[0].lineage as Record<string, unknown>).resolution).toBe('exact');
  });
});

describe('W6 — lineage merge preserves existing provenance keys', () => {
  it('keeps every PR #26 provenance key alongside the lineage object on the same row', async () => {
    const { db, insertedMetadata } = lineageBackedDb({
      lineageByValue: { [REGISTERED_ISRC]: { cbt_code: REGISTERED_ASSET_CODE, uct: REGISTERED_UCT } },
    });
    mockGetDb.mockReturnValue(db as never);
    stubTransferFetch(
      wireTransferObject({
        unstructured_remittance_information: 'DISTRO payout ISRC:US-S1M-26-77777 T-0123456789-9',
      }),
    );

    const res = await POST(
      signedRequest(eventEnvelope('inbound_wire_transfer.created', WIRE_TRANSFER_ID)),
    );
    expect(res.status).toBe(200);
    const metadata = insertedMetadata[0];
    // All pinned provenance keys survive the merge...
    expect(metadata).toMatchObject({
      increaseEventCategory: 'inbound_wire_transfer.created',
      inboundRail: 'ROYALTY_INBOUND_WIRE',
      destinationAccountNumberId: ACCOUNT_NUMBER_ID,
      inboundTransferId: WIRE_TRANSFER_ID,
      senderName: 'DISTROKID',
      creditorName: 'Test Holder',
      endToEndIdentification: 'Invoice 29582',
      uetr: '9a21e10a-7600-4a24-8ff3-2cbc5943c27a',
      imad: '20220118MMQFMP0P000001',
      instructionIdentification: '202201180000001',
      remittanceInformation: 'DISTRO payout ISRC:US-S1M-26-77777 T-0123456789-9',
      senderAccountNumber: '987654321',
      senderRoutingNumber: '101050001',
    });
    // ...and the lineage object rides in the SAME metadata untouched.
    const lineage = metadata.lineage as Record<string, unknown>;
    expect(lineage).toMatchObject({
      resolution: 'exact',
      assetCode: REGISTERED_ASSET_CODE,
      uct: REGISTERED_UCT,
      references: [
        { kind: 'ISRC', value: REGISTERED_ISRC, raw: 'ISRC:US-S1M-26-77777' },
        { kind: 'ISWC', value: 'T-0123456789-9', raw: 'T-0123456789-9' },
      ],
    });
  });
});
