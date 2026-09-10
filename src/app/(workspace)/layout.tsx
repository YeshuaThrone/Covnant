import { AppShell } from '@/components/shell/AppShell';
import { fixturesDashboardDataProvider } from '@/lib/don/dashboardFixtures';

/**
 * (workspace) route group — every authenticated-surface route renders
 * inside The Don app shell. The URL layout is unchanged; the group exists
 * purely to keep the landing page chrome-free.
 *
 * The shell's user chip resolves from the SAME dashboard data provider the
 * dashboard home consumes (fixtures today — the live swap changes the
 * provider in one place, and this layout follows). Resolution never blocks
 * a page: a provider without a persona renders the honest unregistered
 * badge, and nothing is fabricated.
 */
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const data = await fixturesDashboardDataProvider.getDashboardData();
  return (
    <AppShell user={data.user}>
      {children}
    </AppShell>
  );
}
