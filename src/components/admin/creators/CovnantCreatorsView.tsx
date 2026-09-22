/**
 * CovnantCreatorsView — the founder-directed Creators View (v2.7.2,
 * signup-aligned per the Signup API Contract art_gOfrFMCA): every card leads
 * with the creator's signup identity, carries the Universal Covnant Tag as the
 * PROMINENT top-right identity chip with its issuance date (founder direction
 * 2026-09-22: the UCT lives in the issuance slot where the status pill used to
 * sit), and shows missing values honestly
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

/**
 * The issuance slot — the card's top-right corner, where the UCT lives
 * (founder direction 2026-09-22). A provisioned UCT renders as the gold
 * identity chip with its issuance date; a pending creator shows the honest
 * "UCT pending" ghost so the slot never lies or sits empty without cause.
 */
function UctChip({ card }: { card: CreatorCardData }) {
  if (card.uct) {
    return (
      <div
        data-testid="uct-chip"
        className="shrink-0 rounded-lg border border-gold/30 bg-obsidian-950/60 px-3 py-1.5 text-right"
      >
        <p className="font-mono text-sm font-semibold text-gold-champagne">{card.uct}</p>
        {card.uctCreatedAt ? (
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">
            issued {card.uctCreatedAt.slice(0, 10)}
          </p>
        ) : null}
      </div>
    );
  }
  if (card.status === 'PENDING') {
    return (
      <span
        data-testid="uct-chip-pending"
        className="inline-flex shrink-0 items-center rounded-full border border-amber-300/25 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.25em] text-amber-300/70"
      >
        UCT pending
      </span>
    );
  }
  return null;
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
        <UctChip card={card} />
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

      {/* Issuance state — always explicit, never a footer footnote. */}
      {card.status ? (
        <div className="mt-4 flex items-center justify-start">
          <StatusPill status={card.status} />
        </div>
      ) : null}
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
