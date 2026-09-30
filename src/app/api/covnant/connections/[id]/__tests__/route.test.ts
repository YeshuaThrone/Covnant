/**
 * DELETE /api/covnant/connections/:id — the vault's disconnect battery
 * (PR 5). Covers:
 *
 *   - auth: sessionless → 401, unenrolled → 403;
 *   - the no-enumeration rule: an UNKNOWN id and a FOREIGN holder's id
 *     return the SAME 404 body — neither confirms existence;
 *   - the holder's own disconnect: 200 with the credential-free status,
 *     row flipped to 'disconnected' in the store, ciphertexts kept;
 *   - replay: a second DELETE still 200s with the same shape;
 *   - NO PLAINTEXT IN LOGS across all of the above.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/sessionCreator', () => ({ resolveSessionCreator: vi.fn() }));

import { resolveSessionCreator } from '@/lib/server/sessionCreator';
import { resetRateLimits } from '@/lib/server/rateLimit';
import { setStore } from '@/lib/server/store';
import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { DELETE } from '../route';

const mockSession = vi.mocked(resolveSessionCreator);

const REGISTERED = {
  kind: 'registered' as const,
  creator: {
    payee_id: '9f3a7c21-1111-4111-8111-111111111111',
    stage_name: 'Aurora Sky',
  },
};

const OTHER_HOLDER = 'eeeeeeee-4444-4444-8444-444444444444';

const USERNAME = 'artist@distrokid.com';
const PASSWORD = 'correct horse battery staple — ünïcode!';

let store: InMemoryStore;
let consoleSpies: Array<{ name: string; spy: ReturnType<typeof vi.spyOn> }>;

function deleteRequest(id: string, forwardedFor = '203.0.113.7'): Request {
  return new Request(`http://localhost/api/covnant/connections/${id}`, {
    method: 'DELETE',
    headers: { 'x-forwarded-for': forwardedFor },
  });
}

async function deleteConnection(id: string): Promise<Response> {
  return DELETE(deleteRequest(id) as never, {
    params: Promise.resolve({ id }),
  });
}

async function seedConnection(): Promise<string> {
  const seeded = await store.createDistributorConnection({
    holder_id: REGISTERED.creator.payee_id,
    distributor: 'distrokid',
    username_encrypted: 'enc:v1:seed-iv.tag.username',
    password_encrypted: 'enc:v1:seed-iv.tag.password',
  });
  return seeded.connection.id;
}

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

describe('DELETE /api/covnant/connections/:id — auth battery', () => {
  it('rejects a sessionless caller with 401 no_session', async () => {
    mockSession.mockResolvedValue({ kind: 'anonymous' } as never);
    const response = await deleteConnection('any-id');
    expect(response.status).toBe(401);
  });

  it('rejects an unenrolled session with 403 not_registered', async () => {
    mockSession.mockResolvedValue({ kind: 'unregistered' } as never);
    const response = await deleteConnection('any-id');
    expect(response.status).toBe(403);
  });
});

describe('DELETE /api/covnant/connections/:id — scoping and secrecy', () => {
  it('disconnects the holder\u2019s own row: 200, credential-free body, ciphertexts kept in the store', async () => {
    const id = await seedConnection();
    const response = await deleteConnection(id);
    expect(response.status).toBe(200);
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain(USERNAME);
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain('enc:v1');
    const rows = await store.listDistributorConnections(REGISTERED.creator.payee_id);
    expect(rows[0]?.status).toBe('disconnected');
    expect(rows[0]?.username_encrypted).toBe('enc:v1:seed-iv.tag.username');
  });

  it('returns the SAME 404 for an unknown id and a foreign holder\u2019s id', async () => {
    await seedConnection();
    const unknown = await deleteConnection('00000000-0000-4000-8000-000000000000');
    // Seed a foreign holder's row directly — the route must not find it.
    const foreign = await store.createDistributorConnection({
      holder_id: OTHER_HOLDER,
      distributor: 'distrokid',
      username_encrypted: 'enc:v1:foreign.tag.username',
      password_encrypted: 'enc:v1:foreign.tag.password',
    });
    const foreignResponse = await deleteConnection(foreign.connection.id);
    expect(unknown.status).toBe(404);
    expect(foreignResponse.status).toBe(404);
    expect(await unknown.json()).toEqual(await foreignResponse.json());
    // The foreign row is untouched.
    const stillThere = await store.getDistributorConnection(OTHER_HOLDER, foreign.connection.id);
    expect(stillThere?.status).toBe('connected');
  });

  it('replays idempotently — a second DELETE still 200s', async () => {
    const id = await seedConnection();
    await deleteConnection(id);
    const replay = await deleteConnection(id);
    expect(replay.status).toBe(200);
    const raw = JSON.stringify(await replay.json());
    expect(raw).not.toContain('enc:v1');
  });

  it('never logs credential material across all disconnect paths', async () => {
    const id = await seedConnection();
    await deleteConnection(id);
    await deleteConnection('00000000-0000-4000-8000-000000000000');
    await deleteConnection(id); // replay
    assertNoCredentialInLogs();
  });
});
