/**
 * Pill badge for universal asset identifiers (ISRC, ISWC, EIDR, CVT codes…).
 * Used as the single presentation surface for registry codes across the
 * platform, per the production build spec.
 */
export function IdentifierBadge({ label, value }: { label: string; value: string }) {
  return (
    <span className="glass-card inline-flex items-center gap-2 px-3 py-1 text-xs font-medium tracking-wide">
      <span className="text-[#00C8FF]">{label}</span>
      <span className="text-[#FFD700] font-mono">{value}</span>
    </span>
  );
}
