/**
 * @vitest-environment jsdom
 *
 * useDialogA11y + MobileDrawer — the modal-dialog semantics (UI audit #12):
 *   - on open, the dialog element itself receives focus;
 *   - Tab and Shift+Tab cycle within the dialog (focus trap);
 *   - Escape calls onClose;
 *   - on close, focus returns to the element that held it before opening
 *     (the drawer's hamburger).
 *
 * jsdom + createRoot/act — Testing Library is NOT used in this repo.
 * The hook is exercised through a minimal client harness that mirrors the
 * drawer's wiring (ref + tabIndex + role/aria on the dialog element), then
 * through the real MobileDrawer (next/link mocked to a plain anchor).
 */

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDialogA11y } from '@/components/shell/useDialogA11y';
import { MobileDrawer } from '@/components/shell/MobileDrawer';
import type { NavItem } from '@/components/shell/SidebarNav';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

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

function mount(ui: React.ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  mounted.push({ root, container });
  return container;
}

function pressKey(target: Element, key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, shiftKey });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function click(element: HTMLElement): void {
  act(() => {
    element.click();
  });
}

/** Minimal client harness mirroring the drawer's exact hook wiring. */
function HarnessDialog({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const dialogRef = useDialogA11y(open, () => {
    onClose();
    setOpen(false);
  });
  return (
    <div>
      <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
        open
      </button>
      {open && (
        <div
          ref={dialogRef}
          tabIndex={-1}
          data-testid="dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Test dialog"
        >
          <button type="button" data-testid="first">
            first
          </button>
          <button type="button" data-testid="second">
            second
          </button>
          <button type="button" data-testid="last">
            last
          </button>
        </div>
      )}
    </div>
  );
}

describe('useDialogA11y (dialog harness)', () => {
  it('moves focus to the dialog element when it opens', () => {
    const container = mount(<HarnessDialog onClose={() => {}} />);
    const trigger = container.querySelector<HTMLElement>('[data-testid="trigger"]')!;
    trigger.focus();
    click(trigger);

    const dialog = container.querySelector<HTMLElement>('[data-testid="dialog"]');
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(dialog);
  });

  it('traps Tab at both ends of the focusable list', () => {
    const container = mount(<HarnessDialog onClose={() => {}} />);
    click(container.querySelector<HTMLElement>('[data-testid="trigger"]')!);

    const first = container.querySelector<HTMLElement>('[data-testid="first"]')!;
    const last = container.querySelector<HTMLElement>('[data-testid="last"]')!;

    // Forward wrap: Tab on the last focusable returns to the first.
    last.focus();
    const tab = pressKey(last, 'Tab');
    expect(document.activeElement).toBe(first);
    expect(tab.defaultPrevented).toBe(true);

    // Backward wrap: Shift+Tab on the first focusable goes to the last.
    const shift = pressKey(first, 'Tab', true);
    expect(document.activeElement).toBe(last);
    expect(shift.defaultPrevented).toBe(true);
  });

  it('closes on Escape and restores focus to the trigger', () => {
    const onClose = vi.fn();
    const container = mount(<HarnessDialog onClose={onClose} />);
    const trigger = container.querySelector<HTMLElement>('[data-testid="trigger"]')!;
    trigger.focus();
    click(trigger);

    pressKey(document.body, 'Escape');
    expect(onClose).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/ledger', label: 'Ledger' },
  { href: '/vault', label: 'Vault' },
];

describe('MobileDrawer (integration)', () => {
  it('opens with focus on the dialog, traps Tab within its links, and restores focus on Escape', () => {
    const container = mount(<MobileDrawer items={NAV_ITEMS} />);
    const hamburger = container.querySelector<HTMLElement>('[data-testid="mobile-drawer-button"]')!;
    expect(hamburger.getAttribute('aria-expanded')).toBe('false');

    hamburger.focus();
    click(hamburger);
    expect(hamburger.getAttribute('aria-expanded')).toBe('true');

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(dialog);

    // The drawer's focusables: scrim close button, then the nav links.
    // Tab on the last link wraps to the first — the trap holds inside the
    // modal surface.
    const links = Array.from(dialog!.querySelectorAll<HTMLElement>('a[href], button'));
    expect(links.length).toBeGreaterThan(1);
    links[links.length - 1]!.focus();
    pressKey(links[links.length - 1]!, 'Tab');
    expect(document.activeElement).toBe(links[0]);

    // Escape closes the drawer and returns focus to the hamburger.
    pressKey(document.body, 'Escape');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(hamburger);
    expect(hamburger.getAttribute('aria-expanded')).toBe('false');
  });
});
