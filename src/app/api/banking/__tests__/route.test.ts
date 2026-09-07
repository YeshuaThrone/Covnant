import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { TaxProfile } from '@/engine/covenant-master-sdk';
import { POST, PUT } from '../route';
import { getDb } from '@/lib/db';

/**
 * POST/PUT /api/banking contract tests against the authoritative live schema:
 * holders resolve through the GIN-indexed cbt_assets.rights_holders JSONB
 * (payoutRouting / taxProfile), balances are the flat SUM(amount_cents) over
 * the holder's ledger rows, and reference_id carries the database idempotency
 * (23505 replay/duplicate handling). pg + fetch are mocked — no network, no
 * database, no env vars.
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

/** Unverified foreign profile → 30% engine rate (same shape as the conservative fallback). */
function unverifiedForeignProfile(): TaxProfile {
  return {
    taxFormType: 'W8BEN_FOREIGN_INDIVIDUAL',
    taxIdentifierEncrypted: 'test-identifier',
    usTaxResident: false,
    isBackupWithholdingRequired: false,
    isVerified: false,
  };
}

/** Full rights_holders JSONB element as stored on a cbt_assets row. */
function holderEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rightsHolderId: 'rh_1',
    name: 'Test Holder',
    role: 'COMPOSER',
    taxProfile: unverifiedUsProfile(),
    payoutRouting: { routingNumber: '021000021', accountNumber: '123456789' },
    ...overrides,
  };
}

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

/** A pg unique-violation error (the ledger's UNIQUE reference_id). */
function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
}

function fakeDb(options: {
  /** rights_holder_id resolved by the JSONB card-token lookup (null → no match) */
  holderByToken?: string | null;
  /** full JSONB holder entry resolved by the rightsHolderId lookup (null → no match) */
  holderById?: Record<string, unknown> | null;
  /** SUM(amount_cents) result as pg returns it: a string */
  availableCents?: string;
  transactionError?: Error;
} = {}) {
  const txQueries: QueryCall[] = [];
  const poolQueries: QueryCall[] = [];
  const txQuery = vi.fn((sql: string, params?: unknown[]) => {
    txQueries.push({ sql, params });
    if (sql.includes('jsonb_array_elements')) {
      if (sql.includes('lithicCardToken')) {
        return Promise.resolve(
          options.holderByToken ? { rows: [{ rights_holder_id: options.holderByToken }] } : { rows: [] },
        );
      }
      return Promise.resolve(
        options.holderById ? { rows: [{ holder: options.holderById }] } : { rows: [] },
      );
    }
    if (sql.includes('SUM(amount_cents)')) {
      return Promise.resolve({ rows: [{ available_cents: options.availableCents ?? '0' }] });
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
    amount: '2500',
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

function happyDb(overrides: Parameters<typeof fakeDb>[0] = {}) {
  return fakeDb({
    holderByToken: 'rh_1',
    holderById: holderEntry(),
    availableCents: '100000',
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

  it('resolves the holder through the JSONB with FOR UPDATE and sums the flat ledger', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    const body = authPayload();
    await POST(lithicSignedRequest(body, { 'lithic-signature': signLithic(body) }));

    const [holderQuery, balanceQuery, insertQuery] = fake.txQueries;
    expect(holderQuery.sql).toContain('jsonb_array_elements(rights_holders)');
    expect(holderQuery.sql).toContain("rh->'payoutRouting'->>'lithicCardToken' = $1");
    expect(holderQuery.sql).toContain('FOR UPDATE');
    expect(holderQuery.params).toEqual(['card_1']);
    expect(balanceQuery.sql).toContain('COALESCE(SUM(amount_cents), 0)');
    expect(balanceQuery.sql).toContain('WHERE rights_holder_id = $1');
    expect(balanceQuery.params).toEqual(['rh_1']);
    // Database calls align exactly to the live schema: no legacy tables/columns.
    for (const q of [...fake.txQueries, ...fake.poolQueries]) {
      expect(q.sql).not.toContain('FROM rights_holders');
      expect(q.sql).not.toContain('gross_settled');
      expect(q.sql).not.toContain('disbursements');
    }
    expect(insertQuery.sql).toContain('INSERT INTO universal_royalty_ledger');
  });

  it('declines CARD_NOT_FOUND (200) when no holder routes the card token', async () => {
    const fake = happyDb({ holderByToken: null });
    mockGetDb.mockReturnValue(fake.db as never);
    const body = authPayload();
    const res = await POST(lithicSignedRequest(body, { 'x-lithic-signature': signLithic(body) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'DECLINED', reason: 'CARD_NOT_FOUND' });
    expect(fake.txQueries.some((q) => q.sql.includes('INSERT INTO'))).toBe(false);
  });

  it('declines INSUFFICIENT_FUNDS (200) against an empty ledger without writing a debit', async () => {
    const fake = happyDb({ availableCents: '0' });
    mockGetDb.mockReturnValue(fake.db as never);
    const body = authPayload();
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
    expect(inserts[0].sql).toContain('reference_id');
    // amount_cents = −amount as a BigInt string; reference_id = transaction_token.
    expect(inserts[0].params).toEqual(['rh_1', '-2500', 'lithic_txn_1']);
  });

  it('treats a 23505 unique-violation as a webhook replay and returns APPROVED', async () => {
    const fake = happyDb({ transactionError: uniqueViolation() });
    mockGetDb.mockReturnValue(fake.db as never);
    const body = authPayload();
    const res = await POST(lithicSignedRequest(body, { 'lithic-signature': signLithic(body) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'APPROVED' });
  });

  it('accepts the alternate x-lithic-signature header and integer amounts', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    const body = authPayload({ amount: 2500 });
    const res = await POST(lithicSignedRequest(body, { 'x-lithic-signature': signLithic(body) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'APPROVED' });
  });

  it('returns 200 DECLINED/INTERNAL_ERROR for a malformed payload', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    const body = authPayload({ amount: null });
    const res = await POST(lithicSignedRequest(body, { 'lithic-signature': signLithic(body) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'DECLINED', reason: 'INTERNAL_ERROR' });
    expect(fake.txQueries).toHaveLength(0);
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
      const res = await PUT(putRequest({ rightsHolderId, amountInCents: '100000' }));
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
    const res = await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000' }));
    expect(res.status).toBe(503);
  });

  it('returns 503 when DATABASE_URL is unconfigured', async () => {
    mockGetDb.mockReturnValue(null);
    const res = await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000' }));
    expect(res.status).toBe(503);
  });

  it('returns 404 when the holder is on no cbt_assets JSONB array', async () => {
    const fake = happyDb({ holderById: null });
    mockGetDb.mockReturnValue(fake.db as never);
    const res = await PUT(putRequest({ rightsHolderId: 'rh_missing', amountInCents: '100000' }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Rights holder not found.');
  });

  it('returns 422 when the payout exceeds the SUM-derived balance of an empty ledger', async () => {
    const fake = happyDb({ availableCents: '0' });
    mockGetDb.mockReturnValue(fake.db as never);
    const res = await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000' }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('Insufficient escrow balance for withdrawal.');
    expect(fake.txQueries.some((q) => q.sql.includes('INSERT INTO'))).toBe(false);
  });

  it('returns 409 when payoutRouting has no full account number for RTP', async () => {
    const fake = happyDb({ holderById: holderEntry({ payoutRouting: { routingNumber: '021000021' } }) });
    mockGetDb.mockReturnValue(fake.db as never);
    const res = await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('No verified banking destination found for Increase payout.');
  });

  it('reserves the net, withholds 24% for an unverified US profile, and dispatches net cents', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    const fetchMock = stubFetch([jsonResponse({ id: 'rtp_1', status: 'succeeded' })]);

    const res = await PUT(
      putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000' }, { 'Idempotency-Key': 'idem-1' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.disbursementId).toBe('rtp_1');
    expect(body.amountCents).toBe('100000');
    expect(body.taxWithheld).toBe('24000');
    expect(body.netAmountCents).toBe('76000');

    const holdInserts = fake.txQueries.filter((q) => q.sql.includes('INSERT INTO'));
    expect(holdInserts).toHaveLength(1);
    expect(holdInserts[0].sql).toContain("'PENDING_DISBURSEMENT'");
    expect(holdInserts[0].sql).toContain('reference_id');
    // Hold = −net cents, reference_id = the client's idempotency key.
    expect(holdInserts[0].params).toEqual(['rh_1', '-76000', 'idem-1']);

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
    expect(sentBody.amount).toBe(76000);
    expect(sentBody.destination_account_number).toBe('123456789');
    expect(sentBody.destination_routing_number).toBe('021000021');
    expect(sentBody.source_account_id).toBe('src_acc_1');
    expect(sentBody.remittance_information).toBe('Covenant Royalty Escrow Disbursement');
  });

  it('withholds 30% for an unverified foreign profile', async () => {
    const fake = happyDb({ holderById: holderEntry({ taxProfile: unverifiedForeignProfile() }) });
    mockGetDb.mockReturnValue(fake.db as never);
    const fetchMock = stubFetch([jsonResponse({ id: 'rtp_2', status: 'succeeded' })]);

    const res = await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000' }));
    const body = await res.json();
    expect(body.taxWithheld).toBe('30000');
    expect(body.netAmountCents).toBe('70000');
    const init = fetchMock.mock.calls[0][1] as RequestInit & { body: string };
    expect((JSON.parse(init.body) as { amount: number }).amount).toBe(70000);
  });

  it('falls back to the conservative 30% rate when the JSONB entry carries no tax profile', async () => {
    const entryWithoutProfile: Record<string, unknown> = holderEntry();
    delete entryWithoutProfile.taxProfile;
    const fake = happyDb({ holderById: entryWithoutProfile });
    mockGetDb.mockReturnValue(fake.db as never);
    const fetchMock = stubFetch([jsonResponse({ id: 'rtp_3', status: 'succeeded' })]);

    const res = await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000' }));
    const body = await res.json();
    expect(body.taxWithheld).toBe('30000');
    expect(body.netAmountCents).toBe('70000');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('withholds nothing for verified profiles and dispatches the gross amount', async () => {
    const fake = happyDb({ holderById: holderEntry({ taxProfile: verifiedUsProfile() }) });
    mockGetDb.mockReturnValue(fake.db as never);
    const fetchMock = stubFetch([jsonResponse({ id: 'rtp_4', status: 'succeeded' })]);

    const res = await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: 100000 }));
    const body = await res.json();
    expect(body.taxWithheld).toBe('0');
    expect(body.netAmountCents).toBe('100000');
    const init = fetchMock.mock.calls[0][1] as RequestInit & { body: string };
    expect((JSON.parse(init.body) as { amount: number }).amount).toBe(100000);
    const holdInserts = fake.txQueries.filter((q) => q.sql.includes('INSERT INTO'));
    expect(holdInserts[0].params).toEqual(['rh_1', '-100000', expect.any(String)]);
  });

  it('fails closed with a sanitized 500 when the net is not a whole-cent multiple', async () => {
    // 100001 cents at 24% → net 76,000,760,000 units → 76000.76 cents: not exact.
    const fake = happyDb({ availableCents: '100001' });
    mockGetDb.mockReturnValue(fake.db as never);
    const fetchMock = stubFetch([jsonResponse({ id: 'rtp_x', status: 'succeeded' })]);

    const res = await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '100001' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Payout cannot be represented in whole cents.');
    expect(fake.txQueries.some((q) => q.sql.includes('INSERT INTO'))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 409 on a 23505 duplicate submission and never holds twice', async () => {
    const fake = happyDb({ transactionError: uniqueViolation() });
    mockGetDb.mockReturnValue(fake.db as never);
    const fetchMock = stubFetch([jsonResponse({ id: 'rtp_5', status: 'succeeded' })]);

    const res = await PUT(
      putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000' }, { 'Idempotency-Key': 'idem-dup' }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('disbursement already in progress for this idempotency key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to a fresh UUID idempotency key when the client supplies none', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    const fetchMock = stubFetch([jsonResponse({ id: 'rtp_6', status: 'succeeded' })]);

    await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000' }));
    const init = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honors the idempotencyKey body field when no header is present', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    const fetchMock = stubFetch([jsonResponse({ id: 'rtp_7', status: 'succeeded' })]);

    await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000', idempotencyKey: 'key-body-1' }));
    const holdInserts = fake.txQueries.filter((q) => q.sql.includes('INSERT INTO'));
    expect(holdInserts[0].params?.[2]).toBe('key-body-1');
    const init = fetchMock.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers['Idempotency-Key']).toBe('key-body-1');
  });

  it('records a +net DISBURSEMENT_REVERSAL and fails sanitized when Increase rejects the transfer', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    stubFetch([jsonResponse({ detail: 'Insufficient source balance — internal upstream detail' }, 422)]);

    const res = await PUT(
      putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000' }, { 'Idempotency-Key': 'idem-2' }),
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
    expect(reversals[0].sql).toContain('reference_id');
    // +net cents unwinds the −net hold; reference_id = 'reversal-' + key.
    expect(reversals[0].params).toEqual(['rh_1', '76000', 'reversal-idem-2']);
  });

  it('never leaks the full account number in a successful response', async () => {
    const fake = happyDb();
    mockGetDb.mockReturnValue(fake.db as never);
    stubFetch([jsonResponse({ id: 'rtp_8', status: 'succeeded' })]);

    const res = await PUT(putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000' }));
    const serialized = JSON.stringify(await res.json());
    expect(serialized).not.toContain('123456789');
  });
});
