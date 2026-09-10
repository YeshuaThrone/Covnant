'use client';

/**
 * CarouselDots — the mobile accounts carousel's position indicator. The
 * accounts row is a CSS scroll-snap carousel below the md breakpoint (one
 * card + swipe); these dots track the snap position via the container's
 * scroll event and stay in sync with programmatic taps (a dot tap scrolls
 * the matching card into view). Pure enhancement: swiping works with or
 * without this component attached.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export function CarouselDots({
  containerId,
  count,
}: {
  containerId: string;
  count: number;
}): React.JSX.Element | null {
  const [active, setActive] = useState(0);
  const rafRef = useRef(0);

  const handleScroll = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const container = document.getElementById(containerId);
      if (!container) return;
      const card = container.firstElementChild;
      if (!(card instanceof HTMLElement)) return;
      const step = card.offsetWidth + 16; // card + the row's gap-4
      if (step <= 0) return;
      setActive(Math.min(count - 1, Math.max(0, Math.round(container.scrollLeft / step))));
    });
  }, [containerId, count]);

  useEffect(() => {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      cancelAnimationFrame(rafRef.current);
    };
  }, [containerId, handleScroll]);

  if (count <= 1) return null;

  return (
    <div data-testid="carousel-dots" className="mt-3 flex items-center justify-center gap-2 md:hidden" role="tablist" aria-label="Account cards">
      {Array.from({ length: count }, (_, index) => (
        <button
          key={index}
          type="button"
          role="tab"
          aria-selected={index === active}
          aria-label={`Account card ${index + 1} of ${count}`}
          onClick={() => {
            const container = document.getElementById(containerId);
            const card = container?.children[index];
            card?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
          }}
          className={
            index === active
              ? 'h-1.5 w-6 rounded-full bg-gold transition-all'
              : 'h-1.5 w-1.5 rounded-full bg-slate-600 transition-all'
          }
        />
      ))}
    </div>
  );
}
