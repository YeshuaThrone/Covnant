/**
 * /mul — the MUL Registry: the admin console's operator surface for the
 * Master Universal License machine (build spec open item #4, closed). Same
 * gate flow as /admin/registry (adminPageView over verifyAdminSession — the
 * gate never touches middleware): unavailable → the honest notice, login →
 * the AdminGate, console → the registry reading the same Store seam the /admin
 * console reads (seeded preview gets the seeded store, production the
 * service-role Supabase store).
 *
 * THE MACHINE IS THE LAW: this page invents no clearance rules. It reads the
 * current rows through listClearances and hands them to the registry
 * component; every mutation still rides the audited POST route, which alone
 * moves the machine.
 */

import { cookies } from 'next/headers';

import { adminPageView } from '@/lib/admin/console';
import { ADMIN_COOKIE_NAME, verifyAdminSession } from '@/lib/admin/gate';
import { AdminGate } from '@/components/admin/AdminGate';
import { MulRegistry, type MulRegistryData } from '@/components/admin/MulRegistry';
import { isDevSeedMode, getSeededStore } from '@/lib/server/devSeed';
import { getStore } from '@/lib/server/store';

export const metadata = {
  title: 'MUL Registry — Covnant',
  description:
    'Every Master Universal License clearance — state, term, history, and audited transitions.',
};

export const dynamic = 'force-dynamic';

const NOT_CONFIGURED_NOTICE =
  'The admin console is not configured. Set the ADMIN_DASHBOARD_PASSWORD environment variable to enable operator access.';

export default async function MulPage() {
  const token = (await cookies()).get(ADMIN_COOKIE_NAME)?.value ?? null;
  const view = adminPageView(verifyAdminSession(token));

  if (view === 'unavailable') {
    return <AdminGate notice={NOT_CONFIGURED_NOTICE} />;
  }
  if (view === 'login') {
    return <AdminGate />;
  }

  let data: MulRegistryData;
  try {
    const store = isDevSeedMode() ? await getSeededStore() : getStore();
    const result = await store.listClearances();
    data = { kind: 'ready', clearances: result.clearances };
  } catch (error) {
    // Honesty law: an unavailable read renders its message — never a
    // fabricated table.
    data = {
      kind: 'unavailable',
      message: error instanceof Error ? error.message : 'The registry read failed.',
    };
  }

  // The display clock is fixed at the page render so the expired indicator
  // (the machine's own rule — an expired term is NOT cleared) hydrates
  // identically on the client.
  return <MulRegistry data={data} nowIso={new Date().toISOString()} />;
}
