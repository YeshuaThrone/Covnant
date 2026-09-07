/**
 * POST /api/covenant/webhooks/increase — CovnantRoyaltyTrackingAPI
 * (rail-agnostic inbound royalty ingestion).
 *
 * Signature verification (pinned from
 * https://increase.com/documentation/webhooks): Increase signs deliveries
 * per the Standard Webhooks specification with three request headers —
 * `webhook-id` (the Event id), `webhook-timestamp` (unix seconds), and
 * `webhook-signature` (one or more space-separated "v1,<base64>" tokens,
 * plural while signing secrets rotate). The signed payload is
 * "<webhook-id>.<webhook-timestamp>.<raw-body>" and the MAC is HMAC-SHA256
 * keyed with the endpoint's signing secret (INCREASE_WEBHOOK_SECRET; a
 * "whsec_"-prefixed value is the standard-webhooks base64 form — decode
 * before use). Comparison is timing-safe, and the timestamp is checked
 * against a 5-minute freshness window. Missing headers/secret → 401; wrong
 * signature or a stale timestamp → 403 — the body is never processed, and
 * no signature failure can produce a 5xx.
 *
 * Event delivery contract (pinned from the same guide and the API
 * reference): the POST body is the Event object only —
 * { id, created_at, category, associated_object_type, associated_object_id
 * } — with NO transfer fields, so each handled category fetches the
 * authoritative resource using the shared INCREASE_API_KEY.
 *
 * Rail-agnostic ingestion (pinned event categories from the official Event
 * Subscriptions/Events enum; object fields from each resource's reference
 * page). EVERY inbound credit rail Increase emits credits through the SAME
 * atomic idempotent pattern — resolve destination account_number_id →
 * rights holder via the GIN-indexed cbt_assets.rights_holders JSONB
 * (payoutRouting.covenantVirtualAccount.accountNumberId, written by
 * /api/covenant/accounts/provision) under FOR UPDATE, then insert inside
 * the same transaction:
 *
 * | rail (event stem)                  | GET resource                      | transaction_type        | created | failure statuses (compensating debit) |
 * |------------------------------------|-----------------------------------|-------------------------|---------|----------------------------------------|
 * | inbound_ach_transfer               | /inbound_ach_transfers            | ROYALTY_INBOUND_ACH     | credit  | returned, declined                     |
 * | inbound_wire_transfer              | /inbound_wire_transfers           | ROYALTY_INBOUND_WIRE    | credit  | reversed, declined                     |
 * | inbound_real_time_payments_transfer| /inbound_real_time_payments_transfers | ROYALTY_INBOUND_RTP | credit  | declined, timed_out                    |
 * | inbound_fednow_transfer            | /inbound_fednow_transfers         | ROYALTY_INBOUND_FEDNOW  | credit  | declined, timed_out                    |
 *
 * - `.created` → positive BigInt-as-string amount_cents, transaction_type
 *   reflecting the rail, reference_id = the Increase transfer id. A 23505
 *   unique-violation on reference_id is a webhook replay: 200 OK without a
 *   second credit.
 * - `.updated` with a terminal failure status → compensating DEBIT:
 *   negative amount_cents, transaction_type 'ROYALTY_INBOUND_RETURN',
 *   UNIQUE-guarded reference_id namespaced by rail + failure status and
 *   keyed by the strongest identifier the rail's failure object carries —
 *   the ACH return's own `transfer_return.transaction_id`
 *   ("inbound_ach_transfer_return:<id>"), otherwise the transfer id
 *   ("<stem>_<status>:<transfer-id>"; a terminal failure happens at most
 *   once per transfer) — so returns are replay-safe on every rail.
 *   Intermediate statuses (pending/pending_confirming/accepted/confirmed/
 *   requires_attention) are balance-neutral 200 no-ops.
 * - The ACH object additionally carries a `direction` field; royalty
 *   numbers are credit-only (debit_status "blocked" at provisioning), so a
 *   non-credit ACH transfer stays on Increase's retry radar instead of
 *   moving ledger money. The other rails are inherently inbound credits.
 * - Excluded by design (documented, not silently dropped):
 *   `inbound_check_deposit.*` (checks drawn AGAINST the account — debits,
 *   not credits), `inbound_wire_drawdown_request.*` (a request for us to
 *   send a wire), and `inbound_mail_item.*` (physical mail, not money).
 *   Any future category the enum adds is a graceful 200 no-op, per the
 *   API docs' requirement to handle additions.
 *
 * Retry semantics (pinned): Increase retries any non-2xx delivery for up
 * to 8 attempts over ~72 hours, so every unresolved state returns a
 * retryable non-2xx — an unmapped destination account number, an
 * unfetchable Increase resource, or a database outage is a 503 with
 * server-side logs, never a silent 200: money must not vanish quietly.
 *
 * Provenance (all-verticals amendment): every credit and compensating
 * debit also writes a plain-JSONB `metadata` payload — the sender/ACH
 * originator name, the Increase event category, the rail, the destination
 * account_number_id, and any payment identifiers present on the fetched
 * transfer (transfer id, trace numbers/UETR/IMAD, acceptance/confirmation
 * transaction ids, return/decline details). The column is additive and
 * user-run (the exact DDL is documented prominently in the PR body); when
 * it is not present yet (42703) a savepoint-scoped fallback records the
 * row WITHOUT metadata — money never blocks on provenance — after one
 * server-side warning. Both paths are tested. transaction_type stays open
 * TEXT by design: the vertical- and rail-agnostic guarantee — any
 * industry's inbound payment fits with zero schema change.
 *
 * Instant availability: universal_royalty_ledger has no stored balance —
 * the banking routes derive a holder's balance as the unfiltered
 * COALESCE(SUM(amount_cents), 0) over the holder's rows, so a credit
 * written here is spendable (Lithic card authorizations, RTP payouts) the
 * moment this route returns 200. No banking-side changes.
 *
 * Caller authentication: the HMAC signature IS the authentication.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getDb, type Db } from '@/lib/db';

export const dynamic = 'force-dynamic';

const SIGNATURE_FRESHNESS_SECONDS = 300;
const POSTGRES_UNIQUE_VIOLATION = '23505';
const POSTGRES_UNDEFINED_COLUMN = '42703';
const DIRECTION_CREDIT = 'credit';
const RETURN_TRANSACTION_TYPE = 'ROYALTY_INBOUND_RETURN';
const ACH_RETURN_REFERENCE_PREFIX = 'inbound_ach_transfer_return:';

/**
 * The inbound credit rails Increase emits, all pinned from the official
 * docs: the Account Numbers reference, each rail's object reference, and
 * the Event Subscriptions category enum. Adding a rail = one registry
 * entry; no schema change, no new endpoint.
 */
interface InboundRail {
  /** Event category stem, e.g. 'inbound_ach_transfer'. */
  readonly stem: string;
  /** GET resource base URL for the rail's objects. */
  readonly resourceUrl: string;
  /** transaction_type for credits on this rail (open TEXT ledger column). */
  readonly royaltyType: string;
  /** Terminal failure statuses that unwind a credit (compensating debit). */
  readonly failureStatuses: readonly string[];
  /** True only for ACH, whose object carries a `direction` field. */
  readonly requiresCreditDirection: boolean;
  /** The rail's sender/originator name field, for provenance. */
  readonly senderNameField: string;
}

const INBOUND_RAILS: readonly InboundRail[] = [
  {
    stem: 'inbound_ach_transfer',
    resourceUrl: 'https://api.increase.com/inbound_ach_transfers',
    royaltyType: 'ROYALTY_INBOUND_ACH',
    failureStatuses: ['returned', 'declined'],
    requiresCreditDirection: true,
    senderNameField: 'originator_company_name',
  },
  {
    stem: 'inbound_wire_transfer',
    resourceUrl: 'https://api.increase.com/inbound_wire_transfers',
    royaltyType: 'ROYALTY_INBOUND_WIRE',
    failureStatuses: ['reversed', 'declined'],
    requiresCreditDirection: false,
    senderNameField: 'debtor_name',
  },
  {
    stem: 'inbound_real_time_payments_transfer',
    resourceUrl: 'https://api.increase.com/inbound_real_time_payments_transfers',
    royaltyType: 'ROYALTY_INBOUND_RTP',
    failureStatuses: ['declined', 'timed_out'],
    requiresCreditDirection: false,
    senderNameField: 'debtor_name',
  },
  {
    stem: 'inbound_fednow_transfer',
    resourceUrl: 'https://api.increase.com/inbound_fednow_transfers',
    royaltyType: 'ROYALTY_INBOUND_FEDNOW',
    failureStatuses: ['declined', 'timed_out'],
    requiresCreditDirection: false,
    senderNameField: 'debtor_name',
  },
];

interface EventEnvelope {
  id?: unknown;
  category?: unknown;
  associated_object_type?: unknown;
  associated_object_id?: unknown;
}

/**
 * Inbound transfer object union across rails — the shared pinned fields
 * plus an open index over each rail's extras. Every field is `unknown` and
 * validated before use.
 */
interface InboundTransferObject {
  id?: unknown;
  account_number_id?: unknown;
  amount?: unknown;
  status?: unknown;
  direction?: unknown;
  [field: string]: unknown;
}

interface JsonbHolderRow {
  rights_holder_id: string;
}

type TxClient = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Internal abort: the delivery must be retried by Increase (mapped to a sanitized 503). */
class RetryableWebhookError extends Error {
  constructor() {
    super('webhook delivery must be retried');
    this.name = 'RetryableWebhookError';
  }
}

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: { 'cache-control': 'no-store' } });
}

function jsonOk(body: Record<string, unknown> = {}): Response {
  return Response.json({ ok: true, ...body }, { headers: { 'cache-control': 'no-store' } });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function optionalString(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

/** Postgres unique-violation probe (the ledger's UNIQUE reference_id). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === POSTGRES_UNIQUE_VIOLATION
  );
}

/** Postgres undefined-column probe (universal_royalty_ledger.metadata not yet added). */
function isUndefinedColumn(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === POSTGRES_UNDEFINED_COLUMN
  );
}

/** Standard Webhooks signing secret: "whsec_"-prefixed values are base64. */
function signingSecretBytes(configuredSecret: string): Buffer {
  if (configuredSecret.startsWith('whsec_')) {
    return Buffer.from(configuredSecret.slice('whsec_'.length), 'base64');
  }
  return Buffer.from(configuredSecret, 'utf8');
}

/**
 * Standard Webhooks verification: HMAC-SHA256 over
 * "<webhook-id>.<webhook-timestamp>.<raw-body>", base64-encoded, "v1,"-prefixed,
 * compared timing-safe against every space-separated signature candidate, with a
 * freshness window on the timestamp to blunt replays.
 */
function verifyStandardWebhookSignature(params: {
  rawBody: string;
  webhookId: string;
  webhookTimestamp: string;
  signatureHeader: string;
  configuredSecret: string;
}): boolean {
  const timestamp = Number.parseInt(params.webhookTimestamp, 10);
  if (!Number.isFinite(timestamp)) return false;
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (ageSeconds > SIGNATURE_FRESHNESS_SECONDS) return false;
  const expected =
    'v1,' +
    createHmac('sha256', signingSecretBytes(params.configuredSecret))
      .update(`${params.webhookId}.${params.webhookTimestamp}.${params.rawBody}`)
      .digest('base64');
  const expectedBuffer = Buffer.from(expected);
  for (const candidate of params.signatureHeader.split(' ')) {
    const candidateBuffer = Buffer.from(candidate);
    if (
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer)
    ) {
      return true;
    }
  }
  return false;
}

/** Fetches the authoritative inbound transfer object for an Event's object id. */
async function fetchInboundTransfer(
  resourceUrl: string,
  transferId: string,
  apiKey: string,
): Promise<InboundTransferObject | null> {
  let res: Response;
  try {
    res = await fetch(`${resourceUrl}/${encodeURIComponent(transferId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    console.error('Increase inbound transfer fetch failed:', error);
    return null;
  }
  if (!res.ok) {
    console.error('Increase inbound transfer fetch rejected:', res.status);
    return null;
  }
  try {
    return (await res.json()) as InboundTransferObject;
  } catch (error) {
    console.error('Increase inbound transfer response was not parseable JSON:', error);
    return null;
  }
}

/** The pinned shared fields needed to move ledger money, as exact BigInt cents. */
function transferCents(transfer: InboundTransferObject): bigint | null {
  const amount = transfer.amount;
  if (
    typeof amount !== 'number' ||
    !Number.isInteger(amount) ||
    amount <= 0 ||
    amount > Number.MAX_SAFE_INTEGER
  ) {
    return null;
  }
  return BigInt(amount);
}

/**
 * Resolves the destination Account Number to its rights holder under the
 * asset-row lock (the GIN index serves the JSONB element test) — the same
 * serialization point the banking routes use for the same holder.
 */
async function resolveHolderIdInTx(tx: TxClient, accountNumberId: string): Promise<string> {
  const res = await tx.query<JsonbHolderRow>(
    `SELECT rh->>'rightsHolderId' AS rights_holder_id
       FROM cbt_assets, jsonb_array_elements(rights_holders) AS rh
      WHERE rh->'payoutRouting'->'covenantVirtualAccount'->>'accountNumberId' = $1
      FOR UPDATE`,
    [accountNumberId],
  );
  if (!res.rows.length) {
    // Unmapped destination: retryable, never a silent 200.
    throw new RetryableWebhookError();
  }
  return res.rows[0].rights_holder_id;
}

interface LedgerInsert {
  rightsHolderId: string;
  amountCents: bigint;
  transactionType: string;
  referenceId: string;
  metadata: Record<string, unknown>;
}

/**
 * The provenance payload written alongside every royalty movement (plain
 * JSONB, no fixed key schema): the sender/ACH-originator name, the Increase
 * event category, the rail, the destination account number, and any
 * payment identifiers present on the fetched transfer.
 */
function provenanceMetadata(
  category: string,
  rail: InboundRail,
  transfer: InboundTransferObject,
  accountNumberId: string,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    increaseEventCategory: category,
    inboundRail: rail.royaltyType,
    destinationAccountNumberId: accountNumberId,
    inboundTransferId: optionalString(transfer.id),
    senderName: optionalString(transfer[rail.senderNameField]),
  };
  switch (rail.stem) {
    case 'inbound_ach_transfer': {
      if (isNonEmptyString(transfer.originator_company_id)) {
        metadata.originatorCompanyId = transfer.originator_company_id;
      }
      if (isNonEmptyString(transfer.trace_number)) {
        metadata.achTraceNumber = transfer.trace_number;
      }
      const acceptance = subObject(transfer.acceptance);
      if (acceptance && isNonEmptyString(acceptance.transaction_id)) {
        metadata.acceptedTransactionId = acceptance.transaction_id;
      }
      const transferReturn = subObject(transfer.transfer_return);
      if (transferReturn && isNonEmptyString(transferReturn.transaction_id)) {
        metadata.returnTransactionId = transferReturn.transaction_id;
      }
      if (transferReturn && isNonEmptyString(transferReturn.reason)) {
        metadata.returnReason = transferReturn.reason;
      }
      const decline = subObject(transfer.decline);
      if (decline && isNonEmptyString(decline.reason)) {
        metadata.declineReason = decline.reason;
      }
      if (decline && isNonEmptyString(decline.declined_transaction_id)) {
        metadata.declinedTransactionId = decline.declined_transaction_id;
      }
      break;
    }
    case 'inbound_wire_transfer': {
      if (isNonEmptyString(transfer.creditor_name)) {
        metadata.creditorName = transfer.creditor_name;
      }
      if (isNonEmptyString(transfer.debtor_account_number)) {
        metadata.senderAccountNumber = transfer.debtor_account_number;
      }
      if (isNonEmptyString(transfer.debtor_routing_number)) {
        metadata.senderRoutingNumber = transfer.debtor_routing_number;
      }
      if (isNonEmptyString(transfer.end_to_end_identification)) {
        metadata.endToEndIdentification = transfer.end_to_end_identification;
      }
      if (isNonEmptyString(transfer.unique_end_to_end_transaction_reference)) {
        metadata.uetr = transfer.unique_end_to_end_transaction_reference;
      }
      if (isNonEmptyString(transfer.input_message_accountability_data)) {
        metadata.imad = transfer.input_message_accountability_data;
      }
      if (isNonEmptyString(transfer.instruction_identification)) {
        metadata.instructionIdentification = transfer.instruction_identification;
      }
      if (isNonEmptyString(transfer.unstructured_remittance_information)) {
        metadata.remittanceInformation = transfer.unstructured_remittance_information;
      }
      const acceptance = subObject(transfer.acceptance);
      if (acceptance && isNonEmptyString(acceptance.transaction_id)) {
        metadata.acceptedTransactionId = acceptance.transaction_id;
      }
      const reversal = subObject(transfer.reversal);
      if (reversal && isNonEmptyString(reversal.reason)) {
        metadata.reversalReason = reversal.reason;
      }
      if (reversal && isNonEmptyString(reversal.reversed_at)) {
        metadata.reversedAt = reversal.reversed_at;
      }
      break;
    }
    case 'inbound_real_time_payments_transfer': {
      if (isNonEmptyString(transfer.debtor_account_number)) {
        metadata.senderAccountNumber = transfer.debtor_account_number;
      }
      if (isNonEmptyString(transfer.debtor_routing_number)) {
        metadata.senderRoutingNumber = transfer.debtor_routing_number;
      }
      if (isNonEmptyString(transfer.transaction_identification)) {
        metadata.networkTransactionIdentification = transfer.transaction_identification;
      }
      if (isNonEmptyString(transfer.unstructured_remittance_information)) {
        metadata.remittanceInformation = transfer.unstructured_remittance_information;
      }
      const confirmation = subObject(transfer.confirmation);
      if (confirmation && isNonEmptyString(confirmation.transaction_id)) {
        metadata.confirmedTransactionId = confirmation.transaction_id;
      }
      const decline = subObject(transfer.decline);
      if (decline && isNonEmptyString(decline.reason)) {
        metadata.declineReason = decline.reason;
      }
      if (decline && isNonEmptyString(decline.declined_transaction_id)) {
        metadata.declinedTransactionId = decline.declined_transaction_id;
      }
      break;
    }
    case 'inbound_fednow_transfer': {
      if (isNonEmptyString(transfer.debtor_account_number)) {
        metadata.senderAccountNumber = transfer.debtor_account_number;
      }
      if (isNonEmptyString(transfer.debtor_routing_number)) {
        metadata.senderRoutingNumber = transfer.debtor_routing_number;
      }
      if (isNonEmptyString(transfer.unique_end_to_end_transaction_reference)) {
        metadata.uetr = transfer.unique_end_to_end_transaction_reference;
      }
      if (isNonEmptyString(transfer.unstructured_remittance_information)) {
        metadata.remittanceInformation = transfer.unstructured_remittance_information;
      }
      if (isNonEmptyString(transfer.transaction_id)) {
        metadata.confirmedTransactionId = transfer.transaction_id;
      }
      const confirmation = subObject(transfer.confirmation);
      if (confirmation && isNonEmptyString(confirmation.transfer_id)) {
        metadata.confirmationTransferId = confirmation.transfer_id;
      }
      const decline = subObject(transfer.decline);
      if (decline && isNonEmptyString(decline.reason)) {
        metadata.declineReason = decline.reason;
      }
      if (decline && isNonEmptyString(decline.transfer_id)) {
        metadata.declinedTransferId = decline.transfer_id;
      }
      break;
    }
  }
  return metadata;
}

/** A validated sub-object of a transfer, or null. */
function subObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

const LEDGER_INSERT_SQL =
  'INSERT INTO universal_royalty_ledger (rights_holder_id, amount_cents, transaction_type, reference_id, created_at, metadata) VALUES ($1, $2, $3, $4, NOW(), $5::jsonb)';
const LEDGER_INSERT_WITHOUT_METADATA_SQL =
  'INSERT INTO universal_royalty_ledger (rights_holder_id, amount_cents, transaction_type, reference_id, created_at) VALUES ($1, $2, $3, $4, NOW())';

/**
 * Records the royalty movement with provenance. transaction_type is open
 * TEXT by design — the vertical- and rail-agnostic guarantee: any
 * industry's inbound payment on any rail fits with zero schema change.
 *
 * A 42703 (the additive metadata column has not been added yet) retries
 * the row WITHOUT metadata so money never blocks on provenance. The retry
 * is savepoint-scoped on purpose: a failed statement aborts a PostgreSQL
 * transaction (25P02), so only ROLLBACK TO SAVEPOINT keeps the fallback
 * runnable inside the same atomic credit/debit transaction. 23505 replays
 * and every other failure propagate to the transaction boundary,
 * preserving the replay semantics.
 */
async function insertLedgerRowInTx(tx: TxClient, params: LedgerInsert): Promise<void> {
  await tx.query('SAVEPOINT covenant_royalty_ledger_insert');
  try {
    await tx.query(LEDGER_INSERT_SQL, [
      params.rightsHolderId,
      params.amountCents.toString(),
      params.transactionType,
      params.referenceId,
      JSON.stringify(params.metadata),
    ]);
  } catch (error) {
    if (!isUndefinedColumn(error)) {
      throw error;
    }
    await tx.query('ROLLBACK TO SAVEPOINT covenant_royalty_ledger_insert');
    console.warn(
      "universal_royalty_ledger.metadata is missing — the row is recorded WITHOUT provenance. Required-for-provenance DDL: ALTER TABLE universal_royalty_ledger ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;",
    );
    await tx.query(LEDGER_INSERT_WITHOUT_METADATA_SQL, [
      params.rightsHolderId,
      params.amountCents.toString(),
      params.transactionType,
      params.referenceId,
    ]);
  }
  await tx.query('RELEASE SAVEPOINT covenant_royalty_ledger_insert');
}

/**
 * The UNIQUE-guarded reference_id for a compensating debit: namespaced by
 * rail + failure status, keyed by the strongest identifier the rail's
 * failure object carries (the ACH return's own transaction id; otherwise
 * the transfer id — a terminal failure happens at most once per transfer).
 */
function failureReference(
  rail: InboundRail,
  status: string,
  transfer: InboundTransferObject,
): string | null {
  if (rail.stem === 'inbound_ach_transfer' && status === 'returned') {
    const transferReturn = subObject(transfer.transfer_return);
    const returnTransactionId = transferReturn?.transaction_id;
    if (!isNonEmptyString(returnTransactionId)) return null;
    return `${ACH_RETURN_REFERENCE_PREFIX}${returnTransactionId}`;
  }
  return `${rail.stem}_${status}:${String(transfer.id)}`;
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const webhookId = request.headers.get('webhook-id');
  const webhookTimestamp = request.headers.get('webhook-timestamp');
  const signatureHeader = request.headers.get('webhook-signature');
  const configuredSecret = process.env.INCREASE_WEBHOOK_SECRET;

  // Fail closed on ANY missing signature material: 4xx, never processed,
  // never a 5xx.
  if (!configuredSecret || !webhookId || !webhookTimestamp || !signatureHeader) {
    return jsonError('Unauthorized: webhook signature missing', 401);
  }
  if (
    !verifyStandardWebhookSignature({
      rawBody,
      webhookId,
      webhookTimestamp,
      signatureHeader,
      configuredSecret,
    })
  ) {
    return jsonError('Invalid webhook signature', 403);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Signed but unparseable: reject the delivery (Increase retries, then
    // drops it) — never guess at money movement.
    return jsonError('Webhook body must be a JSON Event object.', 400);
  }
  const event = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as EventEnvelope;
  const category = event.category;
  const associatedObjectId = event.associated_object_id;

  // Rail routing: "<stem>.created" | "<stem>.updated" for every inbound
  // credit rail; anything else is a graceful 200 no-op.
  if (!isNonEmptyString(category)) {
    return jsonOk({ ignored: true });
  }
  const separatorIndex = category.lastIndexOf('.');
  const stem = separatorIndex > 0 ? category.slice(0, separatorIndex) : '';
  const phase = separatorIndex > 0 ? category.slice(separatorIndex + 1) : '';
  const rail = INBOUND_RAILS.find((candidate) => candidate.stem === stem);
  if (!rail || (phase !== 'created' && phase !== 'updated')) {
    return jsonOk({ ignored: true });
  }
  if (!isNonEmptyString(associatedObjectId)) {
    console.error(
      'Increase webhook event is missing associated_object_id:',
      isNonEmptyString(event.id) ? event.id : 'unknown-event-id',
    );
    return jsonError('Event is missing the associated object id.', 400);
  }

  const apiKey = process.env.INCREASE_API_KEY;
  if (!apiKey) {
    console.error('Increase webhook: INCREASE_API_KEY is not configured; the transfer cannot be resolved.');
    return jsonError('Increase is not configured.', 503);
  }
  const transfer = await fetchInboundTransfer(rail.resourceUrl, associatedObjectId, apiKey);
  if (!transfer) {
    return jsonError('Increase transfer could not be resolved; retry pending.', 503);
  }
  if (!isNonEmptyString(transfer.id) || !isNonEmptyString(transfer.account_number_id)) {
    console.error('Increase inbound transfer is missing pinned fields (id/account_number_id).');
    return jsonError('Increase transfer payload is incomplete; retry pending.', 503);
  }
  const amountCents = transferCents(transfer);
  if (amountCents === null) {
    console.error('Increase inbound transfer amount is not a positive integer cents value.');
    return jsonError('Increase transfer amount is unprocessable; retry pending.', 503);
  }
  const accountNumberId = transfer.account_number_id;
  const transferId = transfer.id;

  const db = getDb();
  if (!db) {
    console.error('Increase webhook: DATABASE_URL is not configured; retry pending.');
    return jsonError('Database is not configured.', 503);
  }

  try {
    if (phase === 'created') {
      if (rail.requiresCreditDirection && transfer.direction !== DIRECTION_CREDIT) {
        // Royalty numbers are credit-only (debit_status "blocked" at
        // provisioning); an unexpected direction stays on Increase's retry
        // radar for reconciliation instead of moving ledger money.
        console.error('Increase webhook: unexpected inbound transfer direction:', transfer.direction);
        return jsonError('Unexpected transfer direction; retry pending.', 503);
      }
      if (
        typeof transfer.status === 'string' &&
        rail.failureStatuses.includes(transfer.status)
      ) {
        // The documented lifecycles deliver created as pending*; a created
        // event already in a terminal failure never had money in flight to
        // credit. The failure's own .updated event records the movement.
        console.error('Increase webhook: created event for an already-failed transfer:', category);
        return jsonOk({ ignored: true });
      }
      await db.transaction(async (tx) => {
        const rightsHolderId = await resolveHolderIdInTx(tx, accountNumberId);
        await insertLedgerRowInTx(tx, {
          rightsHolderId,
          amountCents,
          transactionType: rail.royaltyType,
          referenceId: transferId,
          metadata: provenanceMetadata(category, rail, transfer, accountNumberId),
        });
      });
      return jsonOk();
    }

    // .updated: act only on the rail's terminal failure statuses; every
    // other transition is a balance-neutral no-op.
    const status = typeof transfer.status === 'string' ? transfer.status : '';
    if (!rail.failureStatuses.includes(status)) {
      return jsonOk({ ignored: true });
    }
    const referenceId = failureReference(rail, status, transfer);
    if (referenceId === null) {
      console.error('Increase failed transfer is missing its pinned failure identifier:', category);
      return jsonError('Failure details are incomplete; retry pending.', 503);
    }
    await db.transaction(async (tx) => {
      const rightsHolderId = await resolveHolderIdInTx(tx, accountNumberId);
      await insertLedgerRowInTx(tx, {
        rightsHolderId,
        amountCents: -amountCents,
        transactionType: RETURN_TRANSACTION_TYPE,
        referenceId,
        metadata: provenanceMetadata(category, rail, transfer, accountNumberId),
      });
    });
    return jsonOk();
  } catch (error) {
    if (isUniqueViolation(error)) {
      // UNIQUE (reference_id) rejected the row: the exact event was already
      // recorded — a webhook replay. 200 without a second movement.
      return jsonOk({ deduplicated: true });
    }
    if (error instanceof RetryableWebhookError) {
      return jsonError('Destination account is not mapped to a rights holder; retry pending.', 503);
    }
    console.error('Increase webhook processing failed:', error);
    return jsonError('Webhook processing failed; retry pending.', 503);
  }
}
