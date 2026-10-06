'use client';

/**
 * MasterCategoryTabs — the seven-vertical tab bar of the master-ledger
 * surfaces. Extracted from MasterData so the keyboard interaction can be
 * client-side while every host page stays a server component; MasterData
 * re-exports this, so import sites are unchanged.
 *
 * Tab semantics (UI audit #11): roving tabindex (the selected tab is the
 * only tabbable one), ArrowLeft/ArrowRight/Home/End move focus among the
 * tabs, and activation stays native — these are real links, Enter navigates
 * (manual activation: an arrow stop must not fire a full page navigation).
 * Panels: hosts tag their content wrapper with role="tabpanel" +
 * aria-labelledby={masterTabId(active)} (helpers in lib/master/taxonomy).
 */

import Link from 'next/link';
import {
  MASTER_CATEGORY_LABELS,
  MASTER_CATEGORY_ORDER,
  MASTER_TAB_PANEL_ID,
  masterTabId,
  type GlobalEntertainmentCategory,
} from '@/lib/master/taxonomy';
import { moveTabFocus } from '@/lib/a11y/tabKeyboard';

/** The shared vertical-tab pill treatment — identical across both hosts. */
function pillClasses(active: boolean): string {
  return `rounded-full border px-4 py-1.5 text-sm transition ${
    active
      ? 'border-gold/60 bg-gold/10 text-gold'
      : 'border-white/10 text-white/60 hover:border-white/25 hover:text-white'
  }`;
}

/** The seven-vertical tab bar — `null` active = ALL. */
export function MasterCategoryTabs({
  active,
  basePath,
}: {
  active: GlobalEntertainmentCategory | null;
  basePath: string;
}): React.JSX.Element {
  const tabHref = (category: GlobalEntertainmentCategory | null) =>
    category ? `${basePath}?category=${category}` : basePath;
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="tablist"
      aria-label="Master categories"
      onKeyDown={moveTabFocus}
    >
      <Link
        href={tabHref(null)}
        id={masterTabId(null)}
        role="tab"
        aria-selected={active === null}
        aria-controls={MASTER_TAB_PANEL_ID}
        tabIndex={active === null ? 0 : -1}
        className={pillClasses(active === null)}
      >
        All verticals
      </Link>
      {MASTER_CATEGORY_ORDER.map((category) => (
        <Link
          key={category}
          href={tabHref(category)}
          id={masterTabId(category)}
          role="tab"
          aria-selected={active === category}
          aria-controls={MASTER_TAB_PANEL_ID}
          tabIndex={active === category ? 0 : -1}
          className={pillClasses(active === category)}
        >
          {MASTER_CATEGORY_LABELS[category]}
        </Link>
      ))}
    </div>
  );
}
