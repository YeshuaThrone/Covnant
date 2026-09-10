import Link from 'next/link';
import { CvRibbonMonogram } from '@/components/brand/CvRibbonMonogram';
import { IdentityBadge, type IdentityState } from '@/components/brand/IdentityBadge';
import { MobileDrawer } from './MobileDrawer';
import { SidebarNav, type NavItem } from './SidebarNav';

/**
 * The nine destinations of the Obsidian workspace shell. Vault routes to
 * the contract vault; Admin is the existing operations console. Later PRs
 * replace the stubbed views in place — the nav is the stable surface.
 */
export const WORKSPACE_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard' },
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
 * Obsidian app shell — fixed sidebar on large screens, drawer navigation on
 * small ones (bank reference: hamburger drawer). Wraps every workspace
 * route via the (workspace) route group; the landing page stays chrome-free.
 *
 * `identity` is the LIVE session identity resolved by the (workspace)
 * layout — the sidebar pill and the mobile drawer render it; when absent
 * (layout could not resolve a session) both surfaces render the honest
 * unregistered state. Navigation structure is unchanged by directive.
 */
export function AppShell({
  children,
  identity = { kind: 'unregistered' },
}: {
  children: React.ReactNode;
  identity?: IdentityState;
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
        {/* Flex-spacer zone: the identity badge sits above the tagline, inside
            the bottom-pinned block so the justify-between column keeps its
            two-child rhythm. Renders the live session identity when present. */}
        <div className="px-5 pb-6">
          <div className="hidden pb-4 lg:block">
            <IdentityBadge state={identity} />
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
            <MobileDrawer items={WORKSPACE_NAV} identity={identity} />
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
