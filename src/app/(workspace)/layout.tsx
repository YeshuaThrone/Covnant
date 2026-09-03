import { AppShell } from '@/components/shell/AppShell';

/**
 * (workspace) route group — every authenticated-surface route renders
 * inside the Obsidian app shell. The URL layout is unchanged; the group
 * exists purely to keep the landing page chrome-free.
 */
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
