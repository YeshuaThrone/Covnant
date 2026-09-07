import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { TaxProfile } from '@/engine/covenant-master-sdk';
import { POST, PUT } from '../route';
import { getDb } from '@/lib/db';

/**
 * POST/PUT /api/banking contract tests. Mocks only — no network, no database.
 * getDb is mocked with a fake pool/transaction covering rights_holders reads,
 * cbt_assets reads, ledger aggregate reads, the in-transaction ledger INSERTs,
 * and the pool-level reversal INSERT; fetch is stubbed for the Increase call.
 */

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }));

const mockGetDb = vi.mocked(getDb);

const LITHIC_SECRET = 'test-lithic-secret';
const AUTH_EVENT = 'card_authorization.request';

/** Holder profile on an asset, unverified US → 24% engine rate. */
function unverifiedUsProfile(): TaxProfile {
  return {
    taxFormType: 'W9_US_PERSON',
    taxIdentifierEncrypted: 'test-identifier',
    usTaxResident: true,
    isBackupWithholdingRequired: false,
    isVerified: false,
  };
}

function verifiedUsProfile(): TaxProfile {
  return { ...unverifiedUsProfile(), isVerified: true };
}

/** Ledger gross of 2.00 for rh_1 → 24% tax 0.48 → available 1.52 (152000000 units). */
const grossLedgerRows = [{ disbursements: [{ rightsHolderId: 'rh_1', grossShare: 2.0 }] }];

const holderAssets = [
  { rights_holders: [{ id: 'rh_1', name: 'Test Holder', role: 'COMPOSER', taxProfile: unverifiedUsProfile() }] },
];

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

function fakeDb(options: {
  holderByToken?: { id: string } | null;
  holderById?: { id: string; routing_number: string | null; account_number: string | null } | null;
  assetRows?: unknown[];
  ledgerRows?: { disbursements: unknown }[];
  transactionError?: Error;
} = {}) {
  const txQueries: QueryCall[] = [];
  const poolQueries: QueryCall[] = [];
  const txQuery = vi.fn((sql: string, params?: unknown[]) => {
    txQueries.push({ sql, params });
    if (sql.includes('FROM rights_holders')) {
      const row = sql.includes('lithic_card_token')
        ? (options.holderByToken ?? null)
        : (options.holderById ?? null);
      return Promise.resolve({ rows: row ? [row] : [] });
    }
    if (sql.includes('FROM cbt_assets')) {
      return Promise.resolve({ rows: options.assetRows ?? [] });
    }
    if (sql.includes('FROM universal_royalty_ledger')) {
      return Promise.resolve({ rows: options.ledgerRows ?? [] });
    }
    return Promise.resolve({ rows: [] });
  });
  const tx = { query: txQuery };
  const db = {
    query: vi.fn((sql: string, params?: unknown[]) => {
      poolQueries.push({ sql, params });
      return Promise.resolve({ rows: [] });
    }),
    transaction: vi.fn(async <T>(work: (tx: { query: typeof txQuery }) => Promise<T>): Promise<T> => {
      if (options.transactionError) throw options.transactionError;
      return work(tx);
    }),
  };
  return { db, txQueries, poolQueries, tx };
}

function stubFetch(sequence: Response[]) {
  const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
  for (const res of sequence) fetchMock.mockResolvedValueOnce(res);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function lithicSignedRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/banking', { method: 'POST', headers, body });
}

function signLithic(payload: string, secret = LITHIC_SECRET): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function authPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_type: AUTH_EVENT,
    card_token: 'card_1',
    amount: '100000000',
    transaction_token: 'lithic_txn_1',
    ...overrides,
  });
}

function putRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/banking', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const connectedHolder = { id: 'rh_1', routing_number: '021000021', account_number: '123456789' };

function happyDb(overrides: Parameters<typeof fakeDb>[0] = {}) {
  return fakeDb({
    holderByToken: { id: 'rh_1' },
    holderById: connectedHolder,
    assetRows: holderAssets,
    ledgerRows: grossLedgerRows,
    ...overrides,
  });
}

beforeEach(() => {
  vi.stubEnv('LITHIC_WEBHOOK_SECRET', LITHIC_SECRET);
  vi.stubEnv('INCREASE_API_KEY', 'test-increase-key');
  vi.stubEnv('INCREASE_SOURCE_ACCOUNT_ID', 'src_acc_1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('POST /api/banking — Lithic authorization webhook', () => {
  it('returns 401 when the signature header is missing', async () => {
    const res = await POST(lithicSignedRequest(authPayload()));
    expect(res.status).toBe(401);
  });

  it('returns 401 when LITHIC_WEBHOOK_SECRET is unconfigured', async () => {
    vi.stubEnv('LITHIC_WEBHOOK_SECRET', '');
    const body = authPayload();
    const res = await POST(lithicSignedRequest(body, { 'lithic-signature': signLithic(body) }));
    expect(res.status).toBe(401);
  });

  it('returns 403 for an invalid signature', async () => {
    const res = await POST(
      lithicSignedRequest(authPayload(), { 'lithic-signature': signLithic(authPayload(), 'wrong-secret') }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Invalid HMAC signature');
  });

  it('returns 200 CONTINUE for a non-authorization event without touching the database', async () => {
    const body = JSON.stringify({ event_type: 'token.webhook', token: 'card_1' });
    const res = await POST(lithicSignedRequest(body, { 'lithic-signature': signLithic(body) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'CONTINUE' });
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it('declines CARD_NOT_FOUND (200) when no holder owns the card token', async () => {
    const fake = happyDb({ holderByToken: null });
    mockGetDb.mockReturnValue(fake.db as never);
    const body = authPayload();
    const res = await POST(lithicSignedRequest(body, { 'x-lithic-signature': signLithic(body) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'DECLINED', reason: 'CARD_NOT_FOUND' });
    expect(fake.txQueries.some((q) => q.sql.includes('INSERT INTO'))).toBe(false);
  });

  it('declines INSUFFICIENT_FUNDS (200) when the request exceeds the derived balance', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    const body = authPayload({ amount: '200000000' });
    const res = await POST(lithicSignedRequest(body, { 'lithic-signature': signLithic(body) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'DECLINED', reason: 'INSUFFICIENT_FUNDS' });
    expect(fake.txQueries.some((q) => q.sql.includes('INSERT INTO'))).toBe(false);
  });

  it('approves a funded authorization and records the CARD_AUTHORIZATION debit', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    const body = authPayload();
    const res = await POST(lithicSignedRequest(body, { 'lithic-signature': signLithic(body) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'APPROVED' });

    const inserts = fake.txQueries.filter((q) => q.sql.includes('INSERT INTO'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sql).toContain("'CARD_AUTHORIZATION'");
    const [entry] = JSON.parse(inserts[0].params?.[2] as string) as [
      {
        type: string;
        rightsHolderId: string;
        payoutAmount: string;
        remainingNetBalance: string;
        referenceId?: string;
      },
    ];
    expect(entry.type).toBe('DISBURSEMENT');
    expect(entry.rightsHolderId).toBe('rh_1');
    expect(entry.payoutAmount).toBe('100000000');
    expect(entry.remainingNetBalance).toBe('52000000');
    expect(entry.referenceId).toBe('lithic_txn_1');
  });

  it('accepts the alternate x-lithic-signature header and integer amounts', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    const body = authPayload({ amount: 100000000 });
    const res = await POST(lithicSignedRequest(body, { 'x-lithic-signature': signLithic(body) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'APPROVED' });
  });

  it('returns 200 DECLINED/INTERNAL_ERROR (never 5xx) when the database transaction fails', async () => {
    const fake = happyDb({ transactionError: new Error('connection refused') });
    mockGetDb.mockReturnValue(fake.db as never);
    const body = authPayload();
    const res = await POST(lithicSignedRequest(body, { 'lithic-signature': signLithic(body) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'DECLINED', reason: 'INTERNAL_ERROR' });
  });

  it('returns 200 DECLINED/INTERNAL_ERROR when DATABASE_URL is unconfigured', async () => {
    mockGetDb.mockReturnValue(null);
    const body = authPayload();
    const res = await POST(lithicSignedRequest(body, { 'lithic-signature': signLithic(body) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'DECLINED', reason: 'INTERNAL_ERROR' });
  });
});

describe('PUT /api/banking — Increase RTP disbursement', () => {
  it('returns 400 for invalid payout parameters', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    for (const amountInCents of [undefined, '', 'abc', '0', '-5', 1.5, '1e9']) {
      const res = await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents }));
      expect(res.status).toBe(400);
    }
    for (const rightsHolderId of [undefined, '', 42]) {
      const res = await PUT(putRequest({ rightsHolderId, amountInCents: '100000000' }));
      expect(res.status).toBe(400);
    }
  });

  it('returns 400 for amounts above Number.MAX_SAFE_INTEGER', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    const res = await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '9007199254740993' }));
    expect(res.status).toBe(400);
  });

  it('returns 503 when Increase is unconfigured', async () => {
    vi.stubEnv('INCREASE_API_KEY', '');
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    const res = await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000000' }));
    expect(res.status).toBe(503);
  });

  it('returns 404 when the rights holder does not exist', async () => {
    const fake = happyDb({ holderById: null });
    mockGetDb.mockReturnValue(fake.db as never);
    const res = await PUT(putRequest({ rightsHolderId: 'rh_missing', amountInCents: '100000000' }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Rights holder not found.');
  });

  it('returns 422 when the payout exceeds the derived escrow balance', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    const res = await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '200000000' }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('Insufficient escrow balance for withdrawal.');
  });

  it('returns 409 when the holder has no full account number for RTP', async () => {
    const fake = happyDb({ holderById: { id: 'rh_1', routing_number: '021000021', account_number: null } });
    mockGetDb.mockReturnValue(fake.db as never);
    const res = await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000000' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('No verified banking destination found for Increase payout.');
  });

  it('reserves the hold, withholds 24% tax, dispatches the net payable, and returns ok', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    const fetchMock = stubFetch([jsonResponse({ id: 'rtp_1', status: 'succeeded' })]);

    const res = await PUT(
      putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000000' }, { 'Idempotency-Key': 'idem-1' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.disbursementId).toBe('rtp_1');
    expect(body.amountCents).toBe('100000000');
    expect(body.taxWithheld).toBe('24000000');
    expect(body.netAmountCents).toBe('76000000');

    const holdInserts = fake.txQueries.filter((q) => q.sql.includes('INSERT INTO'));
    expect(holdInserts).toHaveLength(1);
    expect(holdInserts[0].sql).toContain("'PENDING_DISBURSEMENT'");
    const [entry] = JSON.parse(holdInserts[0].params?.[2] as string) as [
      { payoutAmount: string; taxWithheld: string; idempotencyKey?: string },
    ];
    expect(entry.payoutAmount).toBe('100000000');
    expect(entry.taxWithheld).toBe('24000000');
    expect(entry.idempotencyKey).toBe('idem-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string>; body: string };
    expect(init.headers['Idempotency-Key']).toBe('idem-1');
    const sentBody = JSON.parse(init.body) as {
      amount: number;
      destination_account_number: string;
      destination_routing_number: string;
      source_account_id: string;
      remittance_information: string;
    };
    expect(sentBody.amount).toBe(76000000);
    expect(sentBody.destination_account_number).toBe('123456789');
    expect(sentBody.destination_routing_number).toBe('021000021');
    expect(sentBody.source_account_id).toBe('src_acc_1');
    expect(sentBody.remittance_information).toBe('Covenant Royalty Escrow Disbursement');
  });

  it('withholds nothing for verified profiles and dispatches the gross amount', async () => {
    const fake = happyDb({
      assetRows: [
        { rights_holders: [{ id: 'rh_1', name: 'Test Holder', role: 'COMPOSER', taxProfile: verifiedUsProfile() }] },
      ],
    });
    mockGetDb.mockReturnValue(fake.db as never);
    const fetchMock = stubFetch([jsonResponse({ id: 'rtp_2', status: 'succeeded' })]);

    const res = await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: 100000000 }));
    const body = await res.json();
    expect(body.taxWithheld).toBe('0');
    expect(body.netAmountCents).toBe('100000000');
    const init = fetchMock.mock.calls[0][1] as RequestInit & { body: string };
    expect((JSON.parse(init.body) as { amount: number }).amount).toBe(100000000);
  });

  it('falls back to a fresh UUID idempotency key when the client supplies none', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    const fetchMock = stubFetch([jsonResponse({ id: 'rtp_3', status: 'succeeded' })]);

    await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000000' }));
    const init = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honors the idempotencyKey body field when no header is present', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    const fetchMock = stubFetch([jsonResponse({ id: 'rtp_4', status: 'succeeded' })]);

    await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000000', idempotencyKey: 'key-body-1' }));
    const init = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers['Idempotency-Key']).toBe('key-body-1');
  });

  it('records a DISBURSEMENT_REVERSAL and fails sanitized when Increase rejects the transfer', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    stubFetch([jsonResponse({ detail: 'Insufficient source balance — internal upstream detail' }, 422)]);

    const res = await PUT(
      putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000000' }, { 'Idempotency-Key': 'idem-2' }),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('Increase RTP transfer failed.');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('Insufficient source balance');
    expect(serialized).not.toContain('123456789');

    const reversals = fake.poolQueries.filter((q) => q.sql.includes('INSERT INTO'));
    expect(reversals).toHaveLength(1);
    expect(reversals[0].sql).toContain("'DISBURSEMENT_REVERSAL'");
    const [entry] = JSON.parse(reversals[0].params?.[2] as string) as [
      { payoutAmount: string; reversalOf?: string },
    ];
    expect(entry.payoutAmount).toBe('-100000000');
    expect(entry.reversalOf).toBe('idem-2');
  });

  it('never leaks the full account number in a successful response', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    stubFetch([jsonResponse({ id: 'rtp_5', status: 'succeeded' })]);

    const res = await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000000' }));
    const serialized = JSON.stringify(await res.json());
    expect(serialized).not.toContain('123456789');
  });
});
