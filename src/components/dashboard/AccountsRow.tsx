/**
 * AccountsRow — the dashboard's accounts strip (bank reference: the wide
 * balance-card row). Calm cards, money first: a small title, the balance in
 * large right-aligned type, a small sublabel beneath. One glass card per
 * bucket. On mobile the same DOM becomes a swipeable one-card carousel
 * (scroll-snap; dots from CarouselDots).
 *
 * The three cards ARE the holder's three vault buckets (SovereignVaultRecord
 * semantics — integer cents, never floats): available, pending, reserve.
 * Payout tiles reflect the sandbox rail (RTP instant, ACH +3 business days)
 * over PayoutHoldRecord-shaped fixtures. Quick actions are visual
 * affordances wired to REAL workspace destinations — no invented routes.
 *
 * Honesty rules carried here:
 *  - Balances render from the vault record only — no fabricated zero-fill.
 *  - The account-number ban: nothing resembling an account or routing
 *    number is ever rendered.
 *  - Every quick action is a wired destination; payout tiles are state
 *    displays, not dead links.
 */

import Link from 'next/link';

import { formatCents } from '@/lib/money/format';
import type { PayoutTile } from '@/lib/don/dashboardFixtures';
import type { SovereignVaultRecord } from '@/modules/don/records';

/** The calm card chassis — REAL glass presence: the bank reference's cards
 *  are the dominant visual field (high-contrast rounded rectangles), so the
 *  card carries a visible two-stop glass fill, a true hairline, and a soft
 *  elevation shadow. Quiet content on a card that actually reads. */
const CARD_CLASS =
  'flex min-w-[85%] snap-center flex-col rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.07] to-white/[0.02] shadow-[0_12px_40px_-16px_rgba(0,0,0,0.55)] p-5 md:min-w-0 md:p-6';

/** The shared balance typography — large, right-aligned, money first. */
const BALANCE_CLASS =
  'mt-6 text-right text-4xl font-semibold tracking-tight text-slate-100 md:mt-8 md:text-5xl';
const SUBLABEL_CLASS = 'mt-1 text-right text-xs text-slate-500';

/** ── The three account cards — the holder's three vault buckets ── */

function BucketCard({
  testId,
  title,
  balanceCents,
  sublabel,
  ariaLabel,
}: {
  testId: string;
  title: string;
  balanceCents: number;
  sublabel: string;
  ariaLabel: string;
}): React.JSX.Element {
  return (
    <section data-testid={testId} className={CARD_CLASS} aria-label={ariaLabel}>
      <h3 className="text-sm font-medium text-slate-400">{title}</h3>
      <p data-testid={`${testId}-balance`} className={BALANCE_CLASS}>
        {formatCents(balanceCents)}
      </p>
      <p className={SUBLABEL_CLASS}>{sublabel}</p>
    </section>
  );
}

export function VaultBucketCards({ vault }: { vault: SovereignVaultRecord }): React.JSX.Element {
  return (
    <>
      <BucketCard
        testId="account-card-available"
        title="Available"
        balanceCents={vault.available_balance}
        sublabel="Spendable now"
        ariaLabel="Available balance"
      />
      <BucketCard
        testId="account-card-pending"
        title="Pending"
        balanceCents={vault.pending_balance}
        sublabel="Awaiting release or settlement"
        ariaLabel="Pending balance"
      />
      <BucketCard
        testId="account-card-reserve"
        title="Reserve"
        balanceCents={vault.reserve_balance}
        sublabel="Held — disputes & withholding"
        ariaLabel="Reserve balance"
      />
    </>
  );
}

/** ── Payout tiles — the sandbox rail's in-flight payouts ── */

function PayoutIcon({ d }: { d: string }): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
    >
      <path d={d} />
    </svg>
  );
}

/** Lightning bolt — RTP instant. Clock — ACH batch. */
const RAIL_ICONS: Record<PayoutTile['rail'], string> = {
  rtp: 'M13 2 4.5 13.5H11L9.5 22 19.5 9.5H12.5L13 2Z',
  ach: 'M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
};

/** A payout tile: rail, in-flight amount, honest ETA — a state display,
 *  NOT a link (no invented routes; the ledger carries the real history). */
export function PayoutRailTiles({ tiles }: { tiles: PayoutTile[] }): React.JSX.Element | null {
  if (tiles.length === 0) return null;
  return (
    <div
      data-testid="payout-tiles"
      className="grid grid-cols-2 gap-3 md:gap-4"
      aria-label="Payouts in flight"
    >
      {tiles.map((tile) => (
        <div
          key={`${tile.rail}-${tile.amount_cents}-${tile.status}`}
          data-testid="payout-tile"
          data-rail={tile.rail}
          data-status={tile.status}
          title={`Payout via ${tile.rail_label} — ${tile.eta_label}`}
          className="flex items-center gap-3 rounded-2xl border border-slate-700/50 bg-white/[0.02] p-4"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-700/50 bg-white/[0.02] text-gold-champagne">
            <PayoutIcon d={RAIL_ICONS[tile.rail]} />
          </span>
          <span className="min-w-0">
            <span data-testid="payout-tile-rail" className="block text-xs font-medium text-slate-300">
              {tile.rail_label} · {tile.eta_label}
            </span>
            <span data-testid="payout-tile-amount" className="block font-mono text-sm text-slate-100">
              {formatCents(tile.amount_cents)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** ── Quick actions — compact icon tiles, wired destinations only ── */

function ActionIcon({ d }: { d: string }): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
    >
      <path d={d} />
    </svg>
  );
}

const QUICK_ACTIONS = [
  {
    href: '/assets',
    label: 'Register Asset',
    hint: 'Add an asset to the registry',
    // Plus inside a rounded square.
    icon: 'M12 9v6m-3-3h6M7 21h10a2 2 0 0 0 2-2V7l-4-4H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2Z',
  },
  {
    href: '/contracts',
    label: 'New Contract',
    hint: 'Generate an agreement from the vault',
    // Document with lines.
    icon: 'M14 3v4a1 1 0 0 0 1 1h4M9 13h6m-6 4h6M8 21h8a2 2 0 0 0 2-2V8l-5-5H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2Z',
  },
  {
    href: '/ledger',
    label: 'View Ledger',
    hint: 'The full royalty picture',
    // Layered grid.
    icon: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13ZM4 10h16M10 10v10',
  },
] as const;

export function QuickActions(): React.JSX.Element {
  return (
    <nav
      data-testid="quick-actions"
      aria-label="Quick actions"
      className="grid grid-cols-3 gap-3 md:gap-4"
    >
      {QUICK_ACTIONS.map((action) => (
        <Link
          key={action.href}
          href={action.href}
          data-testid="quick-action"
          title={action.hint}
          aria-label={`${action.label} — ${action.hint}`}
          className="group flex flex-col items-center gap-2 rounded-2xl border border-transparent px-2 py-4 transition-colors hover:border-slate-700/50 hover:bg-white/[0.02]"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-700/50 bg-white/[0.02] text-gold-champagne transition-colors group-hover:border-gold/40 group-hover:text-gold">
            <ActionIcon d={action.icon} />
          </span>
          <span className="text-center text-[11px] font-medium text-slate-400 group-hover:text-slate-200">
            {action.label}
          </span>
        </Link>
      ))}
    </nav>
  );
}
