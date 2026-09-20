/**
 * Control Board — the Covnant Control Board as a console section (founder
 * directive, 2026-09-20: "add this to our official admin page"). This is
 * REUSE, not a copy: the exact TemplatesControlBoard the /templates page
 * renders, mounted in local-history mode so the console owns navigation,
 * over the board state the /admin page binds server-side from the same
 * master-store engine as /templates. The section adds only the console
 * header, the store-derived library counts, and the DEMO DATA disclosure.
 */

import type { ControlBoardState } from '@/lib/master/controlBoard';
import { TemplatesControlBoard } from '@/components/master/TemplatesControlBoard';
import { SectionEyebrow } from '../shared';

export function ControlBoardSection({ board }: { board: ControlBoardState }) {
  // Library counts come from the bound board state — the store's numbers,
  // never literals (the honesty law).
  const factoryCount = board.verticals.reduce(
    (total, vertical) => total + vertical.factoryTemplates.length,
    0,
  );
  const atomicCount = board.verticals.reduce(
    (total, vertical) => total + vertical.atomicRecords.length,
    0,
  );

  return (
    <div aria-label="Control Board">
      <div className="flex items-center justify-between gap-3">
        <SectionEyebrow>Covnant Control Board</SectionEyebrow>
        {board.demo ? (
          <span
            data-testid="demo-data-badge"
            className="inline-flex shrink-0 items-center rounded-full border border-amber-300/40 bg-amber-300/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-amber-300"
          >
            Demo data
          </span>
        ) : null}
      </div>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        Atomic Entity Clearing &amp; Real-Time Telemetry Matrix — {factoryCount} contract
        templates and {atomicCount} atomic sector records across the six master
        entertainment verticals, hydrated from the same master store engine as the
        /templates board. Click a vertical to swap the boards below.
      </p>

      <div className="mt-6">
        <TemplatesControlBoard historyMode="local" initial={board} />
      </div>
    </div>
  );
}
