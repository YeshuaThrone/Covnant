import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as listGET } from '../route';
import { GET as detailGET, PATCH } from '../[id]/route';
import { ADMIN_COOKIE_NAME, mintAdminSessionToken } from '@/lib/admin/gate';

/**
 * /api/admin/creators contract tests — the first creator_profiles mutation.
 *
 * The gate boundary is REAL (the minted cookie verifies through the
 * production gate) and the service-role factory is mocked; the fake client
 * records every profile update and action-log insert so the tests pin the
 * mutation discipline: enum/whitelist rejection with NOTHING half-written,
 * exactly ONE admin_action_log row per effective mutation with field-level
 * before/after, no log for a no-op patch, and best-effort compensation
 * (revert) when the audit insert fails.
 */

const PASSWORD = 'test-admin-password-1234';
const CREATOR_ID = 'b3c1a7e2-0000-4000-8000-000000000001';

const serviceMock = vi.hoisted(() => ({
  supabaseFromEnv: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseFromEnv: serviceMock.supabaseFromEnv,
}));

function profileRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CREATOR_ID,
    stage_name: 'Nova Reign',
    legal_name: 'Jordan A. Reyes',
    email: 'creator@example.com',
    phone: '+15125550123',
    phone_verified_at: null,
    core_industry: 'Music — Recording',
    title: 'Recording Artist',
    udr_terms_accepted_at: '2026-09-09T00:00:00.000Z',
    created_at: '2026-09-09T00:00:00.000Z',
    // Migration 0004 columns, at their backfilled defaults.
    kyc_status: 'PENDING_INITIALIZATION',
    tax_form_type: 'W9',
    tax_verified: false,
    bank_account_linked: false,
    ...overrides,
  };
}

interface FakeOptions {
  rows?: unknown[];
  readError?: { message: string } | null;
  updateError?: { message: string } | null;
  logInsertError?: { message: string } | null;
  logId?: string;
}

/**
 * A fake service-role client covering the creator_profiles + admin_action_log
 * chains the stores use, recording every write for the discipline asserts.
 */
function adminDb(options: FakeOptions = {}) {
  const ops = {
    profileSelects: [] as { columns?: string; eq?: unknown[] }[],
    profileUpdates: [] as Record<string, unknown>[],
    logInserts: [] as Record<string, unknown>[],
  };
  const rows = options.rows ?? [profileRow()];
  const client = {
    ops,
    from: vi.fn((table: string) => {
      if (table === 'admin_action_log') {
        return {
          insert: vi.fn((values: Record<string, unknown>) => {
            ops.logInserts.push(values);
            return {
              select: () => ({
                single: vi.fn(async () =>
                  options.logInsertError
                    ? { data: null, error: options.logInsertError }
                    : { data: { id: options.logId ?? 'log-1' }, error: null },
                ),
              }),
            };
          }),
        };
      }
      return {
        select: (columns: string) => {
          const entry: { columns?: string; eq?: unknown[] } = { columns };
          ops.profileSelects.push(entry);
          return {
            // List shape: .select(...).order(...)
            order: vi.fn(async () =>
              options.readError ? { data: null, error: options.readError } : { data: rows, error: null },
            ),
            // Detail shape: .select(...).eq('id', id).maybeSingle()
            eq: (...eqArgs: unknown[]) => {
              entry.eq = eqArgs;
              return {
                maybeSingle: vi.fn(async () => {
                  if (options.readError) return { data: null, error: options.readError };
                  const found = rows.find((r) => (r as Record<string, unknown>).id === eqArgs[1]);
                  return { data: found ?? null, error: null };
                }),
              };
            },
          };
        },
        update: (patch: Record<string, unknown>) => {
          ops.profileUpdates.push(patch);
          return {
            eq: (...eqArgs: unknown[]) => ({
              select: () => ({
                maybeSingle: vi.fn(async () => {
                  if (options.updateError) return { data: null, error: options.updateError };
                  const current = rows.find((r) => (r as Record<string, unknown>).id === eqArgs[1]);
                  if (!current) return { data: null, error: null };
                  return { data: { ...current, ...patch }, error: null };
                }),
              }),
            }),
          };
        },
      };
    }),
  };
  return client;
}

const TOKEN = { value: '' };

function gatedRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://covnant.test${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: `${ADMIN_COOKIE_NAME}=${TOKEN.value}` },
  });
}

function patchRequest(body: unknown): { request: Request; context: { params: Promise<{ id: string }> } } {
  return {
    request: gatedRequest(`/api/admin/creators/${CREATOR_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    context: { params: Promise.resolve({ id: CREATOR_ID }) },
  };
}

beforeEach(() => {
  process.env.ADMIN_DASHBOARD_PASSWORD = PASSWORD;
  TOKEN.value = mintAdminSessionToken()!;
});

afterEach(() => {
  delete process.env.ADMIN_DASHBOARD_PASSWORD;
  vi.clearAllMocks();
});

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('gate boundary — fail closed before any data access', () => {
  it('answers 503 admin_not_configured when the secret is unset, touching NO data', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;
    const res = await listGET(gatedRequest('/api/admin/creators'));
    expect(res.status).toBe(503);
    expect((await jsonOf(res)).reason).toBe('admin_not_configured');
    expect(serviceMock.supabaseFromEnv).not.toHaveBeenCalled();
  });

  it('answers 401 with no cookie, touching NO data (neither failure leaks rows)', async () => {
    const db = adminDb();
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const res = await listGET(new Request('https://covnant.test/api/admin/creators'));
    expect(res.status).toBe(401);
    expect((await jsonOf(res)).reason).toBe('admin_not_authenticated');
    expect(serviceMock.supabaseFromEnv).not.toHaveBeenCalled();
    expect(db.ops.profileSelects).toHaveLength(0);
  });
});

describe('GET /api/admin/creators — list + detail', () => {
  it('lists every 0003 + 0004 column for all creators', async () => {
    const second = profileRow({
      id: 'b3c1a7e2-0000-4000-8000-000000000002',
      email: 'other@example.com',
      stage_name: 'Second Creator',
      kyc_status: 'VERIFIED',
    });
    const db = adminDb({ rows: [second, profileRow()] });
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);

    const res = await listGET(gatedRequest('/api/admin/creators'));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.creators).toHaveLength(2);
    const first = (body.creators as Record<string, unknown>[])[0];
    // ALL columns present — identity and compliance alike.
    for (const key of Object.keys(profileRow())) {
      expect(first).toHaveProperty(key);
    }
    expect(first.kyc_status).toBe('VERIFIED');
  });

  it('returns 404 creator_not_found for an unknown id — nothing else disclosed', async () => {
    const db = adminDb({ rows: [profileRow()] });
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const res = await detailGET(gatedRequest(`/api/admin/creators/${CREATOR_ID}`), {
      params: Promise.resolve({ id: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);
    expect((await jsonOf(res)).reason).toBe('creator_not_found');
  });
});

describe('PATCH /api/admin/creators/[id] — enum enforcement, nothing half-written', () => {
  it('rejects an invalid kyc_status with 400 and performs NO writes', async () => {
    const db = adminDb();
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const { request, context } = patchRequest({ kyc_status: 'APPROVED' });
    const res = await PATCH(request, context);
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).reason).toBe('invalid_kyc_status');
    expect(db.ops.profileUpdates).toHaveLength(0);
    expect(db.ops.logInserts).toHaveLength(0);
  });

  it('rejects an invalid tax_form_type with 400 and performs NO writes', async () => {
    const db = adminDb();
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const { request, context } = patchRequest({ tax_form_type: 'W2' });
    const res = await PATCH(request, context);
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).reason).toBe('invalid_tax_form_type');
    expect(db.ops.profileUpdates).toHaveLength(0);
    expect(db.ops.logInserts).toHaveLength(0);
  });

  it('rejects a non-boolean tax_verified with 400 and performs NO writes', async () => {
    const db = adminDb();
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const { request, context } = patchRequest({ tax_verified: 'yes' });
    const res = await PATCH(request, context);
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).reason).toBe('invalid_tax_verified');
    expect(db.ops.profileUpdates).toHaveLength(0);
    expect(db.ops.logInserts).toHaveLength(0);
  });

  it('rejects read-only fields (bank_account_linked) — never silently dropped', async () => {
    const db = adminDb();
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const { request, context } = patchRequest({ bank_account_linked: true });
    const res = await PATCH(request, context);
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).reason).toBe('invalid_field');
    expect(db.ops.profileUpdates).toHaveLength(0);
    expect(db.ops.logInserts).toHaveLength(0);
  });

  it('rejects an empty patch with 400', async () => {
    const db = adminDb();
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const { request, context } = patchRequest({});
    const res = await PATCH(request, context);
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).reason).toBe('empty_patch');
  });
});

describe('PATCH /api/admin/creators/[id] — exactly one audited mutation', () => {
  it('applies the change and writes exactly ONE action-log row with field-level before/after', async () => {
    const db = adminDb();
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const { request, context } = patchRequest({ kyc_status: 'PENDING', tax_verified: true });
    const res = await PATCH(request, context);

    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    // Exactly one audit row — the platform's first compliance mutation, logged.
    expect(db.ops.logInserts).toHaveLength(1);
    const log = db.ops.logInserts[0];
    expect(log.actor).toBe('admin');
    expect(log.action).toBe('creator.compliance.update');
    expect(log.target_table).toBe('creator_profiles');
    expect(log.target_row_id).toBe(CREATOR_ID);
    expect(log.changes).toEqual({
      kyc_status: { from: 'PENDING_INITIALIZATION', to: 'PENDING' },
      tax_verified: { from: false, to: true },
    });
    // The log record rides back in the response.
    expect(body.action).toMatchObject({ action: 'creator.compliance.update' });
    // The profile response carries the new values.
    expect((body.profile as Record<string, unknown>).kyc_status).toBe('PENDING');
    expect((body.profile as Record<string, unknown>).tax_verified).toBe(true);
  });

  it('performs NO write and NO log for a no-op patch', async () => {
    const db = adminDb();
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const { request, context } = patchRequest({ kyc_status: 'PENDING_INITIALIZATION' });
    const res = await PATCH(request, context);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.action).toBeNull();
    expect(db.ops.logInserts).toHaveLength(0);
    expect(db.ops.profileUpdates).toHaveLength(0);
  });

  it('answers 404 for an unknown creator — no write, no log', async () => {
    const db = adminDb({ rows: [] });
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const { request, context } = patchRequest({ kyc_status: 'PENDING' });
    const res = await PATCH(request, context);
    expect(res.status).toBe(404);
    expect(db.ops.profileUpdates).toHaveLength(0);
    expect(db.ops.logInserts).toHaveLength(0);
  });

  it('compensates (reverts) when the audit insert fails — change never stands unlogged', async () => {
    const db = adminDb({ logInsertError: { message: 'admin_action_log insert failed' } });
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const { request, context } = patchRequest({ kyc_status: 'PENDING' });
    const res = await PATCH(request, context);

    expect(res.status).toBe(502);
    expect((await jsonOf(res)).reason).toBe('admin_action_log_failed');
    // Exactly one failed log insert and a compensating revert to before-values.
    expect(db.ops.logInserts).toHaveLength(1);
    expect(db.ops.profileUpdates).toHaveLength(2);
    expect(db.ops.profileUpdates[1]).toEqual({
      kyc_status: 'PENDING_INITIALIZATION',
      tax_form_type: 'W9',
      tax_verified: false,
    });
  });
});
