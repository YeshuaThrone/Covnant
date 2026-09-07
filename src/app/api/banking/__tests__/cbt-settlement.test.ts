import { createHmac } from 'node:crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST, PUT } from '../route';
import { getDb, type Db } from '@/lib/db';
import { generateCBTSettlementCode } from '@/lib/ledger/cbt-settlement';

/**
 * CBT settlement evidence for the banking ledger INSERT paths
 * (CARD_AUTHORIZATION debit, PENDING_DISBURSEMENT hold, DISBURSEMENT_REVERSAL
 * unwind) plus the T1 enumerated-site-count pin. The db fake mirrors the
 * frozen harness in route.test.ts (unmodified) with dynamic 42703 behavior.
 */

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }));

const mockGetDb = vi.mocked(getDb);

const LITHIC_SECRET = 'test-lithic-secret';

function holderEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rightsHolderId: 'rh_1',
    name: 'Test Holder',
    role: 'COMPOSER',
    taxProfile: {
      taxFormType: 'W9_US_PERSON',
      taxIdentifierEncrypted: 'test-identifier',
      usTaxResident: true,
      isBackupWithholdingRequired: false,
      isVerified: false,
    },
    payoutRouting: { routingNumber: '021000021', accountNumber: '123456789' },
    ...overrides,
  };
}

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

function undefinedColumn(): Error {
  return Object.assign(
    new Error('column "metadata" of relation "universal_royalty_ledger" does not exist'),
    { code: '42703' },
  );
}

function cbtDb(options: { metadataColumnMissing?: boolean } = {}) {
  const txQueries: QueryCall[] = [];
  const poolQueries: QueryCall[] = [];
  const txQuery = vi.fn((sql: string, params?: unknown[]) => {
    txQueries.push({ sql, params });
    if (sql.includes('jsonb_array_elements')) {
      if (sql.includes('lithicCardToken')) {
        return Promise.resolve({ rows: [{ rights_holder_id: 'rh_1' }] });
      }
      return Promise.resolve({ rows: [{ holder: holderEntry() }] });
    }
    if (sql.includes('SUM(amount_cents)')) {
      return Promise.resolve({ rows: [{ available_cents: '100000' }] });
    }
    if (
      sql.includes('INSERT INTO universal_royalty_ledger') &&
      sql.includes('metadata') &&
      options.metadataColumnMissing
    ) {
      throw undefinedColumn();
    }
    return Promise.resolve({ rows: [] });
  });
  const tx = { query: txQuery };
  const db = {
    query: vi.fn((sql: string, params?: unknown[]) => {
      poolQueries.push({ sql, params });
      if (
        sql.includes('INSERT INTO universal_royalty_ledger') &&
        sql.includes('metadata') &&
        options.metadataColumnMissing
      ) {
        throw undefinedColumn();
      }
      return Promise.resolve({ rows: [] });
    }),
    transaction: vi.fn(
      async <T>(work: (tx: { query: typeof txQuery }) => Promise<T>): Promise<T> => work(tx),
    ),
  };
  return { db, txQueries, poolQueries };
}

function lithicSignedRequest(body: string): Request {
  const signature = createHmac('sha256', LITHIC_SECRET).update(body).digest('hex');
  return new Request('http://localhost/api/banking', {
    method: 'POST',
    headers: { 'lithic-signature': signature },
    body,
  });
}

function authPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_type: 'card_authorization.request',
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

function ledgerInserts(queries: QueryCall[]): QueryCall[] {
  return queries.filter((q) => q.sql.includes('INSERT INTO universal_royalty_ledger'));
}

function stubIncreaseDispatch(response: { id: string; status: string } | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (response === null) throw new Error('network down');
      return new Response(JSON.stringify(response), { status: 200 });
    }),
  );
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

describe('T1 — the enumerated universal_royalty_ledger INSERT site count is pinned', () => {
  // Counted by repo search at build time:
  // - webhook route: ONE shared insert function (royalty credit +
  //   ROYALTY_INBOUND_RETURN compensating debit) with two variants
  //   (metadata / 42703 fallback) = 2 statements, one wired merge point.
  // - banking route: card-authorization, PENDING_DISBURSEMENT hold, and
  //   DISBURSEMENT_REVERSAL unwind — each with primary + 42703 fallback
  //   = 6 statements, three wired merge points.
  // Five logical money paths in total, all stamped with the deterministic
  // CBT code. Any new INSERT path must be wired and these pins updated.
  const WEBHOOK_INSERT_STATEMENTS = 2;
  const BANKING_INSERT_STATEMENTS = 6;

  const countMatches = (source: string): number =>
    (source.match(/INSERT INTO universal_royalty_ledger/g) ?? []).length;

  it('pins the webhook route at exactly two INSERT statements (one wired merge, two paths)', () => {
    const source = readFileSync(
      path.join(__dirname, '..', '..', 'covenant', 'webhooks', 'increase', 'route.ts'),
      'utf8',
    );
    expect(countMatches(source)).toBe(WEBHOOK_INSERT_STATEMENTS);
    // The single wired merge point serves both webhook paths.
    expect((source.match(/withCbtSettlementCode\(/g) ?? []).length).toBe(1);
  });

  it('pins the banking route at exactly six INSERT statements (three wired paths)', () => {
    const source = readFileSync(path.join(__dirname, '..', 'route.ts'), 'utf8');
    expect(countMatches(source)).toBe(BANKING_INSERT_STATEMENTS);
    // One jsonb_build_object stamp per logical path (the fallback variants are bare).
    expect((source.match(/cbtSettlementMetadataSql\(/g) ?? []).length).toBe(3);
  });
});

describe('V1/V4 — card-authorization debit', () => {
  it('V1 · the CARD_AUTHORIZATION INSERT carries the deterministic settlement code in its SQL', async () => {
    const fake = cbtDb();
    mockGetDb.mockReturnValue(fake.db as unknown as Db);
    const body = authPayload();

    const response = await POST(lithicSignedRequest(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: 'APPROVED' });

    const inserts = ledgerInserts(fake.txQueries);
    expect(inserts).toHaveLength(1);
    // The settlement code is inlined from the row's own reference_id
    // (transaction_token) — the frozen three-parameter list is untouched.
    expect(inserts[0].sql).toContain(
      `jsonb_build_object('cbt', jsonb_build_object('settlementCode', '${generateCBTSettlementCode('lithic_txn_1')}', 'derivedFrom', 'reference_id'))`,
    );
    expect(inserts[0].sql).toContain("'CARD_AUTHORIZATION'");
    expect(inserts[0].params).toEqual(['rh_1', '-2500', 'lithic_txn_1']);
  });

  it('V4 · a 42703 metadata failure re-runs the reservation WITHOUT the code — the money still moves', async () => {
    const first = cbtDb({ metadataColumnMissing: true });
    mockGetDb.mockReturnValue(first.db as unknown as Db);
    const body = authPayload();

    const response = await POST(lithicSignedRequest(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: 'APPROVED' });

    const inserts = ledgerInserts(first.txQueries);
    expect(inserts).toHaveLength(2);
    expect(inserts[0].sql).toContain('metadata'); // first attempt carried the stamp
    expect(inserts[1].sql).not.toContain('metadata'); // fresh-transaction fallback
    expect(inserts[1].params).toEqual(['rh_1', '-2500', 'lithic_txn_1']); // same money, no code
  });
});

describe('V1/V4 — RTP disbursement hold and reversal', () => {
  it('V1 · the PENDING_DISBURSEMENT INSERT carries the settlement code derived from the idempotency key', async () => {
    const fake = cbtDb();
    mockGetDb.mockReturnValue(fake.db as unknown as Db);
    stubIncreaseDispatch({ id: 'rtp_cbt_1', status: 'succeeded' });

    const response = await PUT(
      putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000' }, { 'Idempotency-Key': 'idem-cbt-1' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });

    const inserts = ledgerInserts(fake.txQueries);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sql).toContain("'PENDING_DISBURSEMENT'");
    expect(inserts[0].sql).toContain(
      `jsonb_build_object('cbt', jsonb_build_object('settlementCode', '${generateCBTSettlementCode('idem-cbt-1')}', 'derivedFrom', 'reference_id'))`,
    );
    // The frozen three-parameter hold list: −net cents under the client key.
    expect(inserts[0].params).toEqual(['rh_1', '-76000', 'idem-cbt-1']);
  });

  it('V4 · a 42703 metadata failure re-reserves WITHOUT the code and still dispatches the payout', async () => {
    const first = cbtDb({ metadataColumnMissing: true });
    mockGetDb.mockReturnValue(first.db as unknown as Db);
    stubIncreaseDispatch({ id: 'rtp_cbt_2', status: 'succeeded' });

    const response = await PUT(
      putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000' }, { 'Idempotency-Key': 'idem-cbt-2' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, netAmountCents: '76000' });

    const inserts = ledgerInserts(first.txQueries);
    expect(inserts).toHaveLength(2);
    expect(inserts[0].sql).toContain('metadata');
    expect(inserts[1].sql).not.toContain('metadata');
    expect(inserts[1].params).toEqual(['rh_1', '-76000', 'idem-cbt-2']);
  });

  it('V4 · the compensating DISBURSEMENT_REVERSAL carries the code and falls back bare on 42703', async () => {
    const first = cbtDb({ metadataColumnMissing: true });
    mockGetDb.mockReturnValue(first.db as unknown as Db);
    // The dispatch fails → the route unwinds the failed hold with a reversal.
    stubIncreaseDispatch(null);

    await PUT(
      putRequest({ rightsHolderId: 'rh_1', amountInCents: '100000' }, { 'Idempotency-Key': 'idem-cbt-3' }),
    );

    const reversals = ledgerInserts(first.poolQueries);
    expect(reversals).toHaveLength(2);
    expect(reversals[0].sql).toContain("'DISBURSEMENT_REVERSAL'");
    expect(reversals[0].sql).toContain('metadata');
    expect(reversals[0].sql).toContain(
      `jsonb_build_object('cbt', jsonb_build_object('settlementCode', '${generateCBTSettlementCode('reversal-idem-cbt-3')}', 'derivedFrom', 'reference_id'))`,
    );
    // The 42703 fallback retries the SAME unwind without the code.
    expect(reversals[1].sql).not.toContain('metadata');
    expect(reversals[1].params).toEqual(['rh_1', '76000', 'reversal-idem-cbt-3']);
  });
});
