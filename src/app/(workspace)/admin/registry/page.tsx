/**
 * /admin/registry — canon v20 Section 2: the RegistryAdminDashboard's
 * gated operator surface. Same gate flow as the console and the audit
 * statement (adminPageView over verifyAdminSession — the gate never
 * touches middleware): unavailable → the honest notice, login → the
 * AdminGate, console → the dashboard reading the 0012 tables and the
 * Redis cache status.
 */

import { cookies } from 'next/headers';

import { registryDashboardData, verticalFilterFromParam } from '@/lib/admin/registryDashboard';
import { ADMIN_COOKIE_NAME, verifyAdminSession } from '@/lib/admin/gate';
import { adminPageView } from '@/lib/admin/console';
import { AdminGate } from '@/components/admin/AdminGate';
import { RegistryAdminDashboard } from '@/components/admin/sections/RegistryAdminDashboard';

export const metadata = {
  title: 'Rights Holder Registry — Covnant',
  description: 'Rights holder registry and UCT provisioning behind the operator gate.',
};

const NOT_CONFIGURED_NOTICE =
  'The admin console is not configured. Set the ADMIN_DASHBOARD_PASSWORD environment variable to enable operator access.';

export default async function RegistryAdminPage({
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
  const qParam = params.q;
  const q = Array.isArray(qParam) ? qParam[0] : qParam;
  const verticalParam = params.vertical;
  const vertical = verticalFilterFromParam(
    Array.isArray(verticalParam) ? verticalParam[0] : verticalParam,
  );

  const data = await registryDashboardData(q, vertical);

  return <RegistryAdminDashboard data={data} />;
}
