/**
 * POST /api/v1/webhooks/telemetry-stream — the high-throughput ASYNC variant
 * of the v13 batch-ingest (founder canon v20 Section 1). HMAC-verified
 * producers hand telemetry batches here; the route syntax-gates PRIMARY
 * codes in memory and enqueues to BullMQ, responding 202 immediately.
 *
 * Adaptations (v13/v20 precedent, flagged in the PR body):
 *   - Express → Next.js App Router POST handler, byte-compatible contract.
 *   - RAW-BODY HMAC: the signature verifies over the raw request body
 *     BEFORE parsing (the founder draft signed JSON.stringify(req.body) —
 *     not byte-stable across serializations; the repo's webhook HMAC
 *     pattern wins). The v21 founder suite remains compatible: it signs
 *     JSON.stringify(payload) and transmits exactly that bytes.
 *   - timingSafeEqual throws on length mismatch — a length guard precedes
 *     the compare so attacker-supplied short signatures get 403, not 500.
 *   - WEBHOOK_SECRET default 'secure_webhook_hmac_secret_2026' is DEV-ONLY
 *     canon (the v14 password precedent); production reads the env and
 *     FAILS CLOSED when unset (every request 403s).
 *   - The founder draft imports Worker but omits the consumer — the implied
 *     BullMQ Worker on this queue lives at src/workers/telemetry (the PR 2
 *     worker runtime model; Vercel serverless cannot host long-running
 *     workers). FLAGGED for founder confirmation.
 *   - Queue connection reconciled from REDIS_HOST/REDIS_PORT to the v16
 *     REDIS_URL convention (default redis://localhost:6379); the queue is
 *     created lazily on first use (house pool/client convention) so module
 *     import stays side-effect-free in CI and serverless cold starts.
 *   - GATE ASYMMETRY (carried, flagged): this inline gate validates PRIMARY
 *     codes only — the v13 sync path also validates every cross-reference
 *     inline. Cross-ref integrity is backstopped by the database trigger
 *     at the consumer's Phase-2 upsert (defense in depth holds). Founder
 *     to confirm inline parity.
 *   - validateIdentifier throws on unknown types — the gate collects the
 *     throw as that index's validation failure (the v13 convention) rather
 *     than letting it escape as a 500.
 */

import crypto from 'node:crypto';

import { Queue } from 'bullmq';
import { NextResponse } from 'next/server';

import {
  validateIdentifier,
  type IdentityIngestionPayload,
} from '@/lib/identifiers/globalIdentifiers';

export const dynamic = 'force-dynamic';

const QUEUE_NAME = 'telemetry-ingestion-queue';

export interface TelemetryStreamPayload {
  providerId: string;
  records: IdentityIngestionPayload[];
}

/** BullMQ connection from the v16 REDIS_URL convention (lazy, never at import). */
function queueConnection(): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  maxRetriesPerRequest: null;
} {
  const url = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    username: url.username || undefined,
    password: url.password || undefined,
    // BullMQ requirement — jobs must survive connection drops.
    maxRetriesPerRequest: null,
  };
}

let ingestionQueue: Queue | null = null;

function getIngestionQueue(): Queue {
  if (!ingestionQueue) {
    ingestionQueue = new Queue(QUEUE_NAME, { connection: queueConnection() });
  }
  return ingestionQueue;
}

/** Test-only: drop the cached queue so a later use rebuilds it. */
export function resetTelemetryIngestionQueue(): void {
  ingestionQueue = null;
}

/** DEV-ONLY fallback (canon v20, verbatim). Never used in production. */
const DEV_WEBHOOK_SECRET = 'secure_webhook_hmac_secret_2026';

/**
 * The signing secret for the current runtime — undefined in production
 * when WEBHOOK_SECRET is unset (the fail-closed trigger).
 */
function webhookSecret(): string | undefined {
  if (process.env.NODE_ENV === 'production' && !process.env.WEBHOOK_SECRET) {
    return undefined;
  }
  return process.env.WEBHOOK_SECRET || DEV_WEBHOOK_SECRET;
}

/** The founder 401 body — carried verbatim. */
export const MISSING_SIGNATURE_BODY = {
  error: 'Missing webhook signature header.',
} as const;

/** The founder 403 body — carried verbatim. */
export const INVALID_SIGNATURE_BODY = {
  error: 'Invalid webhook signature.',
} as const;

/**
 * HMAC SHA-256 verification over the RAW request body (see adaptation note).
 * Length-guarded timing-safe compare — returns false instead of throwing
 * when the provided signature is not a digest-length string.
 */
export function verifyTelemetrySignature(
  rawBody: string,
  providedSignature: string | null,
  secret: string,
): boolean {
  if (!providedSignature) return false;
  const hmac = crypto.createHmac('sha256', secret);
  const digest = `sha256=${hmac.update(rawBody).digest('hex')}`;
  const expected = Buffer.from(digest, 'utf8');
  const provided = Buffer.from(providedSignature, 'utf8');
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

/**
 * POST /api/v1/webhooks/telemetry-stream — receives high-frequency
 * telemetry & supply chain events.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const secret = webhookSecret();
  if (!secret) {
    // Fail closed: production without WEBHOOK_SECRET rejects everything
    // (founder-confirmation flag).
    console.error(
      '[identifier-engine] WEBHOOK_SECRET is unset in production — failing closed on all telemetry requests.',
    );
    return NextResponse.json(INVALID_SIGNATURE_BODY, { status: 403 });
  }

  // RAW-BODY HMAC: verify over the exact bytes on the wire, then parse.
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');
  if (!signature) {
    return NextResponse.json(MISSING_SIGNATURE_BODY, { status: 401 });
  }
  if (!verifyTelemetrySignature(rawBody, signature, secret)) {
    return NextResponse.json(INVALID_SIGNATURE_BODY, { status: 403 });
  }

  let payload: TelemetryStreamPayload;
  try {
    payload = JSON.parse(rawBody) as TelemetryStreamPayload;
  } catch {
    payload = {
      providerId: '',
      records: [],
    } as unknown as TelemetryStreamPayload;
  }
  const { providerId, records } = payload;
  if (!providerId || !Array.isArray(records)) {
    return NextResponse.json(
      { error: 'Malformed telemetry payload structure.' },
      { status: 400 },
    );
  }

  // Quick In-Memory Syntax Gate Pass (PRIMARY codes only — see gate asymmetry)
  const invalidEntries: Array<{ index: number; reason: string }> = [];
  records.forEach((record, index) => {
    try {
      if (!validateIdentifier(record.primaryCodeType, record.primaryCodeValue)) {
        invalidEntries.push({
          index,
          reason: `Failed validation for type ${record.primaryCodeType}`,
        });
      }
    } catch (err) {
      invalidEntries.push({
        index,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });
  if (invalidEntries.length > 0) {
    return NextResponse.json(
      { status: 'REJECTED', errors: invalidEntries },
      { status: 422 },
    );
  }

  // Offload to Async Background Worker Queue
  await getIngestionQueue().add(
    'process-telemetry-batch',
    {
      providerId,
      records,
      timestamp: new Date().toISOString(),
    },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    },
  );

  // Respond immediately for high-throughput concurrency (v20 canonical shape)
  return NextResponse.json(
    {
      status: 'ACCEPTED',
      queuedRecords: records.length,
      message: 'Payload successfully queued for asynchronous processing.',
    },
    { status: 202 },
  );
}
