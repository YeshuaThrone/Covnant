/**
 * GET /api/admin/ledger/audit — the scheduled tamper-evidence check (F7).
 *
 * Until now `auditLedger` ran only when someone asked (its sole production
 * caller was the MCP ledger_audit tool), so tampering could sit undetected
 * until a human happened to look. This route runs the SAME audit and
 * reports its verdict on a daily Vercel schedule (see the `crons` entry in
 * vercel.json), so the drift surfaces within a day instead of on demand.
 *
 * AUTH — the verifyAdminSession pattern every /api/admin route answers to,
 * plus the one credential the scheduler itself can hold:
 *   - signed admin session cookie (checkAdminGate): the operator path.
 *     Unset ADMIN_DASHBOARD_PASSWORD → 503 admin_not_configured (fail
 *     closed — the console is unavailable, never open); absent/expired/
 *     forged cookie → 401 admin_not_authenticated. Neither failure
 *     carries audit data.
 *   - `Authorization: Bearer $CRON_SECRET` (Vercel Cron's documented auth
 *     header) — accepted only when CRON_SECRET is set and matches, compare
 *     timing-safe; a bearer against an unset secret is refused, so the
 *     cron path can never become an anonymous open door.
 *
 * VERDICT — 200 with `immutable_valid` and `books_reconcile` (both true,
 * full `audit` report attached) when the ledger is healthy; 503
 * ledger_audit_failed with the same report when either check fails, so a
 * monitor (or the cron failure feed) sees the drift without parsing the
 * body. READS ONLY — the audit never writes.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { checkAdminGate } from '@/lib/admin/gate';
import { jsonError } from '@/lib/server/http';
import { getStore } from '@/lib/server/store';
import { auditLedger, ledgerAuditHealthy, type LedgerAuditReport } from '@/modules/ledger/audit';

export const dynamic = 'force-dynamic';

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when the env var
 * is configured. Both sides are digested through a fixed-width hash before
 * the timing-safe compare (timingSafeEqual throws on length mismatch, the
 * same length-flattening discipline the admin gate uses); an unset secret
 * fails closed.
 */
function cronBearerMatches(header: string | null, env: NodeJS.ProcessEnv): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const secret = env.CRON_SECRET;
  if (!secret || secret.length === 0) return false;
  const presented = createHash('sha256').update(header.slice('Bearer '.length).trim()).digest();
  const configured = createHash('sha256').update(secret).digest();
  return timingSafeEqual(presented, configured);
}

/** Names exactly which tamper-evidence check failed, for the cron failure feed. */
function auditFailure(report: LedgerAuditReport): string {
  const failed = [
    ...(report.immutable.valid
      ? []
      : [`immutable.valid=false (hash chain broken at journal ${report.immutable.broken_at})`]),
    ...(report.books_reconcile
      ? []
      : [
          `books_reconcile=false (FBO cash ${report.fbo_cash_cents} vs vault liability ${report.vault_liability_cents}, variance ${report.variance_cents})`,
        ]),
  ];
  return `Ledger audit failed: ${failed.join('; ')}`;
}

export async function GET(request: Request): Promise<Response> {
  const gate = checkAdminGate(request);
  if (!gate.ok && !cronBearerMatches(request.headers.get('authorization'), process.env)) {
    return jsonError(gate.status, gate.code, gate.message);
  }

  const report = await auditLedger(getStore());
  const headers = { 'cache-control': 'no-store' };
  const verdict = {
    immutable_valid: report.immutable.valid,
    books_reconcile: report.books_reconcile,
    audit: report,
  };
  if (ledgerAuditHealthy(report)) {
    return Response.json({ ok: true, healthy: true, ...verdict }, { status: 200, headers });
  }
  return Response.json(
    {
      ok: false,
      reason: 'ledger_audit_failed',
      error: auditFailure(report),
      healthy: false,
      ...verdict,
    },
    { status: 503, headers },
  );
}
