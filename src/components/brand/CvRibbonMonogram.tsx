import type { SVGProps } from 'react';

/**
 * CV ribbon monogram — the Covnant mark. A folded ribbon band carries the
 * "CV" letters in metallic gold over the Obsidian ground, with a champagne
 * highlight running the fold. Geometry is brand-locked: the continuous
 * ribbon never changes, only its finish.
 */
export function CvRibbonMonogram({ size = 96, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      role="img"
      aria-label="Covnant CV ribbon monogram"
      {...props}
    >
      <title>Covnant CV ribbon monogram</title>
      <desc>A folded metallic-gold ribbon band forming the letters CV on an obsidian ground.</desc>
      <defs>
        <linearGradient id="cv-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#F3E5AB" />
          <stop offset="50%" stopColor="#D4AF37" />
          <stop offset="100%" stopColor="#997A15" />
        </linearGradient>
        <linearGradient id="cv-champagne" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#F3E5AB" />
          <stop offset="100%" stopColor="#997A15" />
        </linearGradient>
      </defs>

      {/* Obsidian ground */}
      <rect x="4" y="4" width="112" height="112" rx="24" fill="#08080A" />
      <rect x="4" y="4" width="112" height="112" rx="24" fill="none" stroke="url(#cv-gold)" strokeOpacity="0.6" strokeWidth="1.5" />

      {/* Ribbon band behind the letters */}
      <path d="M22 78 L38 34 L82 34 L98 78 L60 62 Z" fill="url(#cv-gold)" opacity="0.16" />
      <path
        d="M22 78 L38 34 L82 34 L98 78 L60 62 Z"
        fill="none"
        stroke="url(#cv-gold)"
        strokeWidth="2"
        strokeLinejoin="round"
      />

      {/* Champagne fold highlight */}
      <path d="M60 62 L98 78" stroke="url(#cv-champagne)" strokeWidth="2.5" strokeLinecap="round" />

      {/* CV letters */}
      <text
        x="60"
        y="72"
        textAnchor="middle"
        fontSize="34"
        fontWeight="700"
        letterSpacing="2"
        fill="url(#cv-gold)"
        style={{ fontFamily: 'var(--font-geist-sans), sans-serif' }}
      >
        CV
      </text>
    </svg>
  );
}
