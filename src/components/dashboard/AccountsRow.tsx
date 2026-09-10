/**
 * AccountsRow — the dashboard's accounts strip (bank reference: the wide
 * balance-card row). Calm cards, money first: a small title, the balance
 * in large right-aligned type, a small sublabel beneath. One hairline
 * border or subtle glass per card — no badge stacks, no legal copy, no
 * dense tables. On mobile the same DOM becomes a swipeable one-card
 * carousel (scroll-snap; dots from CarouselDots).
 *
 * Honesty rules carried here:
 *  - Provisioning is STATUS ONLY — small quiet text; never numbers, never
 *    a badge stack. When pending, the card shows the honest status line in
 *    place of a balance.
 *  - Settlements stay per-currency with exact BigInt figures — no float
 *    rollup, no cross-currency sum.
 *  - The workspace card counts real registry artifacts only.
 *  - Every quick action is a wired destination — no dead buttons.
 */

import Link from 'next/link';

import { PROVISIONING_LABELS } from '@/components/brand/provisioningLabels';
import { formatUnitsMajor, formatUnitsMinor } from '@/lib/money/format';
import type { CovnantMeResponse } from '@/lib/covnant/types';

/** The calm card chassis — subtle glass, one hairline border. */
const CARD_CLASS =
  'flex min-w-[85%] snap-center flex-col rounded-2xl border border-slate-700/50 bg-white/[0.02] p-5 md:min-w-0 md:p-6';

/** ── Card 1: Virtual Account — big escrow balance or honest status line ── */

export function VirtualAccountCard({ me }: { me: CovnantMeResponse }): React.JSX.Element {
  const provisioned = me.provisioning.status === 'PROVISIONED';
  return (
    <section data-testid="account-card-virtual" className={CARD_CLASS} aria-label="Virtual account">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-slate-400">Virtual Account</h3>
        <span
          data-testid="virtual-status"
          data-provisioning={me.provisioning.status}
          className={
            provisioned
              ? 'font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-300'
              : 'font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne'
          }
        >
          {PROVISIONING_LABELS[me.provisioning.status].label}
        </span>
      </div>

      {provisioned ? (
        <>
          <p
            data-testid="virtual-balance"
            className="mt-6 text-right text-4xl font-semibold tracking-tight text-slate-100 md:mt-8 md:text-5xl"
          >
            {formatUnitsMajor(me.settlements.availableEscrowBalance, 'USD')}
          </p>
          <p className="mt-1 text-right text-xs text-slate-500">Available</p>
        </>
      ) : (
        <p
          data-testid="virtual-balance-pending"
          className="mt-6 text-right text-sm leading-relaxed text-slate-400 md:mt-8"
        >
          Provisioning in progress — your balance appears here once your account is ready.
        </p>
      )}
    </section>
  );
}

/** ── Card 2: Royalty Settlements — primary currency large, rest exact ── */

/**
 * The card's primary (large-type) currency: the largest net balance, with
 * the route's row order as the deterministic tiebreak. The me-route's
 * aggregation order is alphabetical (EUR before USD), which would render
 * a minor currency as the hero figure — the bank grammar leads with the
 * balance that matters most.
 */
function primaryLine(lines: ReadonlyArray<{ currency: string; netUnits: string }>): {
  currency: string;
  netUnits: string;
} {
  return [...lines].sort((a, b) => {
    if (a.netUnits === b.netUnits) return 0;
    return BigInt(a.netUnits) > BigInt(b.netUnits) ? -1 : 1;
  })[0];
}

export function SettlementsCard({ me }: { me: CovnantMeResponse }): React.JSX.Element {
  const lines = me.settlementsByCurrency;
  const primary = lines.length > 0 ? primaryLine(lines) : null;
  return (
    <section
      data-testid="account-card-settlements"
      className={CARD_CLASS}
      aria-label="Royalty settlements"
    >
      <h3 className="text-sm font-medium text-slate-400">Royalty Settlements</h3>

      {lines.length === 0 || primary === null ? (
        <p
          data-testid="settlements-empty"
          className="mt-6 text-right text-sm leading-relaxed text-slate-400 md:mt-8"
        >
          No settlements on the ledger yet.
        </p>
      ) : (
        <>
          <p
            data-testid={`settlements-net-${primary.currency}`}
            className="mt-6 text-right text-4xl font-semibold tracking-tight text-slate-100 md:mt-8 md:text-5xl"
          >
            {formatUnitsMinor(primary.netUnits, primary.currency)}
          </p>
          <p className="mt-1 text-right text-xs text-slate-500">Balance · {primary.currency}</p>

          {/* Remaining currencies stay exact, in small print. */}
          {lines.length > 1 ? (
            <dl
              data-testid="settlements-lines"
              className="mt-4 space-y-1.5 border-t border-slate-700/50 pt-3"
            >
              {lines
                .filter((line) => line.currency !== primary.currency)
                .map((line) => (
                <div key={line.currency} className="flex items-baseline justify-between gap-4">
                  <dt className="font-mono text-[11px] uppercase tracking-[0.2em] text-slate-500">
                    {line.currency}
                  </dt>
                  <dd
                    data-testid={`settlements-gross-${line.currency}`}
                    className="font-mono text-xs text-slate-300"
                  >
                    {formatUnitsMinor(line.grossUnits, line.currency)} gross ·{' '}
                    <span data-testid={`settlements-net-${line.currency}`}>
                      {formatUnitsMinor(line.netUnits, line.currency)}
                    </span>{' '}
                    net
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      )}
    </section>
  );
}

/** ── Card 3: Rights Workspace — real registry counts ── */

export function WorkspaceCard({ me }: { me: CovnantMeResponse }): React.JSX.Element {
  return (
    <section data-testid="account-card-workspace" className={CARD_CLASS} aria-label="Rights workspace">
      <h3 className="text-sm font-medium text-slate-400">Rights Workspace</h3>

      <p
        data-testid="workspace-assets"
        className="mt-6 text-right text-4xl font-semibold tracking-tight text-slate-100 md:mt-8 md:text-5xl"
      >
        {me.registeredAssets}
      </p>
      <p className="mt-1 text-right text-xs text-slate-500">
        Registered assets ·{' '}
        <span data-testid="workspace-contracts" className="font-mono">
          {me.activeContracts}
        </span>{' '}
        contracts
      </p>
    </section>
  );
}

/** ── Quick actions — compact icon tiles, wired destinations only ── */

/** A small stroke icon — the tiles stay calm; no filled art, no emoji. */
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
    href: '/templates',
    label: 'Browse Templates',
    hint: 'The deterministic template library',
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
