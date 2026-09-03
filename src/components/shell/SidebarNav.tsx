'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem {
  href: string;
  label: string;
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Primary navigation for the Obsidian shell. Client component: active-route
 * highlighting needs the live pathname. Vertical variant powers the main
 * sidebar; horizontal variant powers the small-screen top bar.
 */
export function SidebarNav({
  items,
  variant = 'vertical',
}: {
  items: NavItem[];
  variant?: 'vertical' | 'horizontal';
}) {
  const pathname = usePathname();

  if (variant === 'horizontal') {
    return (
      <nav aria-label="Primary" className="flex gap-1 overflow-x-auto px-3 pb-2">
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-sm transition ${
                active
                  ? 'border-gold/60 bg-gold/10 text-gold-champagne'
                  : 'border-transparent text-white/60 hover:text-white'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <nav aria-label="Primary" className="flex flex-col gap-1 px-3">
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`border-l-2 px-3 py-2 text-sm transition ${
              active
                ? 'border-gold bg-gold/10 font-medium text-gold-champagne'
                : 'border-transparent text-white/60 hover:border-white/20 hover:bg-white/5 hover:text-white'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
