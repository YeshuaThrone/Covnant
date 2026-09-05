import { CvRibbonMonogram } from '@/components/brand/CvRibbonMonogram';
import Link from 'next/link';
import { BRAND } from '@/lib/brand';

// Root route renders on demand in production (strict-execution directive):
// no stale prerender of '/' on Vercel.
export const dynamic = 'force-dynamic';


const CAPABILITIES = [
  {
    title: 'Automated Contract Vault',
    body: 'Twenty deterministic, auto-populating agreements — from split sheets and sync licenses to brand collaborations and runway releases — generated from your registered asset data.',
  },
  {
    title: 'Smart Ledger Verification',
    body: 'Every settlement reconciles against its splits before it posts. BigInt-precision royalties, embedded auditor, zero silent drift.',
  },
];

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

        <p className="font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Universal Royalty Distribution</p>
        <div className="gold-rule mt-10 w-64" />
      </section>

      <section className="w-full max-w-4xl grid md:grid-cols-2 gap-6 pb-24">
        {CAPABILITIES.map((c) => (
          <article key={c.title} className="glass-card p-6 flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-gold">{c.title}</h2>
            <p className="text-sm leading-relaxed text-white/60">{c.body}</p>
          </article>
        ))}
      </section>

      <footer className="w-full max-w-4xl py-10 text-center text-xs text-white/30">
        © {new Date().getFullYear()} {BRAND.name}. {BRAND.descriptor}.
      </footer>
    </main>
  );
}
