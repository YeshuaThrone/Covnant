import type { KeyboardEvent } from 'react';

/**
 * Tablist keyboard interaction (WAI-ARIA APG tabs pattern) — shared by the
 * vertical tab bars (MasterCategoryTabs, TemplatesControlBoard). Attach as
 * the tablist's onKeyDown; `currentTarget` is the tablist.
 *
 * ArrowLeft/ArrowRight/Home/End move focus among the tablist's [role="tab"]
 * descendants (roving tabindex — the selected tab is the only tabbable one,
 * set by the component). Activation is deliberately NOT fired here: Enter
 * and Space stay native (links navigate, buttons click), so selection
 * follows activation — manual activation, the APG variant for tabs whose
 * swap reloads/navigates rather than updating in place.
 */
export function moveTabFocus(event: KeyboardEvent<HTMLElement>): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
  );
  if (tabs.length === 0) return;
  const current = tabs.indexOf(document.activeElement as HTMLElement);
  // APG: arrows apply when focus is on a tab (or the tablist itself) — a
  // keydown reaching here with focus elsewhere must not yank focus back.
  if (current === -1) return;
  const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + offset + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next]?.focus();
}
