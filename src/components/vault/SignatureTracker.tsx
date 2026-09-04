import {
  SIGNATURE_CHIP_CLASSES,
  SIGNATURE_LABELS,
  type SignatureState,
} from '@/lib/contracts/presentation';

/**
 * Digital-signature status tracking display — directive §4.
 *
 * Client-side tracking only: the state map lives in the editor (persisted to
 * localStorage per agreement, never to the server), this panel renders the
 * status table with the design-system chip tones.
 */

export interface SignatureTrackerProps {
  rows: { key: string; name: string; role: string }[];
  states: Record<string, SignatureState>;
  disabled?: boolean;
  onRequest: (key: string) => void;
  onSign: (key: string) => void;
}

export function SignatureTracker({ rows, states, disabled, onRequest, onSign }: SignatureTrackerProps) {
  return (
    <section className="glass-card p-6" aria-label="Digital signature status">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">
        Digital signatures
      </p>

      <table className="mt-4 w-full text-sm" data-testid="signature-status-table">
        <thead>
          <tr className="text-left font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">
            <th className="pb-2 font-normal">Party</th>
            <th className="pb-2 font-normal">Role</th>
            <th className="pb-2 font-normal">Status</th>
            <th className="pb-2 text-right font-normal">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {rows.map((row) => {
            const state = states[row.key] ?? 'NOT_REQUESTED';
            return (
              <tr key={row.key}>
                <td className="py-3 text-white">{row.name}</td>
                <td className="py-3 text-xs text-white/40">{row.role}</td>
                <td className="py-3">
                  <span className={`rounded-full border px-3 py-1 font-mono text-xs ${SIGNATURE_CHIP_CLASSES[state]}`}>
                    {SIGNATURE_LABELS[state]}
                  </span>
                </td>
                <td className="py-3 text-right">
                  {state === 'NOT_REQUESTED' ? (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onRequest(row.key)}
                      className="rounded-lg border border-gold/40 bg-gold/10 px-3 py-1.5 text-xs text-gold hover:bg-gold/20 disabled:opacity-50"
                    >
                      Request signature
                    </button>
                  ) : state === 'REQUESTED' ? (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onSign(row.key)}
                      className="rounded-lg border border-white/20 px-3 py-1.5 text-xs text-white/70 hover:border-white/40 hover:text-white disabled:opacity-50"
                    >
                      Mark signed
                    </button>
                  ) : (
                    <span className="font-mono text-xs text-emerald-300/70">Executed</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
