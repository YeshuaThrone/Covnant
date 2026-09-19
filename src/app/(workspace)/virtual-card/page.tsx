/**
 * /virtual-card — the GoldNote surface (Creator UI Layout Contract v2
 * amendment; the founder's phone mockup is the binding structural
 * reference).
 *
 * A physical brushed-gold GoldNote debit-card render (1.586:1, EMV chip,
 * masked number, holder identity, SOVEREIGN_NETWORK badge ONLY), wallet +
 * copy actions directly beneath, and the always-rendered details panel —
 * masked/pending rows, an additional-payment-information disclosure, and a
 * Transactions & History row. Under the honesty law: there is no card-PAN,
 * account, or routing source in this build, so the number renders as the
 * pending placeholder, expiry/CVC/ZIP never show fabricated values, and
 * unprovisioned creators see an honest empty state. The balance is the
 * real store-read available amount; the demo door carries the DEMO DATA
 * marker and the seeded persona.
 */

import type { Metadata } from 'next';

import { GoldNoteCard, PENDING_PLACEHOLDER } from '@/components/goldnote/GoldNoteCard';
import { HeaderActions } from '@/components/workspace/HeaderActions';
import {
  loadCreatorPageContext,
  storeForContext,
} from '@/lib/server/creatorPages';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Virtual Card — Covnant',
  description:
    'The GoldNote — your sovereign-network debit card on The Don, rendered as a physical card with honest pending details.',
};

const WALLET_NOTE =
  'Card provisioning arrives with the live card program — wallet passes are not available in this build.';

export default async function VirtualCardPage() {
  const context = await loadCreatorPageContext();

  if (context === null) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6 md:py-10">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold-champagne">Virtual Card</p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-100 md:text-4xl">
          Sign in to view your GoldNote
        </h1>
        <p className="mt-3 text-sm text-slate-400">
          Your GoldNote lives behind your sign-in.
        </p>
      </main>
    );
  }

  const { creator, demo } = context;
  const store = await storeForContext(context);
  const vault = await store.getVault(creator.payee_id);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6 md:py-10">
      <div
        data-testid="virtual-card-header"
        className="flex items-center justify-between gap-2.5"
      >
        <span className="font-mono text-xs tracking-[0.35em] text-gold-champagne">
          VIRTUAL CARD
        </span>
        <HeaderActions demo={demo} />
      </div>

      <h1
        data-testid="virtual-card-title"
        className="mt-6 text-4xl font-bold tracking-tight text-slate-100 md:text-5xl"
      >
        <span className="bg-gradient-to-r from-gold-champagne via-emerald-200 to-gold bg-clip-text text-transparent">
          GoldNote
        </span>
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-400">
        Your debit card on the sovereign network. Card details stay masked
        until real sources exist — nothing on this page is invented.
      </p>

      <div className="gold-rule my-6 md:my-8" />

      {creator.provisioning_status !== 'PROVISIONED' ? (
        <section
          data-testid="goldnote-empty-state"
          aria-label="GoldNote not provisioned"
          className="glass-card p-8 text-center"
        >
          <h2 className="text-lg font-semibold text-slate-100">
            Your GoldNote has not been provisioned yet
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-400">
            Provisioning completes on the sandbox rail before a card can render.
            When it is provisioned, the card and its details appear here — no
            placeholder card is shown in the meantime.
          </p>
        </section>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,480px)_1fr] lg:items-start">
          <div className="mx-auto w-full max-w-[480px]">
            <GoldNoteCard
              holderName={creator.stage_name}
              cardNumberMasked={PENDING_PLACEHOLDER}
              availableBalanceCents={BigInt(vault?.available_balance ?? 0)}
              walletNote={WALLET_NOTE}
            />
          </div>

          <aside
            data-testid="goldnote-about"
            className="h-fit rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] shadow-[0_12px_40px_-16px_rgba(0,0,0,0.55)] p-5"
            aria-label="About the GoldNote"
          >
            <h2 className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
              About this card
            </h2>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              The GoldNote rides the SOVEREIGN_NETWORK badge — Covnant&apos;s own
              network. It is not a Visa or Mastercard product, and it carries no
              third-party network branding.
            </p>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              Card numbers, account numbers, and routing numbers render only
              through the owner-only reveal once a real provisioning source
              exists. Signed-out and demo surfaces render the masked shell —
              never financial values.
            </p>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              The available balance shown in the card details panel is read
              directly from your sovereign vault.
            </p>
            {demo && (
              <p className="mt-4 rounded-lg border border-amber-300/30 bg-amber-300/10 p-3 text-xs leading-relaxed text-amber-200">
                This is the demo persona&apos;s GoldNote — the seeded preview
                state. No real card or account exists behind it.
              </p>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}
