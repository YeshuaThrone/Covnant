import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../route';
import { getDb, type Db } from '@/lib/db';
import {
  CBT_SETTLEMENT_CODE_PATTERN,
  generateCBTSettlementCode,
} from '@/lib/ledger/cbt-settlement';

/**
 * V1/V3/V4 route-level evidence for the deterministic CBT settlement stamp.
 * The shared ledger INSERT (LEDGER_INSERT_SQL) serves BOTH webhook paths —
 * the royalty credit and the ROYALTY_INBOUND_RETURN compensating debit — so
 * one wired merge covers two enumerated insert paths. The db fake mirrors the
 * frozen harness in route.test.ts (unmodified) with dynamic UNIQUE-violation
 * behavior for the replay case.
 */

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }));

const mockGetDb = vi.mocked(getDb);

const SECRET_RAW = 'test-increase-webhook-secret';
const SECRET_WHSEC = `whsec_${Buffer.from(SECRET_RAW).toString('base64')}`;
const SECRET_RAW_BYTES = Buffer.from(SECRET_RAW, 'utf8');
const EVENT_ID = 'event_001test';
const ACCOUNT_NUMBER_ID = 'account_number_v18nkfqm6afpsrvy82b2';
const HOLDER_ID = 'rh_1';
const ACH_TRANSFER_ID = 'inbound_ach_transfer_tdrwqr3fq9gnnq49odev';

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

function signedHeaders(rawBody: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `v1,${createHmac('sha256', SECRET_RAW_BYTES)
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
  return new Request('http://localhost/api/covnant/webhooks/increase', {
    method: 'POST',
    headers: signedHeaders(rawBody),
    body: rawBody,
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
  metadata: unknown;
}

function cbtDb(options: { metadataColumnMissing?: boolean } = {}) {
  const ledgerRows: LedgerRow[] = [];
  const txQueries: QueryCall[] = [];
  const txQuery = vi.fn((sql: string, params?: unknown[]) => {
    txQueries.push({ sql, params });
    if (sql.includes('jsonb_array_elements')) {
      return Promise.resolve({ rows: [{ rights_holder_id: HOLDER_ID }] });
    }
    if (sql.includes('SAVEPOINT') || sql.includes('RELEASE')) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('INSERT INTO universal_royalty_ledger')) {
      if (sql.includes('metadata') && options.metadataColumnMissing) throw undefinedColumn();
      const referenceId = String(params?.[3]);
      if (ledgerRows.some((row) => row.reference_id === referenceId)) throw uniqueViolation();
      ledgerRows.push({
        rights_holder_id: String(params?.[0]),
        amount_cents: String(params?.[1]),
        transaction_type: String(params?.[2]),
        reference_id: referenceId,
        metadata: params?.[4],
      });
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
  const insertCalls = () =>
    txQueries.filter((q) => q.sql.includes('INSERT INTO universal_royalty_ledger'));
  return { db, ledgerRows, txQueries, insertCalls };
}

function stubTransferFetch(transfer: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn<
    (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  >();
  // A fresh Response per call: the replay test fetches the transfer twice,
  // and a Response body can only be consumed once.
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify(transfer), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
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

describe('CBT settlement stamp — Increase webhook ledger inserts', () => {
  it('V1 · the royalty-credit path stamps metadata.cbt with the deterministic code', async () => {
    const transfer = achTransferObject();
    stubTransferFetch(transfer);
    const { db, insertCalls } = cbtDb();
    mockGetDb.mockReturnValue(db as unknown as Db);

    const response = await POST(
      signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
    );
    expect(response.status).toBe(200);

    const inserts = insertCalls();
    expect(inserts).toHaveLength(1);
    const [insert] = inserts;
    expect(insert.sql).toContain('metadata');
    const referenceId = String(insert.params?.[3]);
    expect(referenceId).toBe(ACH_TRANSFER_ID);
    const stamped = JSON.parse(String(insert.params?.[4])) as Record<string, unknown>;
    expect(stamped.cbt).toEqual({
      settlementCode: generateCBTSettlementCode(referenceId),
      derivedFrom: 'reference_id',
    });
    expect(
      (stamped.cbt as { settlementCode: string }).settlementCode,
    ).toMatch(CBT_SETTLEMENT_CODE_PATTERN);
    // The rail provenance payload the frozen suite pins survives the merge.
    expect(stamped).toMatchObject({
      increaseEventCategory: 'inbound_ach_transfer.created',
      inboundRail: 'ROYALTY_INBOUND_ACH',
      senderName: 'ASCAP',
    });
  });

  it('V1 · the compensating ROYALTY_INBOUND_RETURN path stamps the same code shape', async () => {
    const transfer = achTransferObject({
      status: 'returned',
      transfer_return: { transaction_id: 'transaction_return_9f2c' },
    });
    stubTransferFetch(transfer);
    const { db, insertCalls } = cbtDb();
    mockGetDb.mockReturnValue(db as unknown as Db);

    const response = await POST(
      signedRequest(eventEnvelope('inbound_ach_transfer.updated', ACH_TRANSFER_ID)),
    );
    expect(response.status).toBe(200);

    const inserts = insertCalls();
    expect(inserts).toHaveLength(1);
    const [insert] = inserts;
    expect(insert.params?.[2]).toBe('ROYALTY_INBOUND_RETURN');
    expect(insert.params?.[3]).toBe('inbound_ach_transfer_return:transaction_return_9f2c');
    const referenceId = String(insert.params?.[3]);
    const stamped = JSON.parse(String(insert.params?.[4])) as Record<string, unknown>;
    expect(stamped.cbt).toEqual({
      settlementCode: generateCBTSettlementCode(referenceId),
      derivedFrom: 'reference_id',
    });
    expect(
      (stamped.cbt as { settlementCode: string }).settlementCode,
    ).toMatch(CBT_SETTLEMENT_CODE_PATTERN);
  });

  it('V3 · a duplicate delivery returns 200, inserts no second row, and re-derives the identical stamp', async () => {
    const transfer = achTransferObject();
    stubTransferFetch(transfer);
    const { db, insertCalls, ledgerRows } = cbtDb();
    mockGetDb.mockReturnValue(db as unknown as Db);

    const envelope = eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID);
    const first = await POST(signedRequest(envelope));
    expect(first.status).toBe(200);
    expect(ledgerRows).toHaveLength(1);
    const firstStamp = JSON.parse(String(insertCalls()[0].params?.[4]));

    const second = await POST(signedRequest(envelope));
    expect(second.status).toBe(200);
    // No second row — the UNIQUE reference_id replay guard held.
    expect(ledgerRows).toHaveLength(1);
    // The replay attempted the SAME deterministic stamp: metadata unchanged.
    expect(insertCalls()).toHaveLength(2);
    const attempted = JSON.parse(String(insertCalls()[1].params?.[4]));
    expect(attempted).toEqual(firstStamp);
  });

  it('V4 · a 42703 metadata failure records the row WITHOUT the code — the money still moves', async () => {
    stubTransferFetch(achTransferObject());
    const { db, insertCalls, ledgerRows } = cbtDb({ metadataColumnMissing: true });
    mockGetDb.mockReturnValue(db as unknown as Db);

    const response = await POST(
      signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
    );
    expect(response.status).toBe(200);

    const inserts = insertCalls();
    expect(inserts).toHaveLength(2);
    expect(inserts[0].sql).toContain('metadata'); // first attempt carried the stamp
    expect(inserts[1].sql).not.toContain('metadata'); // the fallback variant
    expect(inserts[1].params).toHaveLength(4); // the frozen bare parameter list
    // The money moved, appended-only, one row.
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].amount_cents).toBe('1500000');
    expect(ledgerRows[0].transaction_type).toBe('ROYALTY_INBOUND_ACH');
  });
});
