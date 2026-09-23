'use client';

/**
 * Entity Intelligence — the console's per-entity readout (the tenth tab,
 * 2026-09-22 founder directive: "we need real analytics like the NFL would
 * have on their players"). Where Analytics reads the ONE ledger
 * platform-wide and brand-free, this tab reads it per cleared atomic
 * entity — the four reads over one record:
 *
 *   1. Performance profile — the class record's own telemetry, verbatim.
 *   2. Cleared-flow trend — journal credits grouped by their own
 *      timestamps, newest point first, as gold bars in the house strip
 *      language (slate track, gold gradient fill).
 *   3. Cohort benchmark — the entity's rank inside its atomic class,
 *      integer competition ranking stated as "rank r of n".
 *   4. Valuation vs. production — the canon promised value beside what
 *      actually cleared; a class with no promised-value field in canon
 *      states that honestly and never renders a fabricated figure.
 *
 * Every figure is the store's, delivered by the derivation module
 * (`entityIntelligence.ts` — it owns the math; this component only
 * renders it). `promisedUSD` is whole USD and `cleared` is integer
 * cents; the two only ever meet through the exact ×100 bigint
 * alignment (whole dollars are always exact cents) — never a float.
 * The counterparty boundary holds structurally: entity-level facts a
 * class record legitimately carries (a sponsorship deal's brandPartner)
 * render HERE, on the entity profile; the platform cuts stay brand-free.
 * The demo-data badge discloses the seeded roster; the honest states —
 * the zero-cleared line, the cohort of one, the fail-closed unavailable
 * copy — never render a blank block or a placeholder value.
 */

import { useState } from 'react';
import { formatCentsBigint, formatUsdAmount } from '@/lib/money/format';
import type { EntityIntelligence } from '@/lib/admin/entityIntelligence';
import { SectionEyebrow, SectionUnavailable } from '../shared';
import type { SectionData } from '../types';

/**
 * Trend bar width — the point's integer-percent share of the trend's peak
 * credit (a trend bar charts each point against the chart's scale, the
 * peak — never against the sum, which would render composition, not
 * trend). Bigint numerator over bigint denominator — never a float,
 * never a literal. A nonzero point shows at least a 1% sliver (the
 * platform bars' visibility floor) so small moments stay on the chart.
 */
export function trendBarWidth(creditCents: bigint, peakCreditCents: bigint): number {
  if (peakCreditCents <= 0n || creditCents <= 0n) return 0;
  return Math.max(1, Number((creditCents * 100n) / peakCreditCents));
}

/**
 * The signed bigint-cents voice — the mirror of `formatCentsSigned` at
 * bigint scale: a plus for gains, the true minus (which `formatCentsBigint`
 * carries natively) for shortfalls, and no sign on zero.
 */
export function formatCentsBigintSigned(cents: bigint): string {
  if (cents === 0n) return formatCentsBigint(0n);
  return cents > 0n ? `+${formatCentsBigint(cents)}` : formatCentsBigint(cents);
}

/**
 * The canon whole-USD figure at cents precision — the exact ×100 bigint
 * alignment the derivation's own consumer-comparison test pins. Whole
 * dollars are always exact cents; nothing here divides.
 */
export function formatUsdWholeBigint(usd: bigint): string {
  return formatCentsBigint(usd * 100n);
}

/** Thousands-grouped integer for count telemetry — deterministic, no locale lookup. */
export function groupInteger(value: number): string {
  if (!Number.isInteger(value)) {
    throw new TypeError(`groupInteger requires an integer, received: ${value}`);
  }
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The registered class vocabulary — one label per union arm (a missing arm fails the build here too). */
const CLASS_LABELS: Record<EntityIntelligence['class'], string> = {
  FEATURE_FILM: 'Feature films',
  LINEAR_TV: 'Linear TV',
  MASTER_RECORDING: 'Master recordings',
  PODCAST_NETWORK: 'Podcast networks',
  STAGE_PERFORMANCE: 'Stage performances',
  LITERARY_WORK: 'Literary works',
  ATHLETE_CONTRACT: 'Athlete contracts',
  TOURNAMENT_EVENT: 'Tournament events',
  ESPORTS_STREAM: 'Esports streams',
  SOCIAL_CHANNEL: 'Social channels',
  SPONSORSHIP_DEAL: 'Sponsorship deals',
};

/** The canon promised-value field's own voice, per class that carries one. */
const PROMISED_LABELS: { readonly [C in EntityIntelligence['class']]?: string } = {
  FEATURE_FILM: 'Theatrical gross escrow',
  ATHLETE_CONTRACT: 'Sponsorship guarantee',
  TOURNAMENT_EVENT: 'Prize purse escrow',
  ESPORTS_STREAM: 'Stream monetization yield',
  SPONSORSHIP_DEAL: 'Deal value',
};

function lockedLabel(locked: boolean): string {
  return locked ? 'Locked' : 'Unlocked';
}

function activeLabel(active: boolean): string {
  return active ? 'Active' : 'Inactive';
}

/**
 * The class telemetry profile's rows — the arm's class-specific fields,
 * verbatim from the record. The exhaustive switch is the render side's
 * exhaustiveness pin: a newly registered class without rows here fails
 * the build (the `never` default), the same pattern family as the
 * derivation's arm builder.
 */
function telemetryRows(
  readout: EntityIntelligence,
): readonly { readonly label: string; readonly value: string }[] {
  switch (readout.class) {
    case 'FEATURE_FILM':
      return [
        { label: 'ISAN code', value: readout.isanCode },
        { label: 'Theatrical gross escrow', value: formatUsdWholeBigint(readout.promisedUSD) },
        { label: 'Studio overlay', value: activeLabel(readout.studioOverlayActive) },
      ];
    case 'LINEAR_TV':
      return [
        { label: 'Nielsen flight minutes', value: groupInteger(readout.nielsenFlightMinutes) },
        { label: 'Ad-insertion micro yield', value: formatUsdAmount(readout.adInsertionMicroYieldUSD) },
        { label: 'Syndication reversion', value: lockedLabel(readout.syndicationReversionLock) },
      ];
    case 'MASTER_RECORDING':
      return [
        { label: 'ISRC code', value: readout.isrcCode },
        { label: 'Sub-second micro royalty rate', value: String(readout.subSecondMicroRoyaltyRate) },
        { label: 'PRO telemetry binding', value: readout.proTelemetryBinding },
      ];
    case 'PODCAST_NETWORK':
      return [
        { label: 'Download telemetry', value: groupInteger(readout.downloadCountTelemetry) },
        { label: 'Dynamic ad-insert yield', value: formatUsdAmount(readout.dynamicAdInsertYieldUSD) },
        { label: 'Feed isolation', value: activeLabel(readout.feedIsolationActive) },
      ];
    case 'STAGE_PERFORMANCE':
      return [
        { label: 'Ticket escrow balance', value: formatUsdAmount(readout.ticketEscrowBalanceUSD) },
        { label: 'Promoter instant allocation', value: formatUsdAmount(readout.promoterInstantAllocationUSD) },
        { label: 'House seat clearance', value: lockedLabel(readout.houseSeatClearanceLock) },
      ];
    case 'LITERARY_WORK':
      return [
        { label: 'ISBN', value: readout.isbnNumber },
        { label: 'Print-on-demand yield', value: formatUsdAmount(readout.printOnDemandYieldUSD) },
        { label: 'Citation telemetry', value: groupInteger(readout.citationTelemetryCount) },
      ];
    case 'ATHLETE_CONTRACT':
      return [
        { label: 'Contract id', value: readout.contractId },
        { label: 'Sport', value: readout.sport },
        { label: 'Endorsement exclusivity', value: lockedLabel(readout.endorsementExclusivityLock) },
        { label: 'Sponsorship guarantee', value: formatUsdWholeBigint(readout.promisedUSD) },
      ];
    case 'TOURNAMENT_EVENT':
      return [
        { label: 'Event id', value: readout.eventId },
        { label: 'Discipline', value: readout.discipline },
        { label: 'Payout release', value: lockedLabel(readout.payoutReleaseLock) },
        { label: 'Prize purse escrow', value: formatUsdWholeBigint(readout.promisedUSD) },
      ];
    case 'ESPORTS_STREAM':
      return [
        { label: 'Stream id', value: readout.streamId },
        { label: 'Game', value: readout.game },
        { label: 'Clip licensing', value: lockedLabel(readout.clipLicensingLock) },
        { label: 'Stream monetization yield', value: formatUsdWholeBigint(readout.promisedUSD) },
      ];
    case 'SOCIAL_CHANNEL':
      return [
        { label: 'Platform', value: readout.platform },
        { label: 'Channel id', value: readout.channelId },
        { label: 'Content-match yield', value: formatUsdAmount(readout.contentMatchYieldUSD) },
        { label: 'Monetization review', value: lockedLabel(readout.monetizationReviewLock) },
      ];
    case 'SPONSORSHIP_DEAL':
      return [
        // The counterparty fact the class record legitimately carries —
        // entity-level data, belonging on the entity profile alone.
        { label: 'Brand partner', value: readout.brandPartner },
        { label: 'Campaign id', value: readout.campaignId },
        { label: 'Activation window', value: lockedLabel(readout.activationWindowLock) },
        { label: 'Deal value', value: formatUsdWholeBigint(readout.promisedUSD) },
      ];
    default: {
      // A newly registered class lands HERE at compile time — the build
      // fails until the profile speaks it. Never a silent blank.
      const unregistered: never = readout;
      throw new Error(`IntelligenceSection: no telemetry rows for ${String(unregistered)}`);
    }
  }
}

/** The Revenue Streams strip's honest-state card treatment, shared across the console. */
const STATE_CARD =
  'rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5 text-sm leading-relaxed';

/** The strip card the telemetry and trend rows render in. */
const STRIP_CARD =
  'rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] shadow-[0_12px_40px_-16px_rgba(0,0,0,0.55)] p-5 md:p-6';

/** One gold-rule titled block — the Overview's Revenue Streams rhythm. */
function ProfileBlock({
  testid,
  title,
  description,
  children,
}: {
  testid: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-10" data-testid={testid}>
      <div className="gold-rule w-64" />
      <div className="mt-8 max-w-2xl">
        <SectionEyebrow>{title}</SectionEyebrow>
        <p className="mt-2 text-[13px] leading-relaxed text-white/40">{description}</p>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

const byClearedDesc = (a: EntityIntelligence, b: EntityIntelligence): number =>
  a.cleared > b.cleared ? -1 : a.cleared < b.cleared ? 1 : 0;

/** One class-grouped slice of the cleared roster — entities descending by cleared total. */
export interface IntelligenceRosterGroup {
  readonly class: EntityIntelligence['class'];
  readonly label: string;
  readonly entities: readonly EntityIntelligence[];
}

/**
 * The selector's roster — class-grouped (the atomic class, the same
 * boundary the cohort ranks over), descending by cleared total within
 * class, and the groups themselves led by their strongest entity. A
 * zero-cleared entity sits at its class's tail, still on the roster —
 * the honest zero-cleared state stays reachable.
 */
export function rosterGroups(readouts: readonly EntityIntelligence[]): readonly IntelligenceRosterGroup[] {
  const byClass = new Map<EntityIntelligence['class'], EntityIntelligence[]>();
  for (const readout of readouts) {
    const group = byClass.get(readout.class);
    if (group === undefined) byClass.set(readout.class, [readout]);
    else group.push(readout);
  }
  const groups: IntelligenceRosterGroup[] = [];
  for (const [classArm, members] of byClass) {
    groups.push({ class: classArm, label: CLASS_LABELS[classArm], entities: [...members].sort(byClearedDesc) });
  }
  return groups.sort((a, b) => byClearedDesc(a.entities[0], b.entities[0]));
}

/** The delta's plain voice — exact bigint cents, the direction stated. */
function deltaVerdict(cleared: bigint, promisedCents: bigint): string {
  const delta = cleared - promisedCents;
  if (delta === 0n) return 'Cleared production is exactly at the promised value.';
  return `Cleared production stands ${formatCentsBigint(delta < 0n ? -delta : delta)} ${
    delta < 0n ? 'below' : 'above'
  } the promised value.`;
}

/**
 * The four reads for one entity — the profile the selector drills into.
 * Pure render over the readout the derivation built; every figure is the
 * store's, every honest state drawn.
 */
export function EntityIntelligenceProfile({ readout }: { readout: EntityIntelligence }) {
  const peak = readout.trend.reduce((max, point) => (point.credit > max ? point.credit : max), 0n);
  const promisedCents = readout.promisedUSD === null ? null : readout.promisedUSD * 100n;

  return (
    <div data-testid="intelligence-profile" aria-label="Entity intelligence profile">
      <ProfileBlock
        testid="intelligence-profile-telemetry"
        title="Performance profile"
        description={`${readout.templateId} — the ${CLASS_LABELS[readout.class].toLowerCase()} record's own telemetry, verbatim from the class canon.`}
      >
        <ul className={STRIP_CARD} aria-label="Class telemetry">
          {telemetryRows(readout).map((row) => (
            <li
              key={row.label}
              data-testid="intelligence-telemetry-row"
              className="flex items-center justify-between gap-4 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{row.label}</span>
              <span className="shrink-0 font-mono text-sm text-slate-100">{row.value}</span>
            </li>
          ))}
        </ul>
      </ProfileBlock>

      <ProfileBlock
        testid="intelligence-profile-trend"
        title="Cleared-flow trend"
        description="The entity's journal holder credits grouped by their own timestamps, newest point first — each bar against the trend's peak."
      >
        {readout.trend.length > 0 ? (
          <ul className={STRIP_CARD} aria-label="Cleared-flow trend">
            {readout.trend.map((point) => (
              <li
                key={point.at}
                data-testid="intelligence-trend-point"
                className="flex items-center justify-between gap-4 py-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs text-white/40">{point.at}</span>
                  <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-slate-700/50">
                    <span
                      data-testid="intelligence-trend-bar"
                      className="block h-full rounded-full bg-gradient-to-r from-gold-champagne/80 to-gold/60"
                      style={{ width: `${trendBarWidth(point.credit, peak)}%` }}
                    />
                  </span>
                </span>
                <span className="shrink-0 font-mono text-sm text-slate-100">
                  {formatCentsBigint(point.credit)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p data-testid="intelligence-trend-zero" className={`${STATE_CARD} text-white/40`}>
            Zero cleared to date — the profile stands ready, and the trend draws its first
            point when the entity&apos;s first royalty ingest lands in the ledger. Nothing
            is invented at a fabricated timestamp.
          </p>
        )}
      </ProfileBlock>

      <ProfileBlock
        testid="intelligence-profile-cohort"
        title="Cohort benchmark"
        description={`The entity's cleared total ranked inside its atomic class — against every cleared ${CLASS_LABELS[readout.class].toLowerCase()}, itself included.`}
      >
        <p
          data-testid="intelligence-cohort-rank"
          className={`${STATE_CARD} font-mono text-lg text-gold-champagne`}
        >
          Rank {readout.cohort.rank.toString()} of {readout.cohort.of.toString()}
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-white/40">
          Standard competition ranking in integer bigint — ties share a rank, never a float
          percentage.
        </p>
      </ProfileBlock>

      <ProfileBlock
        testid="intelligence-profile-valuation"
        title="Valuation vs. production"
        description="What the canon promised beside what actually cleared through the 50/35/15 engine — promised whole USD aligned to ledger cents exactly (×100, bigint)."
      >
        {promisedCents === null ? (
          <p data-testid="intelligence-valuation-null" className={`${STATE_CARD} text-white/40`}>
            No promised value in canon for this class — cleared production stands alone,
            never a fabricated comparison.
          </p>
        ) : (
          <>
            <ul className={STRIP_CARD} aria-label="Valuation versus production">
              <li
                data-testid="intelligence-valuation-promised"
                className="flex items-center justify-between gap-4 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
                  Promised — {PROMISED_LABELS[readout.class]}
                </span>
                <span className="shrink-0 font-mono text-sm text-slate-100">
                  {formatCentsBigint(promisedCents)}
                </span>
              </li>
              <li
                data-testid="intelligence-valuation-cleared"
                className="flex items-center justify-between gap-4 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-slate-200">Cleared to date</span>
                <span className="shrink-0 font-mono text-sm text-slate-100">
                  {formatCentsBigint(readout.cleared)}
                </span>
              </li>
              <li
                data-testid="intelligence-valuation-delta"
                className="flex items-center justify-between gap-4 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-slate-200">Delta</span>
                <span className="shrink-0 font-mono text-sm text-slate-100">
                  {formatCentsBigintSigned(readout.cleared - promisedCents)}
                </span>
              </li>
            </ul>
            <p className="mt-2 text-[13px] leading-relaxed text-white/40">
              {deltaVerdict(readout.cleared, promisedCents)}
            </p>
          </>
        )}
      </ProfileBlock>
    </div>
  );
}

function DemoBadge() {
  return (
    <span
      data-testid="demo-data-badge"
      className="inline-flex shrink-0 items-center rounded-full border border-amber-300/40 bg-amber-300/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-amber-300"
    >
      Demo data
    </span>
  );
}

/**
 * The Intelligence tab — the cleared roster's selector, then the selected
 * entity's four-read profile. Opens on the roster leader (the strongest
 * cleared total — a store-derived selection, never a blank first paint);
 * the operator drills into any entity from the class-grouped selector.
 */
export function IntelligenceSection({
  intelligence,
  demo,
}: {
  intelligence: SectionData<readonly EntityIntelligence[]>;
  demo: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const groups = intelligence.kind === 'ready' ? rosterGroups(intelligence.value) : [];
  const leader = groups[0]?.entities[0];
  const selected =
    (selectedId !== null
      ? groups.flatMap((group) => group.entities).find((entity) => entity.templateId === selectedId)
      : undefined) ?? leader;

  return (
    <div aria-label="Entity Intelligence">
      <div className="flex items-center justify-between gap-3">
        <SectionEyebrow>Entity Intelligence</SectionEyebrow>
        {demo ? <DemoBadge /> : null}
      </div>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/50">
        The per-entity readout over the one clearing ledger — the performance profile, the
        cleared-flow trend, the cohort benchmark, and the promised-versus-cleared valuation.
        Every figure is derived from the store at render time; an entity with nothing behind
        it says so.
      </p>
      {intelligence.kind === 'unavailable' ? (
        <div className="mt-8" data-testid="intelligence-unavailable">
          <SectionUnavailable code={intelligence.code} message={intelligence.message} />
        </div>
      ) : groups.length === 0 ? (
        <div className="mt-8">
          <p data-testid="intelligence-roster-empty" className={`${STATE_CARD} text-white/40`}>
            No registered entities to profile yet — the roster fills as atomic entities
            register and clear.
          </p>
        </div>
      ) : (
        <div>
          <div className="mt-8 max-w-2xl" data-testid="intelligence-selector">
            <SectionEyebrow>Cleared roster</SectionEyebrow>
            <p className="mt-2 text-[13px] leading-relaxed text-white/40">
              Every registered atomic entity the ledger knows, class-grouped with the
              strongest cleared total first.
            </p>
            <select
              data-testid="intelligence-entity-selector"
              aria-label="Cleared entity"
              value={selected?.templateId ?? ''}
              onChange={(event) => setSelectedId(event.target.value)}
              className="mt-3 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-gold"
            >
              {groups.map((group) => (
                <optgroup key={group.class} label={group.label}>
                  {group.entities.map((entity) => (
                    <option key={entity.templateId} value={entity.templateId}>
                      {entity.templateId} — {formatCentsBigint(entity.cleared)} cleared
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          {selected === undefined ? null : <EntityIntelligenceProfile readout={selected} />}
        </div>
      )}
    </div>
  );
}
