'use client';

/**
 * MobileDrawer — the mobile shell's navigation drawer (bank reference: the
 * hamburger drawer). Client component: it owns the open/close state. The
 * nine workspace destinations are unchanged — this re-skins HOW they are
 * reached on small screens (drawer instead of the horizontal scroll bar),
 * not WHERE they go. The IdentityBadge renders from props inside the
 * drawer, exactly as the desktop sidebar does.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { CvRibbonMonogram } from '@/components/brand/CvRibbonMonogram';
import { IdentityBadge, type IdentityState } from '@/components/brand/IdentityBadge';
import type { NavItem } from './SidebarNav';

export function MobileDrawer({ items, identity }: { items: NavItem[]; identity: IdentityState }): React.JSX.Element {
  const [open, setOpen] = useState(false);

  // Close on Escape — the drawer is a modal surface on a dark scrim.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const close = (): void => setOpen(false);

  return (
    <>
      <button
        type="button"
        data-testid="mobile-drawer-button"
        aria-label={open ? 'Close navigation' : 'Open navigation'}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 w-9 items-center justify-center rounded-md border border-gold/25 text-gold-champagne"
      >
        <span aria-hidden="true" className="flex flex-col gap-1">
          <span className={`block h-px w-4 bg-current transition-transform ${open ? 'translate-y-[5px] rotate-45' : ''}`} />
          <span className={`block h-px w-4 bg-current transition-opacity ${open ? 'opacity-0' : ''}`} />
          <span className={`block h-px w-4 bg-current transition-transform ${open ? '-translate-y-[5px] -rotate-45' : ''}`} />
        </span>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Workspace navigation">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={close}
            className="absolute inset-0 bg-black/70"
          />
          <nav
            data-testid="mobile-drawer"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col border-r border-gold/15 bg-obsidian-900"
          >
            <div className="flex items-center justify-between px-5 py-4">
              <Link href="/" onClick={close} aria-label="Covnant home">
                <span className="flex items-center gap-2">
                  <CvRibbonMonogram size={26} />
                  <span className="font-mono text-xs tracking-[0.3em] text-gold-champagne">COVNANT</span>
                </span>
              </Link>
            </div>
            <div className="gold-rule mx-5 opacity-60" />
            <ul className="flex-1 overflow-y-auto py-3">
              {items.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} onClick={close}>
                    <span className="block px-5 py-3 text-sm text-slate-300 hover:text-gold-champagne">
                      {item.label}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="border-t border-gold/15 px-5 py-4">
              <IdentityBadge state={identity} />
            </div>
            <p className="px-5 pb-5 font-mono text-[10px] uppercase tracking-[0.25em] text-white/30">
              Own Your Creation.
            </p>
          </nav>
        </div>
      ) : null}
    </>
  );
}
