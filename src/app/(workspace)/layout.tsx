import { AppShell } from '@/components/shell/AppShell';
import { identityBadgeStateFromMe } from '@/lib/covnant/identityFromMe';
import { resolveCovnantMe } from '@/lib/server/covnantMe';

/**
 * (workspace) route group — every authenticated-surface route renders
 * inside the Obsidian app shell. The URL layout is unchanged; the group
 * exists purely to keep the landing page chrome-free.
 *
 * The shell's identity pill resolves from the SAME shared session
 * aggregate the dashboard home and the API route use (resolveCovnantMe,
 * React-cached: one resolution per request even when both layout and page
 * consume it). A failed resolution renders the honest unregistered badge —
 * the shell never blocks a page on identity, and nothing is fabricated.
 */
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const me = await resolveCovnantMe();
  return (
    <AppShell identity={me.ok ? identityBadgeStateFromMe(me.data) : undefined}>
      {children}
    </AppShell>
  );
}
