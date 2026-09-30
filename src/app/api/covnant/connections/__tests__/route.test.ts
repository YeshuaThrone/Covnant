/**
 * /api/covnant/connections — the UCT vault's route battery (PR 5).
 *
 * Covers:
 *   - auth: sessionless → 401 no_session, unenrolled → 403 not_registered
 *     (the holder id is the VERIFIED session's payee key, never a client
 *     field);
 *   - validation: unknown distributor / missing credential / oversized
 *     field → 422 invalid_connection;
 *   - rate limit: the shared limiter's 30-per-minute budget — request 31
 *     is rejected with 429;
 *   - THE SECRECY CONTRACT: a 201 response carries neither the plaintext
 *     credentials NOR the ciphertext (toConnectionStatus is the only
 *     serializer), while the stored row decrypts back to exactly what the
 *     holder submitted — round-trip through the whole stack;
 *   - reconnect: a second POST for the same distributor returns 200 and
 *     rotates the row (still one active row);
 *   - NO PLAINTEXT IN LOGS: across happy and error paths, nothing the
 *     route logs (console.*) ever contains the submitted credentials —
 *     the required assertion this PR ships with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/sessionCreator', () => ({ resolveSessionCreator: vi.fn() }));

import { resolveSessionCreator } from '@/lib/server/sessionCreator';
import { resetRateLimits } from '@/lib/server/rateLimit';
import { setStore } from '@/lib/server/store';
import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { decryptCredential } from '@/modules/vault/crypto';
import { POST, GET } from '../route';

const mockSession = vi.mocked(resolveSessionCreator);

const REGISTERED = {
  kind: 'registered' as const,
  creator: {
    payee_id: '9f3a7c21-1111-4111-8111-111111111111',
    stage_name: 'Aurora Sky',
  },
};

const USERNAME = 'artist@distrokid.com';
const PASSWORD = 'correct horse battery staple — ünïcode!';

function connectionsRequest(
  method: 'POST' | 'GET',
  body?: unknown,
  forwardedFor = '203.0.113.7',
): Request {
  return new Request('http://localhost/api/covnant/connections', {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': forwardedFor,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function connectBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { distributor: 'distrokid', username: USERNAME, password: PASSWORD, ...overrides };
}

let store: InMemoryStore;
let consoleSpies: Array<{ name: string; spy: ReturnType<typeof vi.spyOn> }>;

beforeEach(() => {
  resetRateLimits();
  store = new InMemoryStore();
  setStore(store);
  mockSession.mockResolvedValue(REGISTERED as never);
  consoleSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((name) => ({
    name,
    spy: vi.spyOn(console, name).mockImplementation(() => {}),
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  resetRateLimits();
  setStore(null);
});

function assertNoCredentialInLogs(): void {
  for (const { name, spy } of consoleSpies) {
    for (const call of spy.mock.calls) {
      const logged = call.map((arg) => String(arg)).join(' ');
      expect(logged, `console.${name} logged credential material`).not.toContain(USERNAME);
      expect(logged, `console.${name} logged credential material`).not.toContain(PASSWORD);
    }
  }
}

describe('POST /api/covnant/connections — auth battery', () => {
  it('rejects a sessionless caller with 401 no_session', async () => {
    mockSession.mockResolvedValue({ kind: 'anonymous' } as never);
    const response = await POST(connectionsRequest('POST', connectBody()) as never);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('no_session');
  });

  it('rejects a signed-in but unenrolled session with 403 not_registered', async () => {
    mockSession.mockResolvedValue({ kind: 'unregistered' } as never);
    const response = await POST(connectionsRequest('POST', connectBody()) as never);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('not_registered');
  });
});

describe('POST /api/covnant/connections — validation and rate limits', () => {
  it('rejects an unknown distributor with 422 invalid_connection', async () => {
    const response = await POST(
      connectionsRequest('POST', connectBody({ distributor: 'spotify' })) as never,
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('invalid_connection');
  });

  it('rejects a missing password with 422', async () => {
    const response = await POST(
      connectionsRequest('POST', { distributor: 'distrokid', username: USERNAME }) as never,
    );
    expect(response.status).toBe(422);
  });

  it('rejects an oversized credential field with 422', async () => {
    const response = await POST(
      connectionsRequest('POST', connectBody({ username: 'x'.repeat(256) })) as never,
    );
    expect(response.status).toBe(422);
  });

  it('rejects a malformed body with 422', async () => {
    const response = await POST(connectionsRequest('POST', 'not-json-at-all') as never);
    expect(response.status).toBe(422);
  });

  it('rejects request 31 with 429 — the shared per-minute budget', async () => {
    for (let i = 0; i < 30; i++) {
      const response = await POST(connectionsRequest('POST', connectBody()) as never);
      expect([200, 201]).toContain(response.status);
    }
    const overflow = await POST(connectionsRequest('POST', connectBody()) as never);
    expect(overflow.status).toBe(429);
    const body = (await overflow.json()) as { code: string };
    expect(body.code).toBe('rate_limited');
  });
});

describe('POST /api/covnant/connections — the secrecy contract', () => {
  it('returns 201 with the credential-free status ONLY — no plaintext, no ciphertext', async () => {
    const response = await POST(connectionsRequest('POST', connectBody()) as never);
    expect(response.status).toBe(201);
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain(USERNAME);
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain('enc:v1'); // not even the ciphertext leaves
    expect(raw).not.toContain('username_encrypted');
    expect(raw).not.toContain('password_encrypted');
  });

  it('stores the credentials encrypted — the row decrypts to the submitted values', async () => {
    await POST(connectionsRequest('POST', connectBody()) as never);
    const rows = await store.listDistributorConnections(REGISTERED.creator.payee_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.username_encrypted).not.toBe(USERNAME);
    expect(rows[0]?.password_encrypted).not.toBe(PASSWORD);
    expect(rows[0]?.username_encrypted.startsWith('enc:v1:')).toBe(true);
    expect(decryptCredential(rows[0]!.username_encrypted)).toBe(USERNAME);
    expect(decryptCredential(rows[0]!.password_encrypted)).toBe(PASSWORD);
  });

  it('scopes the row to the verified session — a client-supplied holder_id is ignored', async () => {
    await POST(
      connectionsRequest('POST', connectBody({ holder_id: 'forged-holder-id' })) as never,
    );
    const rows = await store.listDistributorConnections(REGISTERED.creator.payee_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.holder_id).toBe(REGISTERED.creator.payee_id);
  });

  it('rotates on reconnect: 200 with one active row and fresh ciphertexts', async () => {
    const first = await POST(connectionsRequest('POST', connectBody()) as never);
    expect(first.status).toBe(201);
    const second = await POST(connectionsRequest('POST', connectBody()) as never);
    expect(second.status).toBe(200);
    const rows = await store.listDistributorConnections(REGISTERED.creator.payee_id);
    expect(rows).toHaveLength(1);
    expect(decryptCredential(rows[0]!.password_encrypted)).toBe(PASSWORD);
  });

  it('never logs the credentials across happy and error paths', async () => {
    await POST(connectionsRequest('POST', connectBody()) as never);
    await POST(connectionsRequest('POST', connectBody({ distributor: 'spotify' })) as never);
    await POST(connectionsRequest('POST', 'not-json-at-all') as never);
    await POST(connectionsRequest('POST', connectBody()) as never); // after the 422
    await GET(connectionsRequest('GET') as never);
    assertNoCredentialInLogs();
  });
});

describe('GET /api/covnant/connections — the status read', () => {
  it('returns the credential-free statuses, newest first', async () => {
    await POST(connectionsRequest('POST', connectBody({ distributor: 'distrokid' })) as never);
    await POST(connectionsRequest('POST', connectBody({ distributor: 'ascap' })) as never);
    const response = await GET(connectionsRequest('GET') as never);
    expect(response.status).toBe(200);
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain(USERNAME);
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain('enc:v1');
    const body = JSON.parse(raw) as {
      connections: Array<{ distributor: string; status: string }>;
    };
    expect(body.connections.map((c) => c.distributor)).toEqual(['ascap', 'distrokid']);
    expect(body.connections.every((c) => c.status === 'connected')).toBe(true);
  });

  it('rejects a sessionless caller with 401', async () => {
    mockSession.mockResolvedValue({ kind: 'anonymous' } as never);
    const response = await GET(connectionsRequest('GET') as never);
    expect(response.status).toBe(401);
  });
});
