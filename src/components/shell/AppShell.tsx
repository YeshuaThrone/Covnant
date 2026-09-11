import Link from 'next/link';
import { CvRibbonMonogram } from '@/components/brand/CvRibbonMonogram';
import { IdentityBadge } from '@/components/brand/IdentityBadge';
import { MobileDrawer } from './MobileDrawer';
import { SidebarNav, type NavItem } from './SidebarNav';

/**
 * The nine destinations of the Obsidian workspace shell. Vault routes to
 * the contract vault; Admin is the existing operations console. Later PRs
 * replace the stubbed views in place — the nav is the stable surface.
 */
export const WORKSPACE_NAV: NavItem[] = [
  { href: '/dashboard', label: 'The Don' },
  { href: '/catalog', label: 'Catalog' },
  { href: '/contracts', label: 'Contracts' },
  { href: '/templates', label: 'Templates' },
  { href: '/ledger', label: 'Ownership Ledger' },
  { href: '/vault', label: 'Vault' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/settings', label: 'Settings' },
  { href: '/admin', label: 'Admin' },
];

/**
 * The workspace persona for the shell's identity surfaces — the greeting
 * voice only (initials + stage name), never an identity document. Resolved
 * by the (workspace) layout from the dashboard data provider (fixtures
 * today; the live swap changes the provider, not the shell). Absent → the
 * honest unregistered badge, exactly as before.
 */
export type ShellUser = {
  stage_name: string;
  initials: string;
};

/**
 * The Don app shell — fixed sidebar on large screens, drawer navigation on
 * small ones (bank reference: hamburger drawer). Wraps every workspace
 * route via the (workspace) route group; the landing page stays chrome-free.
 *
 * Brand: the sidebar and mobile-top chips carry the COVNANT brand — the
 * page-title slot (the dashboard wordmark, the drawer header, the browser
 * title) carries The Don. The gold CV mark and every brand token are
 * unchanged. No blue anywhere.
 */
export function AppShell({
  children,
  user,
}: {
  children: React.ReactNode;
  user?: ShellUser;
}) {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[264px_1fr]">
      <aside
        data-shell="sidebar"
        className="sticky top-0 hidden h-screen flex-col justify-between border-r border-gold/15 bg-obsidian-900 lg:flex"
      >
        <div>
          <Link href="/" className="flex items-center gap-3 px-5 py-5" aria-label="Covnant home">
            <CvRibbonMonogram size={36} />
            <span className="font-mono text-sm tracking-[0.3em] text-gold-champagne">
              COVNANT
            </span>
          </Link>
          <div className="gold-rule mx-5 mb-4 opacity-60" />
          <SidebarNav items={WORKSPACE_NAV} />
        </div>
        {/* Flex-spacer zone: the identity surface sits above the tagline, inside
            the bottom-pinned block so the justify-between column keeps its
            two-child rhythm. The live user chip when the provider supplies
            one; the honest unregistered badge otherwise. */}
        <div className="px-5 pb-6">
          <div className="hidden pb-4 lg:block">
            {user ? (
              <ShellUserChip user={user} />
            ) : (
              <IdentityBadge state={{ kind: 'unregistered' }} />
            )}
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/30">
            Own Your Creation.
          </p>
        </div>
      </aside>

      <div className="flex min-h-screen flex-col">
        <header
          data-shell="mobile-top"
          className="border-b border-gold/15 bg-obsidian-900 lg:hidden"
        >
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <Link href="/" aria-label="Covnant home" className="flex items-center gap-2">
              <CvRibbonMonogram size={28} />
              <span className="font-mono text-xs tracking-[0.3em] text-gold-champagne">
                COVNANT
              </span>
            </Link>
            <MobileDrawer items={WORKSPACE_NAV} user={user} />
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="px-6 py-6 text-center text-xs text-white/30">
          © {new Date().getFullYear()} Covnant. Automated Contract Vault &amp; Smart Ledger
          Verification.
        </footer>
      </div>
    </div>
  );
}

/** The sidebar's bottom user chip — initials avatar + stage name, the
 *  reference's quiet account row. A display, not a control. */
function ShellUserChip({ user }: { user: ShellUser }): React.JSX.Element {
  return (
    <span
      data-testid="shell-user-chip"
      className="flex w-full items-center justify-between gap-2.5 rounded-full border border-white/10 px-2 py-1.5"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-gold-champagne/90 via-gold/70 to-gold-deep/90 text-[10px] font-bold text-obsidian"
        >
          {user.initials}
        </span>
        <span className="truncate text-xs text-slate-300">{user.stage_name}</span>
      </span>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3.5 w-3.5 shrink-0 text-white/30"
      >
        <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />
      </svg>
    </span>
  );
}
