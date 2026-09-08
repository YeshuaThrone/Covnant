import { CvRibbonMonogram } from '@/components/brand/CvRibbonMonogram';
import Link from 'next/link';
import { BRAND } from '@/lib/brand';
import { EntryZones } from '@/components/landing/EntryZones';

// Root route renders on demand in production (strict-execution directive):
// no stale prerender of '/' on Vercel.
export const dynamic = 'force-dynamic';

// Micro-edit 12 — the COMPANY ID statement. The user's copy is FROZEN: it
// renders verbatim with no copyediting (capital-I 'Integrity', unhyphenated
// 'in house clearing framework protocol', the 'etc.,' enumeration, and the
// 'Own Your Creation!' motto). Held as string constants rendered via {expr}
// so the apostrophes never trip react/no-unescaped-entities.
const COMPANY_ID_P1 =
  'Whether you create or operate in Music, Gaming & Interactive, Podcasting, Streaming, Social Media, Publishing, Film, TV & Video, Sports & Athletics, Fashion & Apparel, Modeling & CAD, Visual Arts & Design, Books & Literature, Digital Assets & Software, VTubing & Virtual Avatars, or all of the above, Covnant is the autonomous clearinghouse built with Integrity for your absolute independence. Your assets, your identity, and your equity remain uncompromised. This engine doesn\'t bend, alter, or negotiate with or from outside pressure.';
const COMPANY_ID_P2 =
  'Existing industry pipelines force modern creators to navigate fragmented networks, opaque accounting, and delayed earnings. Covnant replaces that friction with a unified, institutional-grade infrastructure that consolidates multi-channel distribution, and contractual execution into a single, high-performance in house clearing framework protocol.';
const COMPANY_ID_P3 =
  'By automating clearance across every sector and every nook & cranny within them. Covnant ensures that independent artists, IP owners, record labels, publishers, studios, production companies, retail stores, lounges, nightclubs, hotels, fashion houses, sports teams & brands, Interactive Media & Immersive Tech, Storytelling & Gamified Platforms, VTubing & Virtual Avatars, Simulations & CAD Asset Stores, Professional Leagues & Governing Bodies, Broadcasters & Media Rights Holders, Sports Franchises & Clubs, Talent & Management Agencies, Apparel, Gear & Equipment Manufacturers, Venues, Stadiums & Event Promoters, Arena operators, tournament organizers, motorsport circuits etc., every, any & all global enterprises retain total authority over their assets, eliminate administrative bloat, and command immediate control over their cash flow. We honor execution over promises. Infrastructure isn\'t built on theory; it\'s forged through relentless precision, unbroken focus, and zero tolerance for inefficiency. We ensure your creation and assets are owned by you hence our company motto: Own Your Creation!';


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

        <EntryZones />
      </section>

      {/* Former reserved black-space region (micro-edit 12, amendments
          12.1–12.3): the COMPANY ID statement fills the capability cards'
          original footprint inside ONE panel recovered verbatim from the
          removed cards (133ec05): glass-card p-6 flex flex-col gap-3. The
          header reuses the cards' exact title classes (text-lg font-semibold
          text-gold, sans, Title Case) — the mono statement treatment is gone.
          Two interior gold rules separate the frozen paragraphs; the section's
          closing rule stays after the panel. The 300px floor measured on
          9b34072 at 1440×900 is kept as a minimum — the section grows
          naturally with the statement content. */}
      <section className="w-full max-w-4xl flex flex-col items-center pb-24 min-h-[300px]">
        <div className="glass-card p-6 flex flex-col gap-3 max-w-3xl mx-auto text-center">
          <h2 className="text-lg font-semibold text-gold">Company ID</h2>
          <p className="bg-gradient-to-r from-gold-champagne via-emerald-200 to-gold bg-clip-text text-transparent font-bold tracking-tight text-base md:text-lg leading-relaxed">{COMPANY_ID_P1}</p>
          <div className="gold-rule w-64 mx-auto" />
          <p className="bg-gradient-to-r from-gold-champagne via-emerald-200 to-gold bg-clip-text text-transparent font-bold tracking-tight text-base md:text-lg leading-relaxed">{COMPANY_ID_P2}</p>
          <div className="gold-rule w-64 mx-auto" />
          <p className="bg-gradient-to-r from-gold-champagne via-emerald-200 to-gold bg-clip-text text-transparent font-bold tracking-tight text-base md:text-lg leading-relaxed">{COMPANY_ID_P3}</p>
        </div>
        <div className="gold-rule w-64" />
      </section>

      {/* Micro-edit 13 — the ENTERPRISE DIRECT zone. Amendment 13.1 gives
          the zone its OWN top golden ruler as the section's first child,
          mirroring the URD zone grammar (rule → statement → rule): the
          statement is now flanked by twin w-64 rulers. The statement
          repeats the canonical champagne mono zone treatment — the
          identical class string of Universal Royalty Distribution / Stage
          Name / Legal Name — carrying the user's own digits, 830-567-4850,
          rendered uppercase by the class. The zone closes on the bottom
          ruler with the URD zone's mt-10 rhythm; the composition now counts
          fourteen golden rulers. Display statement only: no glass card, no
          input, no tel: link. */}
      <section className="w-full max-w-4xl flex flex-col items-center">
        <div className="gold-rule w-64" />
        <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Enterprise Direct: 830-567-4850</p>
        <div className="gold-rule mt-10 w-64" />
      </section>

      <footer className="w-full max-w-4xl py-10 text-center text-xs text-white/30">
        © {new Date().getFullYear()} {BRAND.name}. {BRAND.descriptor}.
      </footer>
    </main>
  );
}
