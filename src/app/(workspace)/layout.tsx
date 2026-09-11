import { AppShell, type ShellUser } from '@/components/shell/AppShell';
import { liveDashboardDataProvider } from '@/lib/server/dashboardLive';

/**
 * (workspace) route group — every authenticated-surface route renders
 * inside The Don app shell. The URL layout is unchanged; the group exists
 * purely to keep the landing page chrome-free.
 *
 * The shell's user chip resolves from the SAME live dashboard provider the
 * dashboard home consumes (src/lib/server/dashboardLive.ts — the session-
 * bound identity swap that replaced the fixtures). Resolution never blocks
 * a page: anonymous, unregistered, and read-failure resolutions all render
 * the honest unregistered badge (no persona is fabricated), and the
 * dashboard home's own body carries the detailed state panels.
 */
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  let user: ShellUser | undefined;
  try {
    const resolution = await liveDashboardDataProvider.getDashboardResolution();
    if (resolution.kind === 'registered') {
      user = resolution.data.user;
    }
  } catch (error) {
    // Identity could not be verified (read failure) — the shell renders the
    // honest unregistered badge; never a fabricated persona.
    console.error('workspace identity resolution failed:', error);
  }
  return (
    <AppShell user={user}>
      {children}
    </AppShell>
  );
}
