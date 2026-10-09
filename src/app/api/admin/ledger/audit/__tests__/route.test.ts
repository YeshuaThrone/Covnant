import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_COOKIE_NAME, mintAdminSessionToken } from '@/lib/admin/gate';
import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { calculateUdrSplits } from '@/lib/server/udrSplits';
import type { GlJournalRecord } from '@/modules/don/records';
import { creditVault } from '@/modules/vaults/engine';
import { GET } from '../route';

/**
 * GET /api/admin/ledger/audit — the F7 scheduled tamper-evidence check.
 *
 * Contract, fail closed FIRST:
 *   - unset ADMIN_DASHBOARD_PASSWORD with no cron credential → 503
 *     admin_not_configured — the audit never runs for an unconfigured
 *     deployment;
 *   - absent/expired/forged admin cookie and no valid cron bearer → 401
 *     admin_not_authenticated — the failure response carries no audit data;
 *   - CRON_SECRET bearer (Vercel's documented cron auth) is accepted only
 *     when the env secret is set and matches timing-safely — a bearer
 *     against an unset secret is 401, never an open door;
 *   - a valid operator session or cron credential gets the audit verdict:
 *     200 with immutable_valid + books_reconcile true, 503
 *     ledger_audit_failed with the full report when either check fails.
 *
 * The store seam is mocked with the real InMemoryStore so the audit runs
 * for real; only WHERE the store comes from is faked.
 */

const PASSWORD = 'test-admin-password-1234';
const CRON_SECRET = 'test-cron-secret-6789';

const storeMock = vi.hoisted(() => ({
  getStore: vi.fn(),
}));

vi.mock('@/lib/server/store', () => ({
  getStore: storeMock.getStore,
}));

/**
 * A split run whose books reconcile (fbo_cash == vault liability, the
 * proven healthy fixture from the audit module's own tests) with a valid
 * hash chain.
 */
async function healthyStore(): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  const result = await calculateUdrSplits(store, {
    source: 'spotify',
    period: '2026-08',
    currency: 'USD',
    settle: false,
    rail: 'rtp',
    line_items: [
      {
        work_id: 'trk_01',
        work_title: 'Midnight On 6th',
        amount_cents: 10_000,
        splits: [
          { payee_id: 'c1', payee_name: 'Yeshua Throne', role: 'creator', share_bps: 7000 },
          { payee_id: 'l1', payee_name: 'Throne Records', role: 'label', share_bps: 3000 },
        ],
      },
    ],
  });
  if (!result.ok) throw new Error('fixture split run must settle');
  return store;
}

/**
 * Books-fraud simulator: the stored entry_hash no longer matches what
 * verifyHashChain recomputes — the immutable conjunct fails while every
 * balance still reconciles.
 */
class TamperedChainStore extends InMemoryStore {
  private readonly journals: GlJournalRecord[];
  constructor(journals: GlJournalRecord[]) {
    super();
    this.journals = journals;
  }
  override async listGlJournals(): Promise<GlJournalRecord[]> {
    return this.journals.map((journal) => ({
      ...journal,
      entry_hash: `0x${'0'.repeat(64)}`,
    }));
  }
}

function auditRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://covnant.test/api/admin/ledger/audit', { headers });
}

function adminCookieHeader(): string {
  const token = mintAdminSessionToken();
  if (!token) throw new Error('fixture requires ADMIN_DASHBOARD_PASSWORD');
  return `${ADMIN_COOKIE_NAME}=${token}`;
}

beforeEach(async () => {
  process.env.ADMIN_DASHBOARD_PASSWORD = PASSWORD;
  delete process.env.CRON_SECRET;
  storeMock.getStore.mockReturnValue(await healthyStore());
});

afterEach(() => {
  delete process.env.ADMIN_DASHBOARD_PASSWORD;
  delete process.env.CRON_SECRET;
  vi.clearAllMocks();
});

describe('GET /api/admin/ledger/audit — fail closed', () => {
  it('answers 503 admin_not_configured when no operator secret and no cron credential is configured', async () => {
    delete process.env.ADMIN_DASHBOARD_PASSWORD;
    const res = await GET(auditRequest());
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, reason: 'admin_not_configured' });
    expect(body.audit).toBeUndefined();
  });

  it('refuses an anonymous call with 401 admin_not_authenticated and no audit data', async () => {
    const res = await GET(auditRequest());
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, reason: 'admin_not_authenticated' });
    expect(body.audit).toBeUndefined();
  });

  it('refuses a forged cookie', async () => {
    const res = await GET(
      auditRequest({ cookie: `${ADMIN_COOKIE_NAME}=1.${'f'.repeat(64)}` }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reason).toBe('admin_not_authenticated');
  });

  it('refuses a wrong cron bearer', async () => {
    const res = await GET(
      auditRequest({ authorization: `Bearer wrong-cron-secret` }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reason).toBe('admin_not_authenticated');
  });

  it('refuses a cron bearer when CRON_SECRET is unset — fail closed, never an open door', async () => {
    const res = await GET(
      auditRequest({ authorization: `Bearer ${CRON_SECRET}` }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reason).toBe('admin_not_authenticated');
  });
});

describe('GET /api/admin/ledger/audit — the audit verdict', () => {
  it('returns 200 with the report for a valid operator session', async () => {
    const res = await GET(auditRequest({ cookie: adminCookieHeader() }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      healthy: true,
      immutable_valid: true,
      books_reconcile: true,
    });
    const audit = body.audit as Record<string, unknown>;
    expect(audit.immutable).toMatchObject({ valid: true, journal_count: 1 });
    expect(audit.books_reconcile).toBe(true);
  });

  it('returns 200 for the cron bearer alone — no cookie, the scheduled path', async () => {
    process.env.CRON_SECRET = CRON_SECRET;
    const res = await GET(
      auditRequest({ authorization: `Bearer ${CRON_SECRET}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, healthy: true, immutable_valid: true });
  });

  it('returns 503 ledger_audit_failed when books diverge (chain still valid)', async () => {
    const divergent = new InMemoryStore();
    await creditVault(divergent, 'c1', 'Yeshua Throne', 50, 'available');
    storeMock.getStore.mockReturnValue(divergent);

    const res = await GET(auditRequest({ cookie: adminCookieHeader() }));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: false,
      reason: 'ledger_audit_failed',
      healthy: false,
      immutable_valid: true,
      books_reconcile: false,
    });
    const audit = body.audit as Record<string, unknown>;
    expect(audit.variance_cents).toBe(-50);
  });

  it('returns 503 ledger_audit_failed when the hash chain is broken even though books reconcile', async () => {
    const base = await healthyStore();
    const tampered = new TamperedChainStore(await base.listGlJournals());
    storeMock.getStore.mockReturnValue(tampered);

    const res = await GET(auditRequest({ cookie: adminCookieHeader() }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: false,
      reason: 'ledger_audit_failed',
      healthy: false,
      immutable_valid: false,
      books_reconcile: true,
    });
  });
});
