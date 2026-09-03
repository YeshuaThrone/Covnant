/**
 * Verification badge set — the platform's verification states as a single
 * presentation surface. The active state ("Immutable Ledger Active") carries
 * the Emerald Gold gradient (#10B981 → #D4AF37), reserved exclusively for
 * active verification; supporting states are hairline tints.
 */

export type VerificationVariant = 'pre-reconciled' | 'audited' | 'immutable-ledger-active';

const VARIANT_LABELS: Record<VerificationVariant, string> = {
  'pre-reconciled': 'Pre-Reconciled',
  audited: 'Audited',
  'immutable-ledger-active': 'Immutable Ledger Active',
};

const VARIANT_STYLES: Record<VerificationVariant, string> = {
  // Muted gold hairline — reconciliation is pending state, not active proof.
  'pre-reconciled': 'border-gold/40 text-gold-champagne',
  // Emerald hairline — the auditor ran clean.
  audited: 'border-emerald-400/40 text-emerald-300',
  // Emerald Gold gradient — the ledger is live and immutable.
  'immutable-ledger-active': 'badge-verification-active font-semibold',
};

export function VerificationBadge({
  variant,
  label,
}: {
  variant: VerificationVariant;
  /** Override the default label (e.g. "FINAL — immutable"). */
  label?: string;
}) {
  return (
    <span
      data-verification={variant}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs tracking-wide ${VARIANT_STYLES[variant]}`}
    >
      {label ?? VARIANT_LABELS[variant]}
    </span>
  );
}
