/**
 * POST /api/covnant/recon/jobs/callback — the completion webhook's UCT
 * target (spec art_7M0snhxc, verification row 7).
 *
 * Mirrors the DSP webhook's signature-gate contract tests: unsigned → 401,
 * unset RECON_CALLBACK_SECRET → 401 fail-closed (signature_not_configured),
 * wrong signature → 403; a correctly signed completion applies the worker's
 * result summary to an active job, a signed notification about an already
 * terminal row is a {replay:true} no-op, and garbage JSON → 400. The store
 * is the repo's InMemoryStore injection pattern (setStore); rejection cases
 * run with NO store injected, proving the gate fires before any store read.
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '../route';
import { setStore } from '@/lib/server/store';
import { InMemoryStore } from '@/lib/server/inMemoryStore';

const SECRET_RAW = 'test-recon-callback-secret';
const SECRET_WHSEC = `whsec_${Buffer.from(SECRET_RAW).toString('base64')}`;
const SECRET_RAW_BYTES = Buffer.from(SECRET_RAW, 'utf8');
const JOB_ID = '9f3a7c21-4444-4444-8444-444444444444';

function callbackPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: JOB_ID,
    status: 'completed',
    error: null,
    result: { events_written: 42, matched: 40, unmatched: 2, engine_used: null },
    ...overrides,
  };
}

function signedHeaders(
  rawBody: string,
  secret: Buffer = SECRET_RAW_BYTES,
  timestamp = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const signature = `v1,${createHmac('sha256', secret)
    .update(`${JOB_ID}.${timestamp}.${rawBody}`)
    .digest('base64')}`;
  return {
    'webhook-id': JOB_ID,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': signature,
  };
}

function callbackRequest(rawBody: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/covnant/recon/jobs/callback', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

function signedRequest(payload: unknown): Request {
  const rawBody = JSON.stringify(payload);
  return callbackRequest(rawBody, signedHeaders(rawBody));
}

beforeEach(() => {
  vi.stubEnv('RECON_CALLBACK_SECRET', SECRET_WHSEC);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setStore(null);
});

describe('POST /api/covnant/recon/jobs/callback — signature gate', () => {
  it('rejects an unsigned body with 401 before any store read', async () => {
    const res = await POST(
      callbackRequest(JSON.stringify(callbackPayload())) as never,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body.code).toBe('signature_missing');
  });

  it('fails closed with 401 when RECON_CALLBACK_SECRET is unset', async () => {
    vi.stubEnv('RECON_CALLBACK_SECRET', '');
    const rawBody = JSON.stringify(callbackPayload());
    const res = await POST(callbackRequest(rawBody, signedHeaders(rawBody)) as never);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('signature_not_configured');
    expect(body.error).toContain('RECON_CALLBACK_SECRET');
  });

  it('rejects a wrong signature with 403', async () => {
    const rawBody = JSON.stringify(callbackPayload());
    const headers = signedHeaders(rawBody, Buffer.from('wrong secret', 'utf8'));
    const res = await POST(callbackRequest(rawBody, headers) as never);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body.code).toBe('signature_invalid');
  });

  it('rejects a stale timestamp with 403', async () => {
    const rawBody = JSON.stringify(callbackPayload());
    const stale = Math.floor(Date.now() / 1000) - 60 * 60; // one hour old
    const headers = signedHeaders(rawBody, SECRET_RAW_BYTES, stale);
    const res = await POST(callbackRequest(rawBody, headers) as never);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/covnant/recon/jobs/callback — payload validation', () => {
  it('rejects malformed JSON with 400 after the signature passes', async () => {
    const rawBody = '{not json';
    const res = await POST(callbackRequest(rawBody, signedHeaders(rawBody)) as never);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body.code).toBe('malformed_body');
  });

  it('rejects an unknown status with 422', async () => {
    const res = await POST(signedRequest(callbackPayload({ status: 'cancelled' })) as never);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body.code).toBe('invalid_recon_callback');
  });

  it('rejects a completion without a result summary with 422 — never invents counts', async () => {
    // zod accepts a null result, so validation reaches the route's own
    // summary check — the job must EXIST and be active to get there
    // (existence is checked first), hence the injected store.
    const store = new InMemoryStore();
    const job = await store.createReconJob({ source: 'statement' });
    setStore(store);
    const res = await POST(
      signedRequest(callbackPayload({ job_id: job.id, result: null })) as never,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body.code).toBe('missing_recon_result');
  });
});

describe('POST /api/covnant/recon/jobs/callback — transitions and replays', () => {
  it('applies a completion to an active job and echoes the stored row', async () => {
    const store = new InMemoryStore();
    const job = await store.createReconJob({ source: 'statement' });
    setStore(store);
    const res = await POST(signedRequest(callbackPayload({ job_id: job.id })) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      replay: boolean;
      job: { id: string; status: string } | null;
    };
    expect(body.ok).toBe(true);
    expect(body.replay).toBe(false);
    expect(body.job?.status).toBe('completed');
    const stored = await store.getReconJob(job.id);
    expect(stored?.result).toEqual({ events_written: 42, matched: 40, unmatched: 2, engine_used: null });
    expect(stored?.completed_at).not.toBeNull();
  });

  it('no-ops a replay against an already terminal row', async () => {
    const store = new InMemoryStore();
    const job = await store.createReconJob({ source: 'statement' });
    setStore(store);
    // First signed completion lands the row at completed.
    await POST(signedRequest(callbackPayload({ job_id: job.id })) as never);
    // A second identical notification (the trigger firing again, a retry)
    // is a no-op — the stored result is never re-applied or disturbed.
    const res = await POST(signedRequest(callbackPayload({ job_id: job.id })) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; replay: boolean };
    expect(body.replay).toBe(true);
    const stored = await store.getReconJob(job.id);
    expect(stored?.result?.events_written).toBe(42);
  });

  it('returns the failed job to the pool under the retry budget', async () => {
    const store = new InMemoryStore();
    const job = await store.createReconJob({ source: 'statement' });
    setStore(store);
    const res = await POST(
      signedRequest(
        callbackPayload({ job_id: job.id, status: 'failed', error: 'source feed returned HTML', result: null }),
      ) as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; replay: boolean; job: { status: string } | null };
    expect(body.job?.status).toBe('pending'); // re-claimable — attempts still under 3
    const stored = await store.getReconJob(job.id);
    expect(stored?.error).toBe('source feed returned HTML');
  });
});
