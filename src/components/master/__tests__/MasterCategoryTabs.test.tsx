/**
 * @vitest-environment jsdom
 *
 * MasterCategoryTabs — the master-ledger tab bar's semantics (UI audit #11):
 *   - the bar is a role=tablist of role=tab links wired to the page's single
 *     tabpanel (id + aria-controls + aria-labelledby pairing);
 *   - the selected tab is the only tabbable one (roving tabindex);
 *   - ArrowLeft/ArrowRight/Home/End move focus among the tabs (shared
 *     moveTabFocus helper) without navigating — activation stays native
 *     (manual activation: these tabs are real links).
 *
 * jsdom + createRoot/act — Testing Library is NOT used in this repo.
 * next/link is mocked to a plain anchor: the bar's behavior under test is
 * DOM semantics and keyboard focus, not the router.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MASTER_CATEGORY_ORDER,
  MASTER_TAB_PANEL_ID,
  masterTabId,
  type GlobalEntertainmentCategory,
} from '@/lib/master/taxonomy';
import { MasterCategoryTabs } from '@/components/master/MasterCategoryTabs';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

function mountTabs(active: GlobalEntertainmentCategory | null) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MasterCategoryTabs active={active} basePath="/ledger" />);
  });
  mounted.push({ root, container });
  return container;
}

function tabsOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
}

function tabById(container: HTMLElement, category: GlobalEntertainmentCategory | null): HTMLElement {
  // Tab ids are canon constants ([A-Za-z-]+) — no selector escaping needed
  // (jsdom has no CSS global anyway).
  const tab = container.querySelector<HTMLElement>(`#${masterTabId(category)}`);
  if (!tab) throw new Error(`missing tab #${masterTabId(category)}`);
  return tab;
}

/** Dispatch a bubbling, cancelable keydown — how React sees real keystrokes. */
function pressKey(target: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  mounted.length = 0;
});

describe('MasterCategoryTabs semantics', () => {
  it('renders a tablist of one ALL tab plus one tab per canon vertical, wired to the page panel', () => {
    const container = mountTabs(null);
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();
    expect(tablist?.getAttribute('aria-label')).toBe('Master categories');

    const tabs = tabsOf(container);
    expect(tabs).toHaveLength(MASTER_CATEGORY_ORDER.length + 1);
    for (const tab of tabs) {
      expect(tab.getAttribute('aria-controls')).toBe(MASTER_TAB_PANEL_ID);
    }
  });

  it('marks the selected tab with aria-selected and the roving tabindex', () => {
    const allActive = mountTabs(null);
    const selected = tabsOf(allActive).filter((tab) => tab.getAttribute('aria-selected') === 'true');
    const tabbable = tabsOf(allActive).filter((tab) => tab.tabIndex === 0);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(masterTabId(null));
    expect(tabbable).toEqual([selected[0]]);

    document.body.innerHTML = '';
    mounted.length = 0;

    const firstVertical: GlobalEntertainmentCategory = MASTER_CATEGORY_ORDER[0]!;
    const verticalActive = mountTabs(firstVertical);
    const verticalTab = tabById(verticalActive, firstVertical);
    expect(verticalTab.getAttribute('aria-selected')).toBe('true');
    expect(verticalTab.tabIndex).toBe(0);
    expect(tabsOf(verticalActive).filter((tab) => tab.tabIndex === 0)).toEqual([verticalTab]);
    expect(tabById(verticalActive, null).getAttribute('aria-selected')).toBe('false');
  });
});

describe('MasterCategoryTabs keyboard navigation (moveTabFocus)', () => {
  it('ArrowRight/ArrowLeft move focus between tabs and do not navigate', () => {
    const container = mountTabs(null);
    const tabs = tabsOf(container);
    tabs[0]!.focus();

    const right = pressKey(tabs[0]!, 'ArrowRight');
    expect(document.activeElement).toBe(tabs[1]);
    expect(right.defaultPrevented).toBe(true);

    const left = pressKey(tabs[1]!, 'ArrowLeft');
    expect(document.activeElement).toBe(tabs[0]);
    expect(left.defaultPrevented).toBe(true);
  });

  it('Home/End jump to the first and last tab; ArrowRight on the last wraps to the first', () => {
    const container = mountTabs(null);
    const tabs = tabsOf(container);
    tabs[1]!.focus();

    pressKey(tabs[1]!, 'End');
    expect(document.activeElement).toBe(tabs[tabs.length - 1]);

    pressKey(tabs[tabs.length - 1]!, 'ArrowRight');
    expect(document.activeElement).toBe(tabs[0]);

    pressKey(tabs[0]!, 'Home');
    expect(document.activeElement).toBe(tabs[0]);

    pressKey(tabs[0]!, 'ArrowLeft');
    expect(document.activeElement).toBe(tabs[tabs.length - 1]);
  });

  it('ignores non-navigation keys and leaves focus alone when it is outside the tablist', () => {
    const container = mountTabs(null);
    const tabs = tabsOf(container);
    tabs[0]!.focus();

    const other = pressKey(tabs[0]!, 'k');
    expect(document.activeElement).toBe(tabs[0]);
    expect(other.defaultPrevented).toBe(false);

    // A focusable element outside the tablist (as when the user tabs to
    // page content first): the arrow must not hijack focus. jsdom's body
    // is not focusable, so use a real button outside the mounted tree.
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const stray = pressKey(tabs[0]!, 'ArrowRight');
    expect(document.activeElement).toBe(outside);
    expect(stray.defaultPrevented).toBe(false);
  });
});
