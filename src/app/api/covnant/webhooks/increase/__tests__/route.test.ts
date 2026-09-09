import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../route';
import { getDb } from '@/lib/db';

/**
 * POST /api/covnant/webhooks/increase contract tests
 * (CovnantRoyaltyTrackingAPI, rail-agnostic).
 *
 * Covers the pinned Standard Webhooks HMAC verification, the per-rail
 * credit/replay/unmapped matrix (ACH, wire, Real-Time Payments, FedNow),
 * each rail's documented failure unwind, provenance metadata (success and
 * 42703 fallback), and instant availability against the banking routes'
 * unfiltered SUM(amount_cents) derivation. The db fake is backed by a real
 * row store; Increase fetches are mocked.
 */

vi.mock('@/lib/db', () => ({ getDb: vi.fn() }));

const mockGetDb = vi.mocked(getDb);

const SECRET_RAW = 'test-increase-webhook-secret';
const SECRET_WHSEC = `whsec_${Buffer.from(SECRET_RAW).toString('base64')}`;
const SECRET_RAW_BYTES = Buffer.from(SECRET_RAW, 'utf8');
const EVENT_ID = 'event_001test';
const ACCOUNT_NUMBER_ID = 'account_number_v18nkfqm6afpsrvy82b2';
const HOLDER_ID = 'rh_1';

/** Event envelope — the webhook body is the Event object only (pinned). */
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
const RTP_TRANSFER_ID = 'inbound_real_time_payments_transfer_63hlz498vcxg644hcrzr';
const FEDNOW_TRANSFER_ID = 'inbound_fednow_transfer_ctxxbc07oh5ke5w1hk20';

/** Pinned Inbound ACH Transfer object. */
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

/** Pinned Inbound Wire Transfer object. */
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

/** Pinned Inbound Real-Time Payments Transfer object. */
function rtpTransferObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RTP_TRANSFER_ID,
    account_id: 'account_in71c4amph0vgo2qllky',
    account_number_id: ACCOUNT_NUMBER_ID,
    amount: 9900,
    status: 'confirmed',
    created_at: '2026-09-07T00:00:00Z',
    creditor_name: 'Test Holder',
    currency: 'USD',
    debtor_name: 'NATIONAL PHONOGRAPH COMPANY',
    debtor_account_number: '987654321',
    debtor_routing_number: '101050001',
    decline: null,
    transaction_identification: '20220501234567891T1BSLZO01745013025',
    confirmation: { confirmed_at: '2026-09-07T00:00:00Z', transaction_id: 'transaction_rtp_confirm_1' },
    unstructured_remittance_information: 'Invoice 29582',
    type: 'inbound_real_time_payments_transfer',
    ...overrides,
  };
}

/** Pinned Inbound FedNow Transfer object. */
function fednowTransferObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FEDNOW_TRANSFER_ID,
    account_id: 'account_in71c4amph0vgo2qllky',
    account_number_id: ACCOUNT_NUMBER_ID,
    amount: 500000,
    status: 'confirmed',
    created_at: '2026-09-07T00:00:00Z',
    creditor_name: 'Test Holder',
    currency: 'USD',
    debtor_name: 'NATIONAL PHONOGRAPH COMPANY',
    debtor_account_number: '987654321',
    debtor_routing_number: '101050001',
    decline: null,
    confirmation: { transfer_id: FEDNOW_TRANSFER_ID },
    transaction_id: 'transaction_fednow_confirm_1',
    unique_end_to_end_transaction_reference: '9a21e10a-7600-4a24-8ff3-2cbc5943c27a',
    unstructured_remittance_information: 'Invoice 29582',
    type: 'inbound_fednow_transfer',
    ...overrides,
  };
}

/** Standard Webhooks signature: "v1,<base64 HMAC-SHA256(id.timestamp.body)>". */
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

function webhookRequest(rawBody: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/covnant/webhooks/increase', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

function signedRequest(envelope: unknown, headers: Record<string, string> = {}): Request {
  const rawBody = JSON.stringify(envelope);
  return webhookRequest(rawBody, { ...signedHeaders(rawBody), ...headers });
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

/** The banking routes' exact balance derivation — copied verbatim. */
const BANKING_BALANCE_SQL =
  'SELECT COALESCE(SUM(amount_cents), 0) AS available_cents FROM universal_royalty_ledger WHERE rights_holder_id = $1';

/**
 * A db fake backed by a real row store: INSERTs append, and the banking
 * routes' balance derivation is EVALUATED over the store — proving
 * webhook-written rows are instantly visible to it.
 */
function ledgerBackedDb(
  options: {
    rightsHolderId?: string | null;
    insertError?: Error;
    metadataColumnMissing?: boolean;
  } = {},
) {
  const ledgerRows: LedgerRow[] = [];
  const txQueries: QueryCall[] = [];
  const txQuery = vi.fn((sql: string, params?: unknown[]) => {
    txQueries.push({ sql, params });
    if (sql.includes('jsonb_array_elements')) {
      return options.rightsHolderId
        ? Promise.resolve({ rows: [{ rights_holder_id: options.rightsHolderId }] })
        : Promise.resolve({ rows: [] });
    }
    if (sql.includes('COALESCE(SUM(amount_cents)')) {
      const holder = String(params?.[0]);
      const total = ledgerRows
        .filter((row) => row.rights_holder_id === holder)
        .reduce((sum, row) => sum + BigInt(row.amount_cents), 0n);
      return Promise.resolve({ rows: [{ available_cents: total.toString() }] });
    }
    if (sql.includes('SAVEPOINT')) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('INSERT INTO universal_royalty_ledger')) {
      if (options.insertError) throw options.insertError;
      if (sql.includes('metadata') && options.metadataColumnMissing) throw undefinedColumn();
      ledgerRows.push({
        rights_holder_id: String(params?.[0]),
        amount_cents: String(params?.[1]),
        transaction_type: String(params?.[2]),
        reference_id: String(params?.[3]),
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
  return { db, ledgerRows, txQueries, insertCalls, tx };
}

function stubTransferFetch(transfer: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn<
    (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  >();
  fetchMock.mockResolvedValueOnce(jsonResponse(transfer));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const RAIL_CASES = [
  {
    label: 'inbound ACH',
    stem: 'inbound_ach_transfer',
    resource: 'inbound_ach_transfers',
    transactionType: 'ROYALTY_INBOUND_ACH',
    transfer: () => achTransferObject(),
    senderName: 'ASCAP',
  },
  {
    label: 'inbound wire',
    stem: 'inbound_wire_transfer',
    resource: 'inbound_wire_transfers',
    transactionType: 'ROYALTY_INBOUND_WIRE',
    transfer: () => wireTransferObject(),
    senderName: 'DISTROKID',
  },
  {
    label: 'inbound Real-Time Payments',
    stem: 'inbound_real_time_payments_transfer',
    resource: 'inbound_real_time_payments_transfers',
    transactionType: 'ROYALTY_INBOUND_RTP',
    transfer: () => rtpTransferObject(),
    senderName: 'NATIONAL PHONOGRAPH COMPANY',
  },
  {
    label: 'inbound FedNow',
    stem: 'inbound_fednow_transfer',
    resource: 'inbound_fednow_transfers',
    transactionType: 'ROYALTY_INBOUND_FEDNOW',
    transfer: () => fednowTransferObject(),
    senderName: 'NATIONAL PHONOGRAPH COMPANY',
  },
] as const;

beforeEach(() => {
  vi.stubEnv('INCREASE_WEBHOOK_SECRET', SECRET_WHSEC);
  vi.stubEnv('INCREASE_API_KEY', 'test-increase-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('POST /api/covnant/webhooks/increase', () => {
  describe('HMAC verification (fail closed)', () => {
    const rawBody = JSON.stringify(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID));

    it.each([
      ['webhook-id', 'webhook-timestamp'],
      ['webhook-id', 'webhook-signature'],
      ['webhook-timestamp', 'webhook-signature'],
    ])('returns 401 when signature headers are missing (%s)', async (...missing) => {
      const headers = signedHeaders(rawBody);
      for (const name of missing) delete headers[name];
      const res = await POST(webhookRequest(rawBody, headers));
      expect(res.status).toBe(401);
      expect(mockGetDb).not.toHaveBeenCalled();
    });

    it('returns 401 when INCREASE_WEBHOOK_SECRET is unconfigured', async () => {
      vi.stubEnv('INCREASE_WEBHOOK_SECRET', '');
      const res = await POST(webhookRequest(rawBody, signedHeaders(rawBody)));
      expect(res.status).toBe(401);
    });

    it('returns 403 for an invalid signature', async () => {
      const res = await POST(
        webhookRequest(rawBody, signedHeaders(rawBody, Buffer.from('wrong secret', 'utf8'))),
      );
      expect(res.status).toBe(403);
      expect(mockGetDb).not.toHaveBeenCalled();
    });

    it('returns 403 for a stale timestamp outside the freshness window', async () => {
      const stale = Math.floor(Date.now() / 1000) - 400;
      const res = await POST(webhookRequest(rawBody, signedHeaders(rawBody, SECRET_RAW_BYTES, stale)));
      expect(res.status).toBe(403);
    });

    it('accepts a raw (non-whsec_) configured secret', async () => {
      vi.stubEnv('INCREASE_WEBHOOK_SECRET', SECRET_RAW);
      const { db } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(achTransferObject());
      const res = await POST(signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)));
      expect(res.status).toBe(200);
    });
  });

  describe('rail-agnostic credit matrix (created events)', () => {
    for (const rail of RAIL_CASES) {
      describe(`rail: ${rail.label}`, () => {
        it('credits a verified created event atomically with rail provenance', async () => {
          const transfer = rail.transfer();
          const { db, insertCalls } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
          mockGetDb.mockReturnValue(db as never);
          const fetchMock = stubTransferFetch(transfer);
          const res = await POST(
            signedRequest(eventEnvelope(`${rail.stem}.created`, String(transfer.id))),
          );
          expect(res.status).toBe(200);
          const bodyJson = (await res.json()) as { ok: boolean };
          expect(bodyJson.ok).toBe(true);

          // The authoritative resource was fetched on the pinned URL.
          expect(fetchMock).toHaveBeenCalledTimes(1);
          const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
          expect(url).toBe(`https://api.increase.com/${rail.resource}/${String(transfer.id)}`);
          expect((init.headers as Record<string, string>).Authorization).toBe(
            'Bearer test-increase-key',
          );

          // Exactly one atomic, replay-safe, rail-typed credit.
          const inserts = insertCalls();
          expect(inserts).toHaveLength(1);
          const params = inserts[0].params as unknown[];
          expect(params[1]).toBe(String(transfer.amount));
          expect(params[2]).toBe(rail.transactionType);
          expect(params[3]).toBe(String(transfer.id));

          // Full provenance payload.
          const metadata = JSON.parse(String(params[4])) as Record<string, unknown>;
          expect(metadata).toMatchObject({
            increaseEventCategory: `${rail.stem}.created`,
            inboundRail: rail.transactionType,
            destinationAccountNumberId: ACCOUNT_NUMBER_ID,
            inboundTransferId: String(transfer.id),
            senderName: rail.senderName,
          });
        });

        it('treats a 23505 replay of the credit as 200 without a second row', async () => {
          const transfer = rail.transfer();
          const { db, insertCalls, ledgerRows } = ledgerBackedDb({
            rightsHolderId: HOLDER_ID,
            insertError: uniqueViolation(),
          });
          mockGetDb.mockReturnValue(db as never);
          stubTransferFetch(transfer);
          const res = await POST(
            signedRequest(eventEnvelope(`${rail.stem}.created`, String(transfer.id))),
          );
          expect(res.status).toBe(200);
          const bodyJson = (await res.json()) as { ok: boolean; deduplicated: boolean };
          expect(bodyJson).toEqual({ ok: true, deduplicated: true });
          expect(insertCalls()).toHaveLength(1);
          expect(ledgerRows).toHaveLength(0);
        });

        it('rejects an unmapped destination account with a retryable non-2xx', async () => {
          const transfer = rail.transfer();
          const { db, insertCalls } = ledgerBackedDb({ rightsHolderId: null });
          mockGetDb.mockReturnValue(db as never);
          stubTransferFetch(transfer);
          const res = await POST(
            signedRequest(eventEnvelope(`${rail.stem}.created`, String(transfer.id))),
          );
          expect(res.status).toBe(503);
          const bodyJson = (await res.json()) as { ok: boolean; error: string };
          expect(bodyJson.ok).toBe(false);
          expect(insertCalls()).toHaveLength(0);
        });
      });
    }

    it('resolves the holder via the GIN JSONB lookup under FOR UPDATE', async () => {
      const { db, txQueries } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(achTransferObject());
      const res = await POST(
        signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
      );
      expect(res.status).toBe(200);
      const holderSelect = txQueries.find((q) => q.sql.includes('jsonb_array_elements'));
      expect(holderSelect?.sql).toContain(
        "rh->'payoutRouting'->'covenantVirtualAccount'->>'accountNumberId' = $1",
      );
      expect(holderSelect?.sql).toContain('FOR UPDATE');
      expect(holderSelect?.params).toEqual([ACCOUNT_NUMBER_ID]);
    });

    it('proves instant availability to the unfiltered banking SUM derivation', async () => {
      const { db, ledgerRows, tx } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(achTransferObject());
      const achRes = await POST(
        signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
      );
      expect(achRes.status).toBe(200);
      stubTransferFetch(wireTransferObject());
      const wireRes = await POST(
        signedRequest(eventEnvelope('inbound_wire_transfer.created', WIRE_TRANSFER_ID)),
      );
      expect(wireRes.status).toBe(200);
      expect(ledgerRows).toHaveLength(2);

      // The exact banking balance derivation, evaluated over the store.
      expect(BANKING_BALANCE_SQL).not.toContain('transaction_type');
      const balance = (await tx.query(BANKING_BALANCE_SQL, [HOLDER_ID])) as {
        rows: Array<{ available_cents: string }>;
      };
      expect(balance.rows[0].available_cents).toBe('1750000');
    });

    it('maps an ACH debit-direction transfer to a retryable 503 without ledger movement', async () => {
      const { db, insertCalls } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(achTransferObject({ direction: 'debit' }));
      const res = await POST(
        signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
      );
      expect(res.status).toBe(503);
      expect(insertCalls()).toHaveLength(0);
    });

    it('ignores a created event for an already-failed transfer (nothing was credited)', async () => {
      const { db, insertCalls } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(wireTransferObject({ status: 'reversed' }));
      const res = await POST(
        signedRequest(eventEnvelope('inbound_wire_transfer.created', WIRE_TRANSFER_ID)),
      );
      expect(res.status).toBe(200);
      const bodyJson = (await res.json()) as { ignored: boolean };
      expect(bodyJson.ignored).toBe(true);
      expect(insertCalls()).toHaveLength(0);
    });
  });

  describe('per-rail failure unwinds (updated events)', () => {
    it('debits an ACH return against the return transaction id, replay-safe', async () => {
      const { db, insertCalls } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(
        achTransferObject({
          status: 'returned',
          transfer_return: {
            reason: 'consumer_authorized_revocation',
            returned_at: '2026-09-08T00:00:00Z',
            transaction_id: 'transaction_return_test_1',
          },
        }),
      );
      const res = await POST(
        signedRequest(eventEnvelope('inbound_ach_transfer.updated', ACH_TRANSFER_ID)),
      );
      expect(res.status).toBe(200);
      const inserts = insertCalls();
      expect(inserts).toHaveLength(1);
      const params = inserts[0].params as unknown[];
      expect(params[1]).toBe('-1500000');
      expect(params[2]).toBe('ROYALTY_INBOUND_RETURN');
      expect(params[3]).toBe('inbound_ach_transfer_return:transaction_return_test_1');
      const metadata = JSON.parse(String(params[4])) as Record<string, unknown>;
      expect(metadata.returnTransactionId).toBe('transaction_return_test_1');
      expect(metadata.returnReason).toBe('consumer_authorized_revocation');
    });

    it('debits an ACH decline against the transfer id', async () => {
      const { db, insertCalls } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(
        achTransferObject({
          status: 'declined',
          decline: { reason: 'no_data', declined_transaction_id: 'transaction_declined_1' },
        }),
      );
      const res = await POST(
        signedRequest(eventEnvelope('inbound_ach_transfer.updated', ACH_TRANSFER_ID)),
      );
      expect(res.status).toBe(200);
      const params = insertCalls()[0].params as unknown[];
      expect(params[1]).toBe('-1500000');
      expect(params[3]).toBe(`inbound_ach_transfer_declined:${ACH_TRANSFER_ID}`);
    });

    it('debits a reversed wire with reversal provenance', async () => {
      const { db, insertCalls } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(
        wireTransferObject({
          status: 'reversed',
          reversal: { reason: 'creditor_request', reversed_at: '2026-09-08T00:00:00Z' },
        }),
      );
      const res = await POST(
        signedRequest(eventEnvelope('inbound_wire_transfer.updated', WIRE_TRANSFER_ID)),
      );
      expect(res.status).toBe(200);
      const inserts = insertCalls();
      expect(inserts).toHaveLength(1);
      const params = inserts[0].params as unknown[];
      expect(params[1]).toBe('-250000');
      expect(params[2]).toBe('ROYALTY_INBOUND_RETURN');
      expect(params[3]).toBe(`inbound_wire_transfer_reversed:${WIRE_TRANSFER_ID}`);
      const metadata = JSON.parse(String(params[4])) as Record<string, unknown>;
      expect(metadata.reversalReason).toBe('creditor_request');
      expect(metadata.uetr).toBe('9a21e10a-7600-4a24-8ff3-2cbc5943c27a');
      expect(metadata.imad).toBe('20220118MMQFMP0P000001');
    });

    it('debits a declined wire', async () => {
      const { db, insertCalls } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(wireTransferObject({ status: 'declined' }));
      const res = await POST(
        signedRequest(eventEnvelope('inbound_wire_transfer.updated', WIRE_TRANSFER_ID)),
      );
      expect(res.status).toBe(200);
      const params = insertCalls()[0].params as unknown[];
      expect(params[1]).toBe('-250000');
      expect(params[3]).toBe(`inbound_wire_transfer_declined:${WIRE_TRANSFER_ID}`);
    });

    it('debits a declined RTP transfer with network provenance', async () => {
      const { db, insertCalls } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(
        rtpTransferObject({
          status: 'declined',
          decline: {
            reason: 'account_restricted',
            declined_at: '2026-09-08T00:00:00Z',
            declined_transaction_id: 'transaction_rtp_declined_1',
          },
        }),
      );
      const res = await POST(
        signedRequest(eventEnvelope('inbound_real_time_payments_transfer.updated', RTP_TRANSFER_ID)),
      );
      expect(res.status).toBe(200);
      const params = insertCalls()[0].params as unknown[];
      expect(params[1]).toBe('-9900');
      expect(params[3]).toBe(`inbound_real_time_payments_transfer_declined:${RTP_TRANSFER_ID}`);
      const metadata = JSON.parse(String(params[4])) as Record<string, unknown>;
      expect(metadata.networkTransactionIdentification).toBe(
        '20220501234567891T1BSLZO01745013025',
      );
      expect(metadata.declineReason).toBe('account_restricted');
    });

    it('debits a timed-out RTP transfer (money never arrived)', async () => {
      const { db, insertCalls } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(rtpTransferObject({ status: 'timed_out' }));
      const res = await POST(
        signedRequest(eventEnvelope('inbound_real_time_payments_transfer.updated', RTP_TRANSFER_ID)),
      );
      expect(res.status).toBe(200);
      const params = insertCalls()[0].params as unknown[];
      expect(params[1]).toBe('-9900');
      expect(params[3]).toBe(`inbound_real_time_payments_transfer_timed_out:${RTP_TRANSFER_ID}`);
    });

    it('debits a declined FedNow transfer with decline provenance', async () => {
      const { db, insertCalls } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(
        fednowTransferObject({
          status: 'declined',
          decline: { reason: 'account_number_disabled', transfer_id: FEDNOW_TRANSFER_ID },
        }),
      );
      const res = await POST(
        signedRequest(eventEnvelope('inbound_fednow_transfer.updated', FEDNOW_TRANSFER_ID)),
      );
      expect(res.status).toBe(200);
      const params = insertCalls()[0].params as unknown[];
      expect(params[1]).toBe('-500000');
      expect(params[3]).toBe(`inbound_fednow_transfer_declined:${FEDNOW_TRANSFER_ID}`);
      const metadata = JSON.parse(String(params[4])) as Record<string, unknown>;
      expect(metadata.declinedTransferId).toBe(FEDNOW_TRANSFER_ID);
      expect(metadata.declineReason).toBe('account_number_disabled');
    });

    it('debits a timed-out FedNow transfer', async () => {
      const { db, insertCalls } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(fednowTransferObject({ status: 'timed_out' }));
      const res = await POST(
        signedRequest(eventEnvelope('inbound_fednow_transfer.updated', FEDNOW_TRANSFER_ID)),
      );
      expect(res.status).toBe(200);
      const params = insertCalls()[0].params as unknown[];
      expect(params[1]).toBe('-500000');
      expect(params[3]).toBe(`inbound_fednow_transfer_timed_out:${FEDNOW_TRANSFER_ID}`);
    });

    it('treats a 23505 replay of a compensating debit as 200 without a second row', async () => {
      const { db, insertCalls, ledgerRows } = ledgerBackedDb({
        rightsHolderId: HOLDER_ID,
        insertError: uniqueViolation(),
      });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(
        achTransferObject({
          status: 'returned',
          transfer_return: { reason: 'no_data', transaction_id: 'transaction_return_test_1' },
        }),
      );
      const res = await POST(
        signedRequest(eventEnvelope('inbound_ach_transfer.updated', ACH_TRANSFER_ID)),
      );
      expect(res.status).toBe(200);
      const bodyJson = (await res.json()) as { ok: boolean; deduplicated: boolean };
      expect(bodyJson).toEqual({ ok: true, deduplicated: true });
      expect(insertCalls()).toHaveLength(1);
      expect(ledgerRows).toHaveLength(0);
    });

    it('treats intermediate status transitions as balance-neutral 200 no-ops', async () => {
      const { db, insertCalls } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      for (const [category, transfer] of [
        ['inbound_wire_transfer', wireTransferObject({ status: 'accepted' })],
        ['inbound_real_time_payments_transfer', rtpTransferObject({ status: 'pending_confirming' })],
        ['inbound_fednow_transfer', fednowTransferObject({ status: 'requires_attention' })],
        ['inbound_ach_transfer', achTransferObject({ status: 'accepted' })],
      ] as const) {
        stubTransferFetch(transfer);
        const res = await POST(
          signedRequest(eventEnvelope(`${category}.updated`, String(transfer.id))),
        );
        expect(res.status).toBe(200);
        const bodyJson = (await res.json()) as { ignored: boolean };
        expect(bodyJson.ignored).toBe(true);
      }
      expect(insertCalls()).toHaveLength(0);
    });
  });

  describe('excluded and unknown event categories', () => {
    it.each([
      ['inbound_check_deposit.created', 'inbound_check_deposit_zoshvqybq0cjjm31mra'],
      ['inbound_wire_drawdown_request.created', 'inbound_wire_drawdown_request_4e5tt9spdircdrbuexsq'],
      ['inbound_mail_item.created', 'inbound_mail_item_4e5tt9spdircdrbuexsq'],
      ['transaction.created', 'transaction_uyrp7fld2ium70oa7oi'],
    ])('handles %s as a graceful 200 no-op with no database touch', async (category, objectId) => {
      const { db } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      const res = await POST(signedRequest(eventEnvelope(category, objectId)));
      expect(res.status).toBe(200);
      const bodyJson = (await res.json()) as { ignored: boolean };
      expect(bodyJson.ignored).toBe(true);
      expect(mockGetDb).not.toHaveBeenCalled();
    });
  });

  describe('provenance metadata column (42703 fallback)', () => {
    it('credits without provenance when the metadata column is missing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { db, ledgerRows, txQueries } = ledgerBackedDb({
        rightsHolderId: HOLDER_ID,
        metadataColumnMissing: true,
      });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(achTransferObject());
      const res = await POST(
        signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
      );
      expect(res.status).toBe(200);
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]).toEqual({
        rights_holder_id: HOLDER_ID,
        amount_cents: '1500000',
        transaction_type: 'ROYALTY_INBOUND_ACH',
        reference_id: ACH_TRANSFER_ID,
      });
      const sqlSequence = txQueries.map((q) => q.sql).join('\n');
      expect(sqlSequence).toContain('SAVEPOINT covnant_royalty_ledger_insert');
      expect(sqlSequence).toContain('ROLLBACK TO SAVEPOINT covnant_royalty_ledger_insert');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('debits an ACH return without provenance when the column is missing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { db, ledgerRows } = ledgerBackedDb({
        rightsHolderId: HOLDER_ID,
        metadataColumnMissing: true,
      });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(
        achTransferObject({
          status: 'returned',
          transfer_return: { reason: 'no_data', transaction_id: 'transaction_return_test_1' },
        }),
      );
      const res = await POST(
        signedRequest(eventEnvelope('inbound_ach_transfer.updated', ACH_TRANSFER_ID)),
      );
      expect(res.status).toBe(200);
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]).toEqual({
        rights_holder_id: HOLDER_ID,
        amount_cents: '-1500000',
        transaction_type: 'ROYALTY_INBOUND_RETURN',
        reference_id: 'inbound_ach_transfer_return:transaction_return_test_1',
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('debits a wire reversal without provenance when the column is missing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { db, ledgerRows } = ledgerBackedDb({
        rightsHolderId: HOLDER_ID,
        metadataColumnMissing: true,
      });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(
        wireTransferObject({
          status: 'reversed',
          reversal: { reason: 'duplicate', reversed_at: '2026-09-08T00:00:00Z' },
        }),
      );
      const res = await POST(
        signedRequest(eventEnvelope('inbound_wire_transfer.updated', WIRE_TRANSFER_ID)),
      );
      expect(res.status).toBe(200);
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]).toEqual({
        rights_holder_id: HOLDER_ID,
        amount_cents: '-250000',
        transaction_type: 'ROYALTY_INBOUND_RETURN',
        reference_id: `inbound_wire_transfer_reversed:${WIRE_TRANSFER_ID}`,
      });
      warnSpy.mockRestore();
    });

    it('writes provenance on compensating debits when the column exists', async () => {
      const { db, insertCalls } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(
        wireTransferObject({
          status: 'reversed',
          reversal: { reason: 'duplicate', reversed_at: '2026-09-08T00:00:00Z' },
        }),
      );
      const res = await POST(
        signedRequest(eventEnvelope('inbound_wire_transfer.updated', WIRE_TRANSFER_ID)),
      );
      expect(res.status).toBe(200);
      const inserts = insertCalls();
      expect(inserts).toHaveLength(1);
      expect(inserts[0].sql).toContain('metadata');
      const metadata = JSON.parse(String(inserts[0].params?.[4])) as Record<string, unknown>;
      expect(metadata.increaseEventCategory).toBe('inbound_wire_transfer.updated');
      expect(metadata.senderName).toBe('DISTROKID');
    });
  });

  describe('infrastructure fail-closed', () => {
    it('returns 503 when INCREASE_API_KEY is unconfigured', async () => {
      vi.stubEnv('INCREASE_API_KEY', '');
      const { db } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      const res = await POST(
        signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
      );
      expect(res.status).toBe(503);
    });

    it('returns 503 when the database is unconfigured', async () => {
      mockGetDb.mockReturnValue(null);
      stubTransferFetch(achTransferObject());
      const res = await POST(
        signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
      );
      expect(res.status).toBe(503);
    });

    it('maps an Increase fetch failure to a retryable 503', async () => {
      const fetchMock = vi.fn<
        (input: string | URL | Request, init?: RequestInit) => Promise<Response>
      >();
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      vi.stubGlobal('fetch', fetchMock);
      const { db } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      const res = await POST(
        signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
      );
      expect(res.status).toBe(503);
    });

    it('maps an unprocessable transfer amount to a retryable 503', async () => {
      const { db } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(achTransferObject({ amount: 'not-a-number' }));
      const res = await POST(
        signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
      );
      expect(res.status).toBe(503);
    });

    it('maps a transfer missing pinned fields to a retryable 503', async () => {
      const { db } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(achTransferObject({ account_number_id: undefined }));
      const res = await POST(
        signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)),
      );
      expect(res.status).toBe(503);
    });
  });

  describe('schema hygiene', () => {
    it('issues no banking-era schema queries (gross_settled, disbursements, rights_holders table)', async () => {
      const { db, txQueries } = ledgerBackedDb({ rightsHolderId: HOLDER_ID });
      mockGetDb.mockReturnValue(db as never);
      stubTransferFetch(achTransferObject());
      await POST(signedRequest(eventEnvelope('inbound_ach_transfer.created', ACH_TRANSFER_ID)));
      const allSql = txQueries.map((q) => q.sql).join('\n');
      expect(allSql).not.toContain('FROM rights_holders');
      expect(allSql).not.toContain('gross_settled');
      expect(allSql).not.toContain('disbursements');
    });
  });
});
