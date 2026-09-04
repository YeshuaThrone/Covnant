import type { AutoFillSummary } from '@/lib/contracts/presentation';

/**
 * Auto-filled from the asset of record — directive §4.
 *
 * Renders exactly what the stored asset carries: legal names, roles, exact
 * percentage splits, registry identifiers, and holder ISNI/IPI numbers.
 * Absent profile data shows "To be completed" — the panel never fabricates.
 */

export function AutoFillPanel({ summary }: { summary: AutoFillSummary }) {
  return (
    <section className="glass-card p-6" aria-label="Auto-filled from asset of record">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">
        Auto-filled from the asset of record
      </p>
      <p className="mt-2 text-sm text-white/50">
        Mapped deterministically from <span className="text-white/70">{summary.work.title}</span>{' '}
        ({summary.work.mediumLabel}) — no manual entry, nothing invented.
      </p>

      <dl className="mt-4 flex flex-wrap gap-2" aria-label="Work identifiers">
        {summary.identifiers.map((field) => (
          <div
            key={field.label}
            className={`rounded-full border px-3 py-1 font-mono text-xs ${
              field.toBeCompleted ? 'border-white/20 text-white/40 italic' : 'border-gold/30 text-[#FFD700]'
            }`}
          >
            <span className="mr-1.5 text-white/40">{field.label}</span>
            {field.value}
          </div>
        ))}
      </dl>

      <ul className="mt-4 divide-y divide-white/10" aria-label="Parties and splits">
        {summary.parties.map((party) => (
          <li key={`${party.name}::${party.role}`} className="flex items-start justify-between gap-4 py-3">
            <div>
              <p className="text-sm text-white">{party.name}</p>
              <p className="mt-0.5 text-xs text-white/40">{party.role}</p>
              <p className="mt-1 flex flex-wrap gap-x-3 font-mono text-[11px]">
                {party.identifiers.map((id) => (
                  <span key={id.label} className={id.toBeCompleted ? 'text-white/35 italic' : 'text-white/50'}>
                    {id.label}: {id.value}
                  </span>
                ))}
              </p>
            </div>
            <span className="font-mono text-sm text-[#FFD700]">
              {party.sharePercent ? `${party.sharePercent}%` : 'Multi-pool'}
            </span>
          </li>
        ))}
      </ul>

      {summary.pools.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-white/10 pt-4" aria-label="Recorded pools">
          {summary.pools.map((pool) => (
            <p key={pool.label} className="flex items-center justify-between gap-4 text-xs">
              <span className="text-white/50">{pool.label}</span>
              <span className="font-mono text-white/40">
                {pool.holders.map((h) => `${h.name} ${h.sharePercent}%`).join(' · ')}{' '}
                <span className="text-[#FFD700]">= {pool.totalPercent}%</span>
              </span>
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
