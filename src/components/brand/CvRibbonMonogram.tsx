import Image from 'next/image';

/**
 * CV ribbon monogram — the Covnant mark, shipped as the metallic gold
 * render (public/cv-gold-ribbon.png, 783x517, transparent). The mark is
 * WIDE: height tracks `size` and width derives from the natural aspect
 * ratio (~1.514), never square-cropped or squashed.
 *
 * Presentation follows the brand mockup: compact instances (size < 48 —
 * landing header, sidebar) sit in a rounded obsidian chip with a thin
 * gold border; the hero instance (size >= 48) renders bare on the page
 * background. The render itself never changes — only its treatment.
 */
const MARK_ASPECT_RATIO = 783 / 517;
/** Compact marks get the chip treatment; larger ones render bare. */
const CHIP_SIZE_THRESHOLD = 48;

export function CvRibbonMonogram({ size = 96 }: { size?: number }) {
  const alt = 'Covnant CV ribbon monogram — a metallic gold ribbon drawing a C sweeping into a V';

  if (size < CHIP_SIZE_THRESHOLD) {
    const padding = Math.round(size * 0.18);
    const innerWidth = size - padding * 2;
    const innerHeight = Number((innerWidth / MARK_ASPECT_RATIO).toFixed(2));
    return (
      <span
        className={`inline-flex items-center justify-center border border-gold/40 bg-obsidian-900 ${
          size >= 32 ? 'rounded-xl' : 'rounded-lg'
        }`}
        style={{ width: size, height: size, padding }}
      >
        <Image
          src="/cv-gold-ribbon.png"
          alt={alt}
          title="Covnant CV ribbon monogram"
          width={innerWidth}
          height={innerHeight}
          priority
          data-monogram
        />
      </span>
    );
  }

  return (
    <Image
      src="/cv-gold-ribbon.png"
      alt={alt}
      title="Covnant CV ribbon monogram"
      width={Number((size * MARK_ASPECT_RATIO).toFixed(2))}
      height={size}
      priority
      data-monogram
    />
  );
}
