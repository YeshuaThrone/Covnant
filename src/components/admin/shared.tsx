/**
 * Admin console presentation primitives — the shared integrity-state
 * pills (jade = verified/active/provisioned, amber = pending, red =
 * rejected/revoked, neutral = unstarted/unknown) and the honest
 * section-unavailable state. Consistency here is the point: a state must
 * read identically in every console section.
 */

/** Which integrity family a pill belongs to — drives the color treatment. */
export type PillTone = 'jade' | 'amber' | 'red' | 'neutral';

const PILL_CLASS: Record<PillTone, string> = {
  jade: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
  amber: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  red: 'border-red-400/40 bg-red-400/10 text-red-300',
  neutral: 'border-white/15 bg-white/5 text-white/45',
};

export function StatusPill({ label, tone }: { label: string; tone: PillTone }) {
  return (
    <span className={`inline-block rounded-full border px-2.5 py-0.5 font-mono text-[11px] tracking-wider ${PILL_CLASS[tone]}`}>
      {label}
    </span>
  );
}

/**
 * A read-only value pill — every non-editable field gets one, so the
 * operator always sees WHY a value cannot be touched, not just that the
 * control is missing.
 */
export function ReadOnlyChip() {
  return (
    <span className="ml-2 inline-block rounded-full border border-gold/25 bg-gold/5 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">
      Read-only
    </span>
  );
}

/** Honest off-happy-path state for a section whose store cannot answer. */
export function SectionUnavailable({ code, message }: { code: string; message: string }) {
  return (
    <div className="glass-card p-6" role="status">
      <p className="font-mono text-xs uppercase tracking-[0.25em] text-amber-300">
        Section unavailable
      </p>
      <p className="mt-2 text-sm text-white/60">{message}</p>
      <p className="mt-2 font-mono text-xs text-white/30">{code}</p>
    </div>
  );
}

/** Shared empty-state line for a section with zero rows. */
export function SectionEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="glass-card p-6 text-sm text-white/50" role="status">
      {children}
    </div>
  );
}

/** Section eyebrow — champagne statement treatment, shared across sections. */
export function SectionEyebrow({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold-champagne">{children}</p>;
}
