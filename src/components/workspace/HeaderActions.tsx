/**
 * HeaderActions — the shared page-header slot: the DEMO DATA marker (demo
 * doors only) beside the always-visible gold ADMIN pill (the C-directive
 * navigation amendment — Admin lives off the creator nav, reached through
 * this slot, gate-on-click). Both render in the wordmark row of every
 * workspace page header, exactly where the dashboard mounts its own.
 */

import Link from 'next/link';

export function HeaderActions({ demo }: { demo: boolean }) {
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      {demo && (
        <span
          data-testid="demo-data-badge"
          className="inline-flex shrink-0 items-center rounded-full border border-amber-300/40 bg-amber-300/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-amber-300"
        >
          Demo data
        </span>
      )}
      <Link
        data-testid="admin-console-link"
        href="/admin"
        className="inline-flex items-center rounded-full border border-gold/40 bg-gold/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-gold-champagne transition-colors hover:bg-gold/20"
      >
        Admin
      </Link>
    </div>
  );
}
