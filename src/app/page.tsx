import { CvRibbonMonogram } from '@/components/brand/CvRibbonMonogram';
import { IdentifierBadge } from '@/components/brand/IdentifierBadge';
import { BRAND } from '@/lib/brand';

// Root route renders on demand in production (strict-execution directive):
// no stale prerender of '/' on Vercel.
export const dynamic = 'force-dynamic';


const MEDIA = ['Music', 'Film & TV', 'Publishing', 'Games & Social', 'Emerging Media'];

const CAPABILITIES = [
  {
    title: 'Automated Contract Vault',
    body: 'Fourteen deterministic, auto-populating agreements — from split sheets to sync licenses — generated from your registered asset data.',
  },
  {
    title: 'Smart Ledger Verification',
    body: 'Every settlement reconciles against its splits before it posts. BigInt-precision royalties, embedded auditor, zero silent drift.',
  },
];

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center px-6">
      <section className="w-full max-w-4xl flex flex-col items-center text-center pt-20 pb-16">
        <CvRibbonMonogram size={112} />
        <p className="mt-8 text-sm uppercase tracking-[0.35em] text-[#00C8FF]">{BRAND.name}</p>
        <h1 className="mt-4 text-5xl md:text-6xl font-bold tracking-tight bg-gradient-to-r from-[#FFD700] via-[#F2F4F8] to-[#0066FF] bg-clip-text text-transparent">
          {BRAND.tagline}
        </h1>
        <p className="mt-6 text-lg text-white/60">{BRAND.descriptor}</p>
        <div className="gold-rule mt-10 w-64" />

        <ul className="mt-8 flex flex-wrap items-center justify-center gap-2" aria-label="Supported media">
          {MEDIA.map((m) => (
            <li key={m} className="glass-card px-3 py-1 text-xs text-white/70">
              {m}
            </li>
          ))}
        </ul>
      </section>

      <section className="w-full max-w-4xl grid md:grid-cols-2 gap-6 pb-24">
        {CAPABILITIES.map((c) => (
          <article key={c.title} className="glass-card p-6 flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-[#D4AF37]">{c.title}</h2>
            <p className="text-sm leading-relaxed text-white/60">{c.body}</p>
          </article>
        ))}
      </section>

      <section className="w-full max-w-4xl pb-24">
        <p className="text-xs uppercase tracking-[0.3em] text-white/40 mb-3">Registry codes render as pills</p>
        <div className="flex flex-wrap gap-3">
          <IdentifierBadge label="ISRC" value="US-S1M-24-00001" />
          <IdentifierBadge label="ISWC" value="T-034.524.237-1" />
          <IdentifierBadge label="EIDR" value="10.5240/1F2A-3B4C" />
          <IdentifierBadge label="CVT" value="CBT-TRK-8F3A21C90D41" />
        </div>
      </section>

      <footer className="w-full max-w-4xl py-10 text-center text-xs text-white/30">
        © {new Date().getFullYear()} {BRAND.name}. {BRAND.descriptor}.
      </footer>
    </main>
  );
}
