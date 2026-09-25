/**
 * The Export Audit Package's statement route (spec art_qNu4T32F, module 4):
 * `/admin/audit-statement?payee=<payeeId>&window=7d|30d|90d|all` — reached
 * from the Creator Analytics leaderboard's Export control. The same
 * operator gate as the console, the same Don store door as the tab, and
 * the statement-data derivation over `listAssets()`' registry read. The
 * PDF path is the browser's print dialog through the print stylesheet —
 * zero new dependencies (package.json is pinned by test).
 *
 * Honesty law: an unknown window or a missing payee renders the honest
 * statement-error state (not a guessed default statement); a failed store
 * read renders the statement's unavailable state; a payee with no window
 * rows renders an honest zero statement.
 */

import { cookies } from 'next/headers';
import { listAssets } from '@/lib/sdk';
import { ADMIN_COOKIE_NAME, verifyAdminSession } from '@/lib/admin/gate';
import { adminPageView } from '@/lib/admin/console';
import { isDemoDoorOpen } from '@/lib/admin/demoSeeds';
import { isDevSeedMode, getSeededStore } from '@/lib/server/devSeed';
import { getStore, type Store } from '@/lib/server/store';
import { auditStatementFlows, statementWindowFromParam } from '@/lib/admin/auditStatement';
import type { CreatorWindowDays } from '@/lib/admin/creatorAnalytics';
import { AdminGate } from '@/components/admin/AdminGate';
import { AuditStatementView } from '@/components/admin/sections/AuditStatementView';

const NOT_CONFIGURED_NOTICE =
  'The admin console is not configured. Set the ADMIN_DASHBOARD_PASSWORD environment variable to enable operator access.';

/** The statement's honest failure block — one line, no invented figures. */
function StatementUnavailable({ message, testid }: { message: string; testid: string }) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-10" aria-label="Audit statement">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">
        Covnant · Operator Console · Audit Statement
      </p>
      <div className="mt-6 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
        <p data-testid={testid} className="font-mono text-sm text-white/50">
          {message}
        </p>
      </div>
    </div>
  );
}

export default async function AuditStatementPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const token = (await cookies()).get(ADMIN_COOKIE_NAME)?.value ?? null;
  const view = adminPageView(verifyAdminSession(token));

  if (view === 'unavailable') {
    return <AdminGate notice={NOT_CONFIGURED_NOTICE} />;
  }
  if (view === 'login') {
    return <AdminGate />;
  }

  const params = await searchParams;
  const payeeParam = params.payee;
  const payeeId = Array.isArray(payeeParam) ? payeeParam[0] : payeeParam;
  if (payeeId === undefined || payeeId === '') {
    return <StatementUnavailable message="No payee specified — the statement link carries the payee of record." testid="audit-statement-error" />;
  }
  const windowParam = params.window;
  const windowId = Array.isArray(windowParam) ? windowParam[0] : windowParam;
  const windowDays: CreatorWindowDays | 'invalid' = statementWindowFromParam(windowId);
  if (windowDays === 'invalid') {
    return (
      <StatementUnavailable
        message={`Unknown statement window "${windowId ?? ''}" — use 7d, 30d, 90d, or all.`}
        testid="audit-statement-error"
      />
    );
  }

  // The same store door as the console's creator reads, plus the asset
  // registry read the page already performs for its own sections.
  const store: Store = isDevSeedMode() ? await getSeededStore() : getStore();
  const assets = await listAssets();
  const flows = await auditStatementFlows(store, assets, windowDays, payeeId);
  if (flows === null) {
    return <StatementUnavailable message="The statement's store read failed — no figures are rendered rather than partial ones." testid="audit-statement-unavailable" />;
  }

  return <AuditStatementView flows={flows} demo={isDemoDoorOpen()} generatedAt={new Date().toISOString()} />;
}
