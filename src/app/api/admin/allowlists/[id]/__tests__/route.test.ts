import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../route';
import { ADMIN_COOKIE_NAME, mintAdminSessionToken } from '@/lib/admin/gate';

/**
 * POST /api/admin/allowlists/[id] contract tests — the ACTIVE/REVOKED flip.
 *
 * Gated fail-closed (no data touched on any refusal), the flip toggles
 * ACTIVE ↔ REVOKED, exactly ONE admin_action_log row records the field-level
 * status before/after, and a failed audit insert compensates (reverts the
 * flip) with a sanitized 502 — the change never stands unlogged.
 */

const PASSWORD = 'test-admin-password-1234';
const ALLOWLIST_ID = 'c4d2b8f3-0000-4000-8000-000000000003';

const serviceMock = vi.hoisted(() => ({
  supabaseFromEnv: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabaseFromEnv: serviceMock.supabaseFromEnv,
}));

function allowlistRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ALLOWLIST_ID,
    platform: 'youtube',
    target_account_id: '@novareign',
    cbt_code: 'CBT-NOVA-REIGN-01',
    creator_incentive_share_pct: 0.8,
    status: 'ACTIVE',
    created_at: '2026-09-09T00:00:00.000Z',
    ...overrides,
  };
}

interface FakeOptions {
  row?: unknown;
  readError?: { message: string } | null;
  updateError?: { message: string } | null;
  logInsertError?: { message: string } | null;
}

function allowlistDb(options: FakeOptions = {}) {
  const ops = {
    updates: [] as Record<string, unknown>[],
    logInserts: [] as Record<string, unknown>[],
  };
  const current = () => (options.row === undefined ? allowlistRow() : options.row);
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
                    : { data: { id: 'log-allowlist-1' }, error: null },
                ),
              }),
            };
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: vi.fn(async () =>
              options.readError
                ? { data: null, error: options.readError }
                : { data: current(), error: null },
            ),
          }),
          // List shape (unused by the flip route but present for parity).
          order: vi.fn(async () => ({ data: [current()], error: null })),
        }),
        update: (patch: Record<string, unknown>) => {
          ops.updates.push(patch);
          return {
            eq: () => ({
              select: () => ({
                maybeSingle: vi.fn(async () => {
                  if (options.updateError) return { data: null, error: options.updateError };
                  return { data: { ...current(), ...patch }, error: null };
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

function flipRequest(): { request: Request; context: { params: Promise<{ id: string }> } } {
  return {
    request: new Request(`https://covnant.test/api/admin/allowlists/${ALLOWLIST_ID}`, {
      method: 'POST',
      headers: { cookie: `${ADMIN_COOKIE_NAME}=${TOKEN.value}` },
    }),
    context: { params: Promise.resolve({ id: ALLOWLIST_ID }) },
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

describe('POST /api/admin/allowlists/[id] — the logged ACTIVE/REVOKED flip', () => {
  it('answers 503 admin_not_configured when the secret is unset, touching NO data', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;
    const db = allowlistDb();
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const { request, context } = flipRequest();
    const res = await POST(request, context);
    expect(res.status).toBe(503);
    expect((await jsonOf(res)).reason).toBe('admin_not_configured');
    expect(serviceMock.supabaseFromEnv).not.toHaveBeenCalled();
    expect(db.ops.updates).toHaveLength(0);
  });

  it('answers 401 with no cookie, touching NO data', async () => {
    const db = allowlistDb();
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const request = new Request(`https://covnant.test/api/admin/allowlists/${ALLOWLIST_ID}`, { method: 'POST' });
    const res = await POST(request, { params: Promise.resolve({ id: ALLOWLIST_ID }) });
    expect(res.status).toBe(401);
    expect((await jsonOf(res)).reason).toBe('admin_not_authenticated');
    expect(serviceMock.supabaseFromEnv).not.toHaveBeenCalled();
  });

  it('flips ACTIVE → REVOKED and logs exactly ONE row with the status before/after', async () => {
    const db = allowlistDb();
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const { request, context } = flipRequest();
    const res = await POST(request, context);

    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect((body.allowlist as Record<string, unknown>).status).toBe('REVOKED');
    expect(db.ops.logInserts).toHaveLength(1);
    expect(db.ops.logInserts[0]).toMatchObject({
      actor: 'admin',
      action: 'allowlist.status_flip',
      target_table: 'platform_allowlists',
      target_row_id: ALLOWLIST_ID,
      changes: { status: { from: 'ACTIVE', to: 'REVOKED' } },
    });
    expect(db.ops.updates).toEqual([{ status: 'REVOKED' }]);
  });

  it('flips REVOKED → ACTIVE (the toggle works both ways, logged)', async () => {
    const db = allowlistDb({ row: allowlistRow({ status: 'REVOKED' }) });
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const { request, context } = flipRequest();
    const res = await POST(request, context);
    expect(res.status).toBe(200);
    expect(db.ops.logInserts[0]).toMatchObject({
      changes: { status: { from: 'REVOKED', to: 'ACTIVE' } },
    });
  });

  it('answers 404 for an unknown allowlist row — no write, no log', async () => {
    const db = allowlistDb({ row: null });
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const { request, context } = flipRequest();
    const res = await POST(request, context);
    expect(res.status).toBe(404);
    expect(db.ops.updates).toHaveLength(0);
    expect(db.ops.logInserts).toHaveLength(0);
  });

  it('compensates (reverts the flip) when the audit insert fails', async () => {
    const db = allowlistDb({ logInsertError: { message: 'insert failed' } });
    serviceMock.supabaseFromEnv.mockReturnValue(db as never);
    const { request, context } = flipRequest();
    const res = await POST(request, context);

    expect(res.status).toBe(502);
    expect((await jsonOf(res)).reason).toBe('admin_action_log_failed');
    expect(db.ops.logInserts).toHaveLength(1);
    // The compensating write restores the ORIGINAL status.
    expect(db.ops.updates).toEqual([{ status: 'REVOKED' }, { status: 'ACTIVE' }]);
  });
});
