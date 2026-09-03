import type { ReactNode } from 'react';

/**
 * Gold notification banner — the platform-wide announcement surface.
 * Renders as a champagne-to-gold tinted strip with a solid gold left rule;
 * pairs with the `banner-gold` tokens in globals.css.
 */
export function GoldNotificationBanner({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  /** Optional trailing link/button rendered at the banner's right edge. */
  action?: ReactNode;
}) {
  return (
    <aside role="status" className="banner-gold flex flex-wrap items-center gap-3 px-4 py-3">
      <span
        aria-hidden="true"
        className="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full bg-gold"
      />
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-medium text-gold-champagne">{title}</span>
        {children ? <span className="text-white/70"> — {children}</span> : null}
      </p>
      {action ? <div className="shrink-0 text-sm">{action}</div> : null}
    </aside>
  );
}
