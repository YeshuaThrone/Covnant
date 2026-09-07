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

        {/* Band mirrors the URD interior slot exactly: statement margin (mt-8,
            32px) + text-sm line box (20px) + closing rule margin (mt-10, 40px)
            = the zone's approved 92px rhythm. */}
        <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Stage Name</p>
        <div className="gold-rule mt-10 w-64" />
      </section>

      {/* Reserved black-space region: keeps the capability cards' original 300px
          vertical footprint (measured on 9b34072 at 1440×900). Hosts the stage-
          name field as an obsidian plaque: borderless, single hairline bottom
          accent, no form chrome. */}
      <section className="w-full max-w-4xl flex items-center justify-center pb-24 min-h-[300px]">
        <input
          type="text"
          aria-label="Stage Name"
          placeholder="Stage Name"
          className="w-64 border-b border-white/10 bg-transparent py-2 text-center font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne caret-amber-400/70 outline-none transition duration-300 placeholder:text-white/30 focus:border-amber-400/50 focus:shadow-[0_1px_0_0_rgba(251,191,36,0.25)]"
        />
      </section>

      <footer className="w-full max-w-4xl py-10 text-center text-xs text-white/30">
        © {new Date().getFullYear()} {BRAND.name}. {BRAND.descriptor}.
      </footer>
    </main>
  );
}
