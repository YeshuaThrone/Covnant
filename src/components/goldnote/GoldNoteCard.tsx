/**
 * GoldNoteCard — the physical GoldNote debit-card render (Creator UI Layout
 * Contract v2 amendment + C-directive + G-directive structure).
 *
 * BINDING SHAPE: a 1.586:1 (ISO/IEC 7810 ID-1) brushed-gold face with a
 * metallic EMV chip, a masked 16-position card number, the holder identity,
 * and the SOVEREIGN_NETWORK badge ONLY — no balance, no expiry date, no
 * paragraph text on the face. Beneath the face: the wallet + copy actions,
 * then the always-rendered details panel (Card Number / Expiration / CVC /
 * Zipcode / Name on Card) under the honesty law — masked real sources or
 * honest pending states; expiry/CVC/ZIP NEVER render fabricated values,
 * and the demo door renders the same shell with the DEMO DATA marker in
 * the page header.
 *
 * There is no card-PAN, account, or routing source in this build, so the
 * number renders as a pending placeholder and the copy action stays
 * disabled — honesty over decoration. Full account/routing numbers exist
 * server-side only and would surface exclusively through the owner-only
 * reveal contract when that source lands.
 */

'use client';

import { useState } from 'react';

export interface GoldNoteCardProps {
  /** The holder identity — stage name from the session or seeded persona. */
  holderName: string;
  /**
   * The masked number row. Rendered verbatim — the caller derives it from
   * a real source or passes the pending placeholder; this component never
   * invents digits.
   */
  cardNumberMasked: string;
  /** Real available balance (cents) for the details panel — store-read. */
  availableBalanceCents: bigint;
  /** Honest not-provisioned note for the wallet actions. */
  walletNote: string;
}

/** The pending number row — rendered when no real card-number source exists. */
export const PENDING_PLACEHOLDER = '•••• •••• •••• ••••';

/** Renders integer cents as a plain dollar string (never a float path). */
function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const dollars = abs / 100n;
  const rem = abs % 100n;
  const body = `${dollars.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')}`;
  return negative ? `−$${body}` : `$${body}`;
}

/** The metallic EMV chip — pure SVG, gold-toned contacts. */
function EmvChip() {
  return (
    <svg
      data-testid="goldnote-chip"
      viewBox="0 0 44 32"
      aria-hidden="true"
      className="h-8 w-11 shrink-0"
    >
      <defs>
        <linearGradient id="goldnote-chip-metal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#F5E6B8" />
          <stop offset="45%" stopColor="#C9A84C" />
          <stop offset="100%" stopColor="#8A6D1F" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="43" height="31" rx="5" fill="url(#goldnote-chip-metal)" stroke="#6B5312" />
      <path
        d="M0.5 11h12M0.5 21h12M31 11h12.5M31 21h12.5M22 0.5v9M22 22v9.5M12.5 11v10a4 4 0 0 0 4 4H22M31.5 11V10a4 4 0 0 0-4-4H22"
        fill="none"
        stroke="#6B5312"
        strokeWidth="1.2"
      />
    </svg>
  );
}

/**
 * The Apple Wallet app icon — a white-outlined wallet holding the green /
 * orange / blue card layers, per the founder's official-badge reference.
 */
function AppleWalletIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[26px] w-[26px] shrink-0">
      <rect
        x="2.9"
        y="2.9"
        width="18.2"
        height="18.2"
        rx="5.2"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.8"
      />
      <rect x="6.1" y="6.5" width="11.8" height="2.7" rx="1.35" fill="#30D158" />
      <rect x="6.1" y="10.3" width="11.8" height="2.7" rx="1.35" fill="#FF9F0A" />
      <rect x="6.1" y="14.1" width="11.8" height="2.7" rx="1.35" fill="#0A84FF" />
    </svg>
  );
}

/**
 * The Google Wallet mark — stacked pass layers (green / yellow / blue) with
 * the red arc capping the top-right, per the founder's official-badge
 * reference.
 */
function GoogleWalletMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[26px] w-[26px] shrink-0">
      <rect x="2.5" y="2.5" width="11" height="5.2" rx="2.6" fill="#34A853" />
      <path
        d="M13.5 2.5a6.2 6.2 0 0 1 6.2 6.2h-2.9a3.3 3.3 0 0 0-3.3-3.3z"
        fill="#EA4335"
      />
      <rect x="2.5" y="9.4" width="14.3" height="5.2" rx="2.6" fill="#FBBC04" />
      <rect x="2.5" y="16.3" width="17.2" height="5.2" rx="2.6" fill="#4285F4" />
    </svg>
  );
}

function DetailRow({
  label,
  value,
  valueTestId,
  note,
}: {
  label: string;
  value: string;
  valueTestId?: string;
  note?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5" data-testid="goldnote-details-row">
      <div className="min-w-0">
        <p className="text-xs text-slate-300">{label}</p>
        {note && <p className="mt-0.5 text-[11px] text-slate-500">{note}</p>}
      </div>
      <p
        data-testid={valueTestId}
        className="shrink-0 font-mono text-sm text-slate-100"
      >
        {value}
      </p>
    </div>
  );
}

export function GoldNoteCard({
  holderName,
  cardNumberMasked,
  availableBalanceCents,
  walletNote,
}: GoldNoteCardProps) {
  const [noteDismissed, setNoteDismissed] = useState(false);
  const pending = cardNumberMasked === PENDING_PLACEHOLDER;

  return (
    <div data-testid="goldnote-surface">
      {/* The physical card face — brushed gold, ID-1 ratio, face content ONLY. */}
      <div
        data-testid="goldnote-card"
        data-card-style="BRUSHED_GOLD"
        className="relative overflow-hidden rounded-2xl shadow-[0_24px_60px_-20px_rgba(0,0,0,0.65)] ring-1 ring-white/20"
        style={{
          aspectRatio: '1.586 / 1',
          background: [
            'repeating-linear-gradient(95deg, rgba(255,255,255,0.07) 0px, rgba(255,255,255,0.07) 1px, rgba(255,255,255,0) 1px, rgba(255,255,255,0) 3px)',
            'linear-gradient(135deg, var(--color-gold-champagne) 0%, var(--color-gold) 42%, var(--color-gold-muted) 78%, var(--color-gold) 100%)',
          ].join(', '),
        }}
        aria-label="GoldNote card"
      >
        <div className="flex h-full flex-col justify-between p-5 md:p-6">
          {/* Top row — wordmark + product name, nothing else. */}
          <div className="flex items-start justify-between gap-4">
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.35em] text-obsidian">
              COVNANT
            </span>
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.25em] text-obsidian/80">
              GoldNote
            </span>
          </div>

          {/* Middle — the chip; no paragraph text on the face. */}
          <div className="flex items-center gap-4">
            <EmvChip />
          </div>

          {/* Number + holder + network — the only face content beneath the chip. */}
          <div className="space-y-3">
            <p
              data-testid="goldnote-number"
              className="font-mono text-lg tracking-[0.22em] text-obsidian md:text-xl"
            >
              {cardNumberMasked}
            </p>
            <div className="flex items-end justify-between gap-4">
              <div className="min-w-0">
                <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-obsidian/60">
                  Card holder
                </p>
                <p
                  data-testid="goldnote-holder"
                  className="truncate font-mono text-sm font-semibold uppercase tracking-[0.14em] text-obsidian"
                >
                  {holderName}
                </p>
              </div>
              <span
                data-testid="goldnote-badge-network"
                className="shrink-0 rounded-md border border-obsidian/30 bg-obsidian/10 px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-obsidian"
              >
                SOVEREIGN_NETWORK
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Wallet + copy actions directly under the card — honest affordances. */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/* Official wallet badges per the founder's reference (fl_kYE4tGl5):
            Apple = rounded rectangle + Wallet app icon, Google = stadium pill
            + multicolor Wallet mark. Still disabled — no provisioning source
            exists, so the affordance stays honest. */}
        <button
          type="button"
          data-testid="goldnote-wallet-apple"
          disabled
          title={walletNote}
          className="inline-flex h-[46px] items-center gap-2.5 rounded-[12px] bg-black px-4 text-left opacity-80"
        >
          <AppleWalletIcon />
          <span className="flex flex-col">
            <span className="text-[11px] font-normal leading-[1.15] tracking-[0.01em] text-white/90">
              Add to
            </span>
            <span className="mt-px text-[15px] font-semibold leading-[1.15] text-white">
              Apple Wallet
            </span>
          </span>
        </button>
        <button
          type="button"
          data-testid="goldnote-wallet-google"
          disabled
          title={walletNote}
          className="inline-flex h-[46px] items-center gap-2.5 rounded-full bg-black px-4 text-left opacity-80"
        >
          <GoogleWalletMark />
          <span className="flex flex-col">
            <span className="text-[11px] font-normal leading-[1.15] tracking-[0.01em] text-white/90">
              Add to
            </span>
            <span className="mt-px text-[15px] font-semibold leading-[1.15] text-white">
              Google Wallet
            </span>
          </span>
        </button>
        <button
          type="button"
          data-testid="goldnote-copy-number"
          disabled={pending}
          title={pending ? 'Card number pending — nothing to copy yet' : 'Copy card number'}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-500/50 bg-white/[0.04] px-4 py-2 text-sm text-slate-300 enabled:hover:border-gold/50 enabled:hover:text-gold-champagne disabled:opacity-50"
        >
          Copy card number
        </button>
      </div>
      {!noteDismissed && (
        <p
          data-testid="goldnote-wallet-note"
          className="mt-2 text-xs text-slate-500"
          role="note"
        >
          {walletNote}{' '}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-slate-300"
            onClick={() => setNoteDismissed(true)}
          >
            Dismiss
          </button>
        </p>
      )}

      {/* The always-rendered details panel — masked/pending rows + real facts. */}
      <section
        data-testid="goldnote-details"
        aria-label="Card details"
        className="mt-6 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] shadow-[0_12px_40px_-16px_rgba(0,0,0,0.55)] p-5 md:p-6"
      >
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
            Card details
          </h2>
          <p className="font-mono text-sm text-gold-champagne" data-testid="goldnote-balance">
            {formatCents(availableBalanceCents)}{' '}
            <span className="text-[11px] text-slate-500">available</span>
          </p>
        </div>

        <div className="mt-3 divide-y divide-slate-700/40">
          <DetailRow
            label="Card Number"
            value={cardNumberMasked}
            valueTestId="goldnote-details-number"
            note={pending ? 'Pending — no card number has been issued yet' : undefined}
          />
          <DetailRow
            label="Expiration"
            value="Pending"
            valueTestId="goldnote-details-expiry"
            note="Rendered when a real card-expiry source exists — never a placeholder date"
          />
          <DetailRow label="CVC" value="•••" valueTestId="goldnote-details-cvc" />
          <DetailRow label="Zipcode" value="•••••" valueTestId="goldnote-details-zip" />
          <DetailRow
            label="Name on Card"
            value={holderName}
            valueTestId="goldnote-details-name"
          />
        </div>

        <details className="mt-4 rounded-xl border border-slate-700/50 bg-white/[0.02] p-4">
          <summary className="cursor-pointer text-sm text-slate-300">
            Additional payment information
          </summary>
          <p className="mt-3 text-xs leading-relaxed text-slate-500" data-testid="goldnote-additional-payment">
            Further payment methods and account details arrive with the live card
            program. Account and routing numbers, when issued, surface here under
            the owner-only reveal — masked by default, in-session, and never
            rendered on a signed-out or demo surface.
          </p>
        </details>

        <a
          data-testid="goldnote-transactions-link"
          href="/ledger"
          className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-slate-700/50 bg-white/[0.02] p-4 transition-colors hover:border-gold/40"
        >
          <span className="text-sm text-slate-200">Transactions &amp; History</span>
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-gold-champagne">
            Open ledger →
          </span>
        </a>
      </section>
    </div>
  );
}
