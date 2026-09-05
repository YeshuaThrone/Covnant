import type { SVGProps } from 'react';

/**
 * CV ribbon monogram — the Covnant mark. One bold continuous ribbon draws a
 * "C" that sweeps into a "V": the C opens at its upper-right terminal, arcs
 * counterclockwise over a white-hot crown, curls inward at the bottom with a
 * rounded hook, and the stroke crosses over itself into the V's descending
 * diagonal, turns at the vertex, and rises to an upper-right rounded terminal.
 * Gold deepens along the ribbon (champagne crown → dark tail) and the
 * crossing renders lighter through translucent overlap, mirroring the brand
 * reference. Geometry is brand-locked: the continuous ribbon never changes,
 * only its finish.
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
      <desc>
        A bold continuous gold ribbon forming a C that sweeps into a V — bright
        champagne at the crown deepening to dark gold at the V tail, with a
        lighter translucent overlap where the stroke crosses itself.
      </desc>
      <defs>
        {/* C stroke: white-hot crown deepening down and around the ring */}
        <linearGradient id="cv-ribbon-crown" gradientUnits="userSpaceOnUse" x1="66" y1="9" x2="66" y2="100">
          <stop offset="0" stopColor="#FFF6D8" />
          <stop offset="0.22" stopColor="#F3E5AB" />
          <stop offset="0.55" stopColor="#D4AF37" />
          <stop offset="1" stopColor="#BE9727" />
        </linearGradient>
        {/* V stroke: metallic gold deepening along the stroke to the tail */}
        <linearGradient id="cv-ribbon-tail" gradientUnits="userSpaceOnUse" x1="47" y1="26" x2="91" y2="29">
          <stop offset="0" stopColor="#D4AF37" />
          <stop offset="1" stopColor="#997A15" />
        </linearGradient>
      </defs>

      {/* C: upper-right terminal, counterclockwise arc, inward hook at the bottom */}
      <path
        d="M 70 19.2 A 38 38 0 1 0 76.5 93.5 C 82 90 72 79 58 84"
        fill="none"
        stroke="url(#cv-ribbon-crown)"
        strokeWidth={22.5}
        strokeLinecap="round"
        opacity={0.88}
      />

      {/* V: descending diagonal crosses the C band, turns at the vertex, rises to the tail */}
      <path
        d="M 45 22 L 67 101 L 91 29"
        fill="none"
        stroke="url(#cv-ribbon-tail)"
        strokeWidth={22.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.88}
      />
    </svg>
  );
}
