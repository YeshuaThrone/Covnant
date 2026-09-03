import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Stub view for workspace destinations that later PRs build out. Renders
 * the route's Obsidian chrome now with honest copy and links into the live
 * surfaces, so the shell's nav resolves everywhere from day one.
 */
export function StubView({
  kicker,
  title,
  body,
  links,
  children,
}: {
  kicker: string;
  title: string;
  body: string;
  links: { href: string; label: string }[];
  children?: ReactNode;
}) {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">{kicker}</p>
      <h1 className="mt-2 text-3xl font-semibold text-white md:text-4xl">{title}</h1>
      <p className="mt-3 max-w-2xl text-sm text-white/60">{body}</p>
      <div className="gold-rule my-8" />
      {children}
      <ul className="flex flex-wrap gap-3">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="glass-card inline-block px-4 py-2 text-sm text-gold-champagne transition hover:border-gold/50"
            >
              {link.label} →
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
