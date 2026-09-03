/**
 * Universal registry pill — the single presentation surface for asset
 * identifiers (ISRC, ISWC, EIDR, CVT codes…) across the platform. Gold
 * label, champagne mono value, Dark Slate pill on the gold hairline.
 */
export function IdentifierBadge({ label, value }: { label: string; value: string }) {
  return (
    <span className="glass-card inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium tracking-wide">
      <span className="text-gold">{label}</span>
      <span className="font-mono text-gold-champagne">{value}</span>
    </span>
  );
}
