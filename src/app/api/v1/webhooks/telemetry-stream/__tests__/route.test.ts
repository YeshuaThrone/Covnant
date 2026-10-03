/**
 * v21 telemetry webhook acceptance suite (founder canon, bound to the
 * PRODUCTION handler — the Next.js route POST). bullmq is mocked (the
 * 202 path must not touch a live Redis); HMAC signatures are computed
 * over JSON.stringify(payload), which is exactly the bytes a JSON POST
 * transmits — matching the raw-body verification.
 */

import crypto from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queueState = vi.hoisted(() => ({
  addCalls: [] as Array<{
    name: string;
    data: unknown;
    options: unknown;
  }>,
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn(() => ({
    add: vi.fn(async (name: string, data: unknown, options: unknown) => {
      queueState.addCalls.push({ name, data, options });
      return { id: 'job-1' };
    }),
  })),
}));

import { POST } from '../route';

const WEBHOOK_SECRET = 'secure_webhook_hmac_secret_2026';

const validPayload = {
  providerId: 'statsperform',
  records: [
    {
      entityId: 'a1b2c3d4-e5f6-4a1b-8c9d-0123456789ab',
      verticalCategory: 'PRO_SPORTS',
      primaryCodeType: 'FIFA_CONNECT_ID',
      primaryCodeValue: '190ABC999999',
    },
  ],
};

const generateSignature = (payload: string, secret: string): string =>
  `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;

const postWebhook = async (
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return POST(
    new Request('http://localhost:3000/api/v1/webhooks/telemetry-stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw,
    }),
  );
};

const postSigned = async (
  body: unknown,
  secret: string = WEBHOOK_SECRET,
): Promise<Response> => {
  const raw = JSON.stringify(body);
  return postWebhook(raw, {
    'x-hub-signature-256': generateSignature(raw, secret),
  });
};

beforeEach(() => {
  queueState.addCalls.length = 0;
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('WEBHOOK_SECRET', WEBHOOK_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('HMAC verification (v20, raw-body)', () => {
  it('returns 401 with the founder body when the signature header is missing', async () => {
    const res = await postWebhook(validPayload);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: 'Missing webhook signature header.',
    });
  });

  it('returns 403 with the founder body on a wrong signature', async () => {
    const res = await postSigned(validPayload, 'some-other-secret');
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'Invalid webhook signature.',
    });
  });

  it('returns 403 on a tampered body (signature over different bytes)', async () => {
    const res = await postWebhook(validPayload, {
      'x-hub-signature-256': generateSignature(
        JSON.stringify({ ...validPayload, providerId: 'attacker' }),
        WEBHOOK_SECRET,
      ),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 (not 500) on a digest-length-mismatch signature (length guard)', async () => {
    const res = await postWebhook(validPayload, {
      'x-hub-signature-256': 'sha256=short',
    });
    expect(res.status).toBe(403);
  });

  it('fails closed in production when WEBHOOK_SECRET is unset', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('WEBHOOK_SECRET', ''); // empty = unset for the fail-closed check
    const res = await postWebhook(validPayload, {
      'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
    });
    expect(res.status).toBe(403);
  });

  it('verifies against the DEV-ONLY canon default when no env secret is set', async () => {
    vi.stubEnv('WEBHOOK_SECRET', '');
    const res = await postSigned(validPayload);
    expect(res.status).toBe(202);
  });
});

describe('payload validation (v20 contract)', () => {
  it('returns 400 with the founder body on a missing providerId', async () => {
    const res = await postSigned({ records: validPayload.records });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Malformed telemetry payload structure.',
    });
  });

  it('returns 400 on a non-array records field', async () => {
    const res = await postSigned({
      providerId: 'statsperform',
      records: 'nope',
    });
    expect(res.status).toBe(400);
  });

  it('returns 422 REJECTED with index-tagged errors on an invalid PRIMARY code', async () => {
    const res = await postSigned({
      providerId: 'statsperform',
      records: [
        validPayload.records[0],
        {
          ...validPayload.records[0],
          primaryCodeValue: 'INVALID',
        },
      ],
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      status: string;
      errors: Array<{ index: number; reason: string }>;
    };
    expect(body.status).toBe('REJECTED');
    expect(body.errors[0]!.index).toBe(1);
    expect(body.errors[0]!.reason).toContain('FIFA_CONNECT_ID');
  });

  it('collects an unknown type throw as a 422 validation failure, never a 500', async () => {
    const res = await postSigned({
      providerId: 'statsperform',
      records: [
        {
          ...validPayload.records[0],
          primaryCodeType: 'NOT_A_REAL_TYPE',
        },
      ],
    });
    expect(res.status).toBe(422);
  });
});

describe('async offload (v20 BullMQ contract)', () => {
  it('accepts a signed valid batch with the canonical 202 shape and enqueues attempts 3 / exponential 1000', async () => {
    const res = await postSigned(validPayload);
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({
      status: 'ACCEPTED',
      queuedRecords: 1,
      message: 'Payload successfully queued for asynchronous processing.',
    });
    expect(queueState.addCalls).toHaveLength(1);
    const add = queueState.addCalls[0]!;
    expect(add.name).toBe('process-telemetry-batch');
    expect(add.options).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    });
  });
});
