import { CvRibbonMonogram } from '@/components/brand/CvRibbonMonogram';
import Link from 'next/link';
import { BRAND } from '@/lib/brand';

// Root route renders on demand in production (strict-execution directive):
// no stale prerender of '/' on Vercel.
export const dynamic = 'force-dynamic';


export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center px-6">
      <header className="w-full max-w-5xl flex items-center justify-between py-6">
        <div className="flex items-center gap-3">
          <CvRibbonMonogram size={32} />
          <span className="font-mono text-sm tracking-[0.3em] text-gold-champagne">COVNANT</span>
        </div>
        <Link
          href="/dashboard"
          className="rounded-full border border-gold/40 px-4 py-1.5 text-sm text-gold-champagne transition hover:bg-gold/10"
        >
          Enter your world
        </Link>
      </header>

      <section className="w-full max-w-4xl flex flex-col items-center text-center pt-20 pb-16">
        <span className="drop-shadow-[0_0_14px_rgba(110,231,183,0.30)] block"><CvRibbonMonogram size={112} /></span>
        <p className="mt-8 text-sm uppercase tracking-[0.35em] text-gold-champagne">{BRAND.name}</p>
        <h1 className="mt-4 bg-gradient-to-r from-gold-champagne via-emerald-200 to-gold bg-clip-text text-5xl font-bold tracking-tight text-transparent md:text-6xl">
          {BRAND.tagline}
        </h1>
        <p className="mt-6 text-lg text-emerald-300">The Immutable Truth Engine</p>
        <div className="gold-rule mt-10 w-64" />

        <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Universal Royalty Distribution</p>
        <div className="gold-rule mt-10 w-64" />

        {/* Stage Name entry in open black space below the URD zone — NOT a new
            zone. The statement keeps the established 32px top gap; the invisible
            input occupies the EXISTING 40px slot between statement and bottom
            ruler (h-10, zero margins — zero net added height), so the band
            interior stays EXACTLY 92px (32 + 20 + 40) and the bottom ruler sits
            at the approved y. The ruler doubles as the entry area's bottom
            line; nothing follows it. The input is fully chromeless at every
            state — no border, no focus glow, no placeholder; only the typed
            name (hero-subtitle treatment: text-lg text-emerald-300, displayed
            exactly as the artist types it) and the gold caret ever appear.
            cursor-text keeps the invisible field discoverable; accessible via
            aria-label. */}
        <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Stage Name</p>
        <input
          type="text"
          aria-label="Stage Name"
          className="h-10 w-64 cursor-text bg-transparent text-center text-lg text-emerald-300 caret-amber-400/70 outline-none"
        />
        <div className="gold-rule w-64" />

        {/* Legal Name entry zone — a straight mirror of the Stage Name zone.
            The ruler above doubles as this zone's SHARED TOP RULE (untouched,
            same y as approved). The statement repeats the exact champagne mono
            treatment and the same 32px top gap below the shared rule; the
            invisible input repeats the Stage Name field byte-for-byte
            (chromeless h-10 w-64, jade typed text, gold caret, aria-label
            only, local-only — no submission wiring); a new bottom golden
            ruler closes the zone HUGGING the input — zero margin above it,
            a true pixel mirror of the Stage Name zone. NOTHING follows the
            ruler — the region below stays empty black space. */}
        <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Legal Name</p>
        <input
          type="text"
          aria-label="Legal Name"
          className="h-10 w-64 cursor-text bg-transparent text-center text-lg text-emerald-300 caret-amber-400/70 outline-none"
        />
        <div className="gold-rule w-64" />
      </section>

      {/* Reserved black-space region: the capability cards were removed, but this
          area keeps their original 300px vertical footprint (measured on 9b34072
          at 1440×900) for content that will be added here later. */}
      <section className="w-full max-w-4xl grid md:grid-cols-2 gap-6 pb-24 min-h-[300px]" />

      <footer className="w-full max-w-4xl py-10 text-center text-xs text-white/30">
        © {new Date().getFullYear()} {BRAND.name}. {BRAND.descriptor}.
      </footer>
    </main>
  );
}
