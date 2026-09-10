'use client';

/**
 * CreatorIdCard — the dashboard's identity centerpiece (bank reference: the
 * primary account card, ours as the Creator ID). Props-first: the dashboard
 * home renders the anchored state DIRECTLY FROM PROPS — stage name, UCT,
 * issuance facts, provisioning status — with zero fetch dependency; the
 * resolveRenderedCardState degradation keeps a malformed UCT rendering as
 * the honest unregistered state (never a partial or fabricated identity).
 *
 * States:
 *  - unregistered  the visitor/honest empty state (zero fabricated rows)
 *  - anchored      the verified identity, rendered from props only
 *
 * No account or routing numbers exist on this surface, ever — provisioning
 * is a text-labeled status chip only (the bank reference's masked-digit
 * treatment was rejected in the design direction).
 */

import Link from 'next/link';

import { isValidUct } from '@/lib/covnant/uct';
import { PROVISIONING_LABELS, type ProvisioningStatusValue } from './provisioningLabels';

export type CreatorIdCardState =
  | {
      kind: 'anchored';
      stageName: string;
      uct: string;
      status: ProvisioningStatusValue;
      /** ISO issuance timestamp — displayed when present, never invented. */
      uctCreatedAt?: string;
      jurisdiction?: string;
      role?: string;
      /** Only meaningful with status PENDING — the provisioning reason code. */
      reason?: string;
    }
  | { kind: 'unregistered' };

/**
 * Render-state resolution — the display-side degradation rule. An anchored
 * card whose UCT fails the shared engine validator degrades to the
 * unregistered state; everything else renders as received. Corrupt data
 * degrades honestly; it is never fabricated into a plausible identity.
 */
export function resolveRenderedCardState(state: CreatorIdCardState): CreatorIdCardState {
  if (state.kind === 'anchored' && !isValidUct(state.uct)) {
    return { kind: 'unregistered' };
  }
  return state;
}

/** The anchored card's issuance line — the facts that exist, labeled. */
function AnchoredFacts({ state }: { state: Extract<CreatorIdCardState, { kind: 'anchored' }> }): React.JSX.Element {
  const facts: string[] = [];
  if (state.jurisdiction) facts.push(state.jurisdiction);
  if (state.role) facts.push(state.role);
  if (state.uctCreatedAt) {
    const parsed = Date.parse(state.uctCreatedAt);
    if (!Number.isNaN(parsed)) {
      facts.push(
        new Date(parsed).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        }),
      );
    }
  }
  return (
    <div data-testid="card-facts" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
      {facts.length > 0 ? (
        facts.map((fact) => (
          <span key={fact} className="tracking-wide uppercase">
            {fact}
          </span>
        ))
      ) : (
        <span>Verified Covnant identity</span>
      )}
    </div>
  );
}

export function CreatorIdCard({ state }: { state: CreatorIdCardState }): React.JSX.Element {
  const rendered = resolveRenderedCardState(state);

  if (rendered.kind === 'unregistered') {
    return (
      <section
        data-testid="creator-id-card-unregistered"
        className="glass-card p-6 md:p-8"
        aria-label="Creator identity"
      >
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-gold-champagne">
          Covnant Identity
        </p>
        <h2 className="mt-3 text-2xl font-bold text-slate-200 md:text-3xl">
          No identity card yet
        </h2>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-400">
          Register your rights to mint your Creator ID and open your settlement accounts.
        </p>
        <Link
          href="/"
          data-testid="card-register-cta"
          className="mt-5 inline-flex items-center gap-2 rounded-md border border-gold/40 bg-gold/10 px-4 py-2 text-sm font-semibold text-gold-champagne transition-colors hover:bg-gold/20"
        >
          Start registration
        </Link>
      </section>
    );
  }

  return (
    <section
      data-testid="creator-id-card"
      className="glass-card relative overflow-hidden p-6 md:p-8"
      aria-label="Creator identity"
    >
      <div className="flex items-start justify-between gap-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-gold-champagne">
          Covnant Identity
        </p>
        <span
          data-testid="provisioning-chip"
          data-provisioning={rendered.status}
          className={
            rendered.status === 'PROVISIONED'
              ? 'inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-300'
              : 'inline-flex items-center gap-1.5 rounded-full border border-gold/40 bg-gold/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-gold-champagne'
          }
        >
          <span
            aria-hidden="true"
            className={
              rendered.status === 'PROVISIONED'
                ? 'h-1.5 w-1.5 rounded-full bg-emerald-400'
                : 'h-1.5 w-1.5 rounded-full bg-gold'
            }
          />
          {PROVISIONING_LABELS[rendered.status].label}
        </span>
      </div>

      <h2
        data-testid="card-stage-name"
        className="mt-4 bg-gradient-to-r from-gold-champagne via-emerald-200 to-gold bg-clip-text text-3xl font-bold tracking-tight text-transparent md:text-4xl"
      >
        {rendered.stageName}
      </h2>

      <p
        data-testid="card-uct"
        className="mt-3 font-mono text-sm tracking-[0.18em] text-gold-champagne md:text-base"
      >
        {rendered.uct}
      </p>

      <div className="mt-5">
        <AnchoredFacts state={rendered} />
      </div>

      {rendered.status === 'PENDING' ? (
        <p data-testid="provisioning-pending-note" className="mt-4 text-xs leading-relaxed text-slate-400">
          {PROVISIONING_LABELS.PENDING.note}
        </p>
      ) : null}
    </section>
  );
}
