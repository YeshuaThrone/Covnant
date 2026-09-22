/**
 * /pricing — membership plans.
 *
 * Static luxury marketing view: tiers and feature copy, plus the six-vertical
 * master data coverage strip (founder canon — every admin-tier page hydrates
 * the master taxonomy). No payments integration of any kind — no checkout, no
 * billing call, no payment rails. Enrollment wording is honest: billing
 * arrives in a later release, while registration, agreements, and settlement
 * are open today.
 */

import Link from 'next/link';
import { HeaderActions } from '@/components/workspace/HeaderActions';
import { resolveMasterLedger } from '@/lib/master/masterStore';
import { recordsForCategory } from '@/lib/master/masterStore';
import { formatCents } from '@/lib/money/format';
import {
  MASTER_CATEGORY_ORDER,
  MASTER_CATEGORY_LABELS,
} from '@/lib/master/taxonomy';
import { summarizeSovereignLedger } from '@/lib/master/sovereignLedger';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Membership — Covnant',
};

interface Plan {
  name: string;
  audience: string;
  position: string;
  features: string[];
  cta: { href: string; label: string };
  featured?: boolean;
}

const PLANS: Plan[] = [
  {
    name: 'Creator',
    audience: 'For the individual rights holder',
    position: 'One creator, full ownership, every identifier in one ledger-backed registry.',
    features: [
      'Universal asset registration with CBT keys',
      'Three-pool split engine with 100.0000% gates',
      'Universal registry identifiers — ISRC, ISWC, EIDR',
      'Direct-path settlement with corner-dust accounting',
      'Deterministic agreement generation from the vault',
    ],
    cta: { href: '/assets/new', label: 'Register an asset' },
  },
  {
    name: 'Studio',
    audience: 'For catalogs, labels, and production teams',
    position: 'A working catalog under one roof — agreements, vault, and settlement in stride.',
    features: [
      'Everything in Creator, across a full catalog',
      'Contract vault with draft → final immutability',
      'Asset-of-record hydration for every agreement',
      'Per-holder disbursement detail with tax forms',
      'Ownership ledger with reconciliation audit',
    ],
    cta: { href: '/contracts', label: 'Open the vault' },
    featured: true,
  },
  {
    name: 'Institution',
    audience: 'For rights organizations, guilds, and estates',
    position: 'Governance-grade custody of a rights portfolio at institutional scale.',
    features: [
      'Everything in Studio, governed as one estate',
      'Immutable ledger verification on every surface',
      'Read-only operations console for oversight',
      'Template library across all six master verticals',
      'Audit runner over assets, splits, and settlements',
    ],
    cta: { href: '/templates', label: 'Review the library' },
  },
];

export default async function PricingPage() {
  // The six-vertical coverage strip — the master ledger's live aggregates
  // (demo library in preview, real settled rows otherwise).
  const { demo, records } = await resolveMasterLedger();

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <div className="flex items-center justify-between gap-2.5">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">Membership</p>
        <HeaderActions demo={demo} />
      </div>
      <h1 className="mt-2 text-3xl font-semibold text-white md:text-4xl">
        Own Your Creation. Keep Its Ledger.
      </h1>
      <p className="mt-3 max-w-2xl text-sm text-white/60">
        Membership accompanies the work you already own: a registry that preserves
        identifiers, a vault that renders agreements from the asset of record, and a
        ledger that reconciles to the last minor unit.
      </p>
      <div className="gold-rule my-8" />

      <section aria-label="Master vertical coverage" className="space-y-4">
        <h2 className="font-mono text-xs uppercase tracking-[0.3em] text-white/40">
          One ledger — seven master verticals
        </h2>
        <ul className="grid grid-cols-2 gap-3 lg:grid-cols-3" data-testid="vertical-coverage-strip">
          {MASTER_CATEGORY_ORDER.map((vertical) => {
            const summary = summarizeSovereignLedger(recordsForCategory(records, vertical));
            return (
              <li key={vertical} className="glass-card p-4">
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">
                  {MASTER_CATEGORY_LABELS[vertical]}
                </p>
                <p className="mt-1 font-mono text-sm text-gold">
                  {formatCents(summary.grossVolumeCents)}
                </p>
                <p className="mt-0.5 text-[11px] text-white/40">
                  {summary.recordCount} settled record{summary.recordCount === 1 ? '' : 's'}
                </p>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="gold-rule my-8" />

      <ul className="grid gap-4 md:grid-cols-3" data-testid="plan-list">
        {PLANS.map((plan) => (
          <li key={plan.name}>
            <article
              className={`glass-card flex h-full flex-col p-6 ${
                plan.featured ? 'border-gold/60' : ''
              }`}
              data-testid="plan-card"
            >
              {plan.featured && (
                <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.25em] text-gold">
                  Most chosen
                </p>
              )}
              <h2 className="text-xl font-semibold text-white">{plan.name}</h2>
              <p className="mt-1 text-xs uppercase tracking-wide text-white/40">
                {plan.audience}
              </p>
              <p className="mt-3 text-sm text-white/60">{plan.position}</p>
              <div className="gold-rule my-5 opacity-50" />
              <ul className="flex-1 space-y-2.5">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2 text-sm text-white/70">
                    <span aria-hidden="true" className="mt-0.5 text-gold">
                      ·
                    </span>
                    {feature}
                  </li>
                ))}
              </ul>
              <Link
                href={plan.cta.href}
                className={`mt-6 inline-block rounded-lg border px-4 py-2 text-center text-sm transition ${
                  plan.featured
                    ? 'border-gold/60 bg-gold/10 text-gold-champagne hover:bg-gold/20'
                    : 'border-white/15 text-gold hover:border-gold/50 hover:bg-gold/10'
                }`}
              >
                {plan.cta.label} →
              </Link>
            </article>
          </li>
        ))}
      </ul>

      <p className="mt-8 text-center text-xs text-white/40" data-testid="billing-note">
        Membership enrollment opens with billing in a later release — no payments are
        processed today. Registration, agreements, and settlement are open now.
      </p>
    </main>
  );
}
