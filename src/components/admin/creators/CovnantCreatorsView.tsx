/**
 * CovnantCreatorsView — the founder-directed Creators View (v2.7.2,
 * signup-aligned per the Signup API Contract art_gOfrFMCA): every card leads
 * with the creator's signup identity, carries the Universal Covnant Tag as a
 * PROMINENT field with its issuance date, and shows missing values honestly
 * ("Not provided" / "Not attributed") instead of inventing them.
 *
 * Purely presentational and data-driven: every value arrives in CreatorCardData.
 * Fields the profile row does not hold (UCT, jurisdiction, engine, issuance
 * state) arrive null until the registry join enriches them — the card never
 * fabricates them.
 *
 * DOB, ISNI, and IPI are deliberately absent: signup never collects them
 * (the v2.7.1 honesty contract).
 */

export interface CreatorCardData {
  legal_name: string;
  stage_name: string;
  email: string;
  phone: string | null;
  core_industry: string;
  title: string | null;
  /** 2-char ISO jurisdiction — registry-resolved, null until joined. */
  jurisdiction: string | null;
  engine: string | null;
  /** The UCT issuance state — PROVISIONED or PENDING; null until resolved. */
  status: 'PROVISIONED' | 'PENDING' | null;
  uct: string | null;
  uctCreatedAt: string | null;
}

const FIELD_LABEL_CLASS = 'font-mono text-[11px] uppercase tracking-[0.2em] text-white/50';
const FIELD_VALUE_CLASS = 'mt-1 text-sm text-white/85';

function StatusPill({ status }: { status: CreatorCardData['status'] }) {
  if (status === null) return null;
  const provisioned = status === 'PROVISIONED';
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.25em] ${
        provisioned
          ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
          : 'border-amber-300/40 bg-amber-300/10 text-amber-300'
      }`}
    >
      {status}
    </span>
  );
}

function CreatorCard({ card }: { card: CreatorCardData }) {
  return (
    <article
      data-testid="creator-card"
      className="rounded-xl border border-white/10 bg-white/[0.03] p-5"
      aria-label={`Creator ${card.stage_name}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-lg font-semibold text-gold">{card.stage_name}</p>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-gold-champagne/80">
            {card.legal_name}
          </p>
        </div>
        <StatusPill status={card.status} />
      </div>

      <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <div>
          <dt className={FIELD_LABEL_CLASS}>Email</dt>
          <dd className={FIELD_VALUE_CLASS}>{card.email}</dd>
        </div>
        <div>
          <dt className={FIELD_LABEL_CLASS}>Phone</dt>
          <dd className={FIELD_VALUE_CLASS}>{card.phone ?? 'Not provided'}</dd>
        </div>
        <div>
          <dt className={FIELD_LABEL_CLASS}>Core industry</dt>
          <dd className={FIELD_VALUE_CLASS}>{card.core_industry}</dd>
        </div>
        <div>
          <dt className={FIELD_LABEL_CLASS}>Title</dt>
          <dd className={FIELD_VALUE_CLASS}>{card.title ?? 'Not provided'}</dd>
        </div>
        <div>
          <dt className={FIELD_LABEL_CLASS}>Jurisdiction</dt>
          <dd className={FIELD_VALUE_CLASS}>{card.jurisdiction ?? 'Not attributed'}</dd>
        </div>
        <div>
          <dt className={FIELD_LABEL_CLASS}>Engine</dt>
          <dd className={FIELD_VALUE_CLASS}>{card.engine ?? 'Not attributed'}</dd>
        </div>
      </dl>

      {/* The creator-root identity — prominent, never a footer footnote. */}
      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-gold/25 bg-obsidian-950/60 px-4 py-3">
        <p className={FIELD_LABEL_CLASS}>Universal Covnant Tag</p>
        {card.uct ? (
          <p className="font-mono text-sm font-semibold text-gold-champagne">
            {card.uct}
            {card.uctCreatedAt ? (
              <span className="ml-3 text-xs font-normal text-white/40">
                issued {card.uctCreatedAt.slice(0, 10)}
              </span>
            ) : null}
          </p>
        ) : (
          <p className="font-mono text-sm text-white/40">Not yet on file</p>
        )}
      </div>
    </article>
  );
}

export function CovnantCreatorsView({ cards }: { cards: CreatorCardData[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2" data-testid="creators-view">
      {cards.map((card) => (
        <CreatorCard key={card.legal_name + card.stage_name} card={card} />
      ))}
    </div>
  );
}
