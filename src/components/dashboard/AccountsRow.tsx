/**
 * AccountsRow — the dashboard's accounts strip (bank reference: the balance
 * card row). Three glass cards, server-rendered from the verified session
 * aggregate; no client fetch, no interactivity beyond the wired quick
 * actions. On mobile the same DOM becomes a swipeable one-card carousel
 * (scroll-snap; dots from CarouselDots) — first-class, not a shrunken
 * desktop.
 *
 * Honesty rules carried here:
 *  - Provisioning is STATUS ONLY — a text-labeled chip; never numbers.
 *  - Settlements stay per-currency with exact BigInt figures — no float
 *    rollup, no cross-currency sum.
 *  - The workspace card counts real registry artifacts only.
 *  - Every quick action is a wired destination — no dead buttons.
 */

import Link from 'next/link';

import { PROVISIONING_LABELS } from '@/components/brand/provisioningLabels';
import { formatUnitsMajor, formatUnitsMinor, formatUnitsSigned } from '@/lib/money/format';
import type { CovnantMeResponse } from '@/lib/covnant/types';

/** The shared card chassis — glass, gold hairline, aligned to the brand system. */
const CARD_CLASS =
  'glass-card flex min-w-[85%] snap-center flex-col p-5 md:min-w-0 md:p-6';

/** ── Card 1: Virtual Account — escrow balance + provisioning status ── */

export function VirtualAccountCard({ me }: { me: CovnantMeResponse }): React.JSX.Element {
  const provisioned = me.provisioning.status === 'PROVISIONED';
  return (
    <section data-testid="account-card-virtual" className={CARD_CLASS} aria-label="Virtual account">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-300">Virtual account</h3>
        <span
          data-testid="virtual-provisioning-chip"
          data-provisioning={me.provisioning.status}
          className={
            provisioned
              ? 'inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-300'
              : 'inline-flex items-center gap-1.5 rounded-full border border-gold/40 bg-gold/10 px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-gold-champagne'
          }
        >
          <span
            aria-hidden="true"
            className={
              provisioned ? 'h-1.5 w-1.5 rounded-full bg-emerald-400' : 'h-1.5 w-1.5 rounded-full bg-gold'
            }
          />
          {PROVISIONING_LABELS[me.provisioning.status].label}
        </span>
      </div>

      <p className="mt-1 text-xs text-slate-500">Available escrow balance</p>
      <p data-testid="virtual-balance" className="mt-2 text-3xl font-bold tracking-tight text-slate-100 md:text-4xl">
        {formatUnitsMajor(me.settlements.availableEscrowBalance, 'USD')}
      </p>

      <dl className="mt-4 space-y-1 border-t border-gold/15 pt-3 text-xs">
        <div className="flex items-center justify-between gap-4">
          <dt className="text-slate-500">Gross settled</dt>
          <dd data-testid="virtual-gross" className="font-mono text-slate-300">
            {formatUnitsMajor(me.settlements.grossEarnings, 'USD')}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-slate-500">Tax withheld</dt>
          <dd data-testid="virtual-withheld" className="font-mono text-slate-300">
            {formatUnitsSigned(me.settlements.taxWithheld, 'USD')}
          </dd>
        </div>
      </dl>

      {!provisioned ? (
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          {PROVISIONING_LABELS.PENDING.note}
        </p>
      ) : null}
    </section>
  );
}

/** ── Card 2: Settlements — per-currency gross/net, exact figures ── */

export function SettlementsCard({ me }: { me: CovnantMeResponse }): React.JSX.Element {
  const lines = me.settlementsByCurrency;
  return (
    <section data-testid="account-card-settlements" className={CARD_CLASS} aria-label="Settlements">
      <h3 className="text-sm font-semibold text-slate-300">Settlements</h3>
      <p className="mt-1 text-xs text-slate-500">Gross and net, by currency</p>

      {lines.length === 0 ? (
        <p data-testid="settlements-empty" className="mt-4 text-sm leading-relaxed text-slate-400">
          No settlements on the ledger yet.
        </p>
      ) : (
        <dl data-testid="settlements-lines" className="mt-4 space-y-3 border-t border-gold/15 pt-3">
          {lines.map((line) => (
            <div key={line.currency} className="flex items-baseline justify-between gap-4">
              <dt className="font-mono text-xs uppercase tracking-[0.2em] text-gold-champagne">
                {line.currency}
              </dt>
              <dd className="text-right">
                <span data-testid={`settlements-gross-${line.currency}`} className="block font-mono text-sm text-slate-200">
                  {formatUnitsMinor(line.grossUnits, line.currency)}
                </span>
                <span data-testid={`settlements-net-${line.currency}`} className="block font-mono text-xs text-slate-500">
                  net {formatUnitsMinor(line.netUnits, line.currency)}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** ── Card 3: Rights workspace — real registry counts ── */

export function WorkspaceCard({ me }: { me: CovnantMeResponse }): React.JSX.Element {
  return (
    <section data-testid="account-card-workspace" className={CARD_CLASS} aria-label="Rights workspace">
      <h3 className="text-sm font-semibold text-slate-300">Rights workspace</h3>
      <p className="mt-1 text-xs text-slate-500">Your registered catalog</p>

      <div className="mt-4 flex items-baseline gap-6 border-t border-gold/15 pt-3">
        <div>
          <p data-testid="workspace-assets" className="text-3xl font-bold tracking-tight text-slate-100">
            {me.registeredAssets}
          </p>
          <p className="text-xs text-slate-500">Registered assets</p>
        </div>
        <div>
          <p data-testid="workspace-contracts" className="text-3xl font-bold tracking-tight text-slate-100">
            {me.activeContracts}
          </p>
          <p className="text-xs text-slate-500">Contracts</p>
        </div>
      </div>

      <Link
        href="/catalog"
        className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-gold-champagne hover:text-gold"
      >
        Open your catalog
        <span aria-hidden="true">→</span>
      </Link>
    </section>
  );
}

/** ── Quick actions — wired creator destinations only ── */

const QUICK_ACTIONS = [
  { href: '/assets', label: 'Register Asset', hint: 'Add an asset to the registry' },
  { href: '/contracts', label: 'New Contract', hint: 'Generate an agreement from the vault' },
  { href: '/templates', label: 'Browse Templates', hint: 'The deterministic template library' },
] as const;

export function QuickActions(): React.JSX.Element {
  return (
    <nav data-testid="quick-actions" aria-label="Quick actions" className="grid grid-cols-3 gap-3 md:gap-4">
      {QUICK_ACTIONS.map((action) => (
        <Link
          key={action.href}
          href={action.href}
          className="glass-card group flex flex-col gap-1 p-4 transition-colors hover:border-gold/40"
        >
          <span className="text-sm font-semibold text-slate-200 group-hover:text-gold-champagne">
            {action.label}
          </span>
          <span className="text-xs text-slate-500">{action.hint}</span>
        </Link>
      ))}
    </nav>
  );
}
