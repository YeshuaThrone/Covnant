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
 * number renders as a pending placeholder: the copy control says so
 * honestly instead of copying placeholder digits, and the wallet badges
 * open an honest provisioning-status dialog instead of implying a pass
 * was added. Full account/routing numbers exist server-side only and
 * would surface exclusively through the owner-only reveal contract when
 * that source lands.
 */

'use client';

import { useEffect, useRef, useState } from 'react';

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

/** The wallets whose badges open the provisioning-status dialog. */
type WalletKey = 'apple' | 'google';

const WALLET_NAMES: Record<WalletKey, string> = {
  apple: 'Apple Wallet',
  google: 'Google Wallet',
};

/** Honest copy feedback — the pending message never implies digits were copied. */
const COPY_NO_NUMBER_MESSAGE = 'No card number issued yet — nothing to copy';
const COPY_COPIED_MESSAGE = 'Copied';
const COPY_FAILED_MESSAGE = 'Copy failed — nothing was copied';

/**
 * Clipboard write with a legacy fallback for non-secure contexts. Returns
 * whether anything was actually copied — the caller reports honestly on
 * failure instead of claiming a copy that never happened.
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard API unavailable or rejected — try the legacy path below.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

/**
 * The wallet provisioning-status dialog — the honest behavior behind the
 * badges. Named by the wallet (aria-labelledby the wallet-name heading),
 * body = the wallet note VERBATIM; closes via the close button, a backdrop
 * click, or Escape. It explains the provisioning status — it never fakes
 * or implies a wallet pass was added.
 */
function WalletProvisioningDialog({
  walletName,
  note,
  onClose,
}: {
  walletName: string;
  note: string;
  onClose: () => void;
}): React.JSX.Element {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Minimal focus management: the close button takes focus on open; the
  // opener returns focus to its badge on close.
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      data-testid="goldnote-wallet-dialog-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="goldnote-wallet-dialog-title"
        data-testid="goldnote-wallet-dialog"
        className="w-full max-w-sm rounded-2xl border border-gold/40 bg-obsidian p-6 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.65)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h3
          id="goldnote-wallet-dialog-title"
          className="font-mono text-xs font-bold uppercase tracking-[0.25em] text-gold-champagne"
        >
          {walletName}
        </h3>
        <p className="mt-3 text-sm leading-relaxed text-slate-200">{note}</p>
        <button
          ref={closeButtonRef}
          type="button"
          data-testid="goldnote-wallet-dialog-close"
          onClick={onClose}
          className="mt-5 inline-flex items-center rounded-lg border border-gold/50 bg-white/[0.04] px-4 py-2 text-sm font-medium text-gold-champagne transition-colors hover:border-gold hover:bg-white/[0.08]"
        >
          Close
        </button>
      </div>
    </div>
  );
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
 * The real Apple logo — canonical geometry from the simple-icons package
 * (simple-icons@16.32.0, icons/apple.svg), rendered as a white silhouette
 * per the founder's official-badge reference.
 */
function AppleLogoMark() {
  return (
    <svg
      data-testid="goldnote-apple-mark"
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-[26px] w-[26px] shrink-0"
      fill="#FFFFFF"
    >
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

/**
 * The real Google G — canonical four-path construction from the Wikimedia
 * Commons "Google 'G' logo.svg", in the official brand colors.
 */
function GoogleGMark() {
  return (
    <svg
      data-testid="goldnote-google-mark"
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-[26px] w-[26px] shrink-0"
    >
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
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
  const [activeWallet, setActiveWallet] = useState<WalletKey | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const walletOpenerRef = useRef<HTMLButtonElement | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = cardNumberMasked === PENDING_PLACEHOLDER;

  // Clear the transient copy timer on unmount — no feedback after teardown.
  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const closeWalletDialog = () => {
    setActiveWallet(null);
    walletOpenerRef.current?.focus();
    walletOpenerRef.current = null;
  };

  const showCopyFeedback = (message: string) => {
    setCopyFeedback(message);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyFeedback(null), 2500);
  };

  // The honesty law: the pending placeholder is not a card number, so it is
  // never written to the clipboard as if it were one.
  const handleCopyNumber = () => {
    if (pending) {
      showCopyFeedback(COPY_NO_NUMBER_MESSAGE);
      return;
    }
    void copyTextToClipboard(cardNumberMasked).then((copied) => {
      showCopyFeedback(copied ? COPY_COPIED_MESSAGE : COPY_FAILED_MESSAGE);
    });
  };

  const openWalletDialog = (wallet: WalletKey, opener: HTMLButtonElement) => {
    walletOpenerRef.current = opener;
    setActiveWallet(wallet);
  };

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
            real Apple logo silhouette on the rounded rectangle, real Google G
            in the official four colors on the stadium pill. Click opens the
            honest provisioning-status dialog — no provisioning source exists,
            so the dialog explains instead of implying a pass was added. */}
        <button
          type="button"
          data-testid="goldnote-wallet-apple"
          title={walletNote}
          aria-haspopup="dialog"
          onClick={(event) => openWalletDialog('apple', event.currentTarget)}
          className="inline-flex h-[46px] cursor-pointer items-center gap-2.5 rounded-[12px] bg-black px-4 text-left opacity-80 transition hover:opacity-100 active:scale-[0.98]"
        >
          <AppleLogoMark />
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
          title={walletNote}
          aria-haspopup="dialog"
          onClick={(event) => openWalletDialog('google', event.currentTarget)}
          className="inline-flex h-[46px] cursor-pointer items-center gap-2.5 rounded-full bg-black px-4 text-left opacity-80 transition hover:opacity-100 active:scale-[0.98]"
        >
          <GoogleGMark />
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
          title={pending ? 'Card number pending — nothing to copy yet' : 'Copy card number'}
          onClick={handleCopyNumber}
          className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-500/50 bg-white/[0.04] px-4 py-2 text-sm text-slate-300 transition hover:border-gold/50 hover:text-gold-champagne active:scale-[0.98]"
        >
          Copy card number
        </button>
        {copyFeedback && (
          <span
            data-testid="goldnote-copy-feedback"
            role="status"
            className="text-xs font-medium text-gold-champagne"
          >
            {copyFeedback}
          </span>
        )}
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

      {/* The honest wallet provisioning dialog — explains, never provisions. */}
      {activeWallet && (
        <WalletProvisioningDialog
          walletName={WALLET_NAMES[activeWallet]}
          note={walletNote}
          onClose={closeWalletDialog}
        />
      )}
    </div>
  );
}
