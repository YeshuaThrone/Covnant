/**
 * IdentityBadge — the Covnant identity pill. Renders a holder's UCT-anchored
 * identity from props; the data source is the signup 201 payload, the only
 * place a UCT is ever disclosed. Server component by contract: no 'use
 * client', it never fetches.
 *
 * Two states, both always text-labeled so meaning is never color-only:
 *   - `anchored` — gold-hairline pill carrying the mono COVNANT IDENTITY
 *     eyebrow, the UCT in the IdentifierBadge voice (champagne mono), and
 *     the provisioning status as text. A malformed UCT never renders as an
 *     identity: it falls back to the muted unregistered state.
 *   - `unregistered` — muted hairline reading "No identity yet". The honest
 *     placeholder until an identity source exists; never fabricates a UCT.
 *
 * Status-only by contract: nothing resembling account or routing data is
 * ever rendered. Styling draws exclusively on the globals.css @theme token
 * utilities — no hex literals in this file. The Emerald Gold gradient
 * (.badge-verification-active) is reserved for verification badges and is
 * deliberately not used here.
 */

/** Contract format for the Universal Covnant Tag, per the signup API contract. */
const UCT_FORMAT = /^UCT-[A-Z]{2}-\d{4}-[0-9A-F]{8}-[0-9A-Z]{2}$/;

export type IdentityState =
  | {
      kind: 'anchored';
      uct: string;
      status: 'PROVISIONED' | 'PENDING';
      uctCreatedAt?: string;
      jurisdiction?: string;
      /** Human-readable PENDING reason (e.g. "Increase setup"), rendered as a text suffix. */
      reason?: string;
    }
  | { kind: 'unregistered' };

/**
 * A malformed UCT must never render as an identity — data honesty over
 * decoration. Exported pure so the fallback rule is testable on its own.
 */
export function resolveRenderedState(state: IdentityState): IdentityState {
  if (state.kind === 'anchored' && !UCT_FORMAT.test(state.uct)) {
    return { kind: 'unregistered' };
  }
  return state;
}

const PADDING = 'px-3 py-1';
/** Header-sized trim, per the landing CTA pill grammar (app/page.tsx). */
const PADDING_COMPACT = 'px-2 py-0.5';

export function IdentityBadge({
  state,
  compact = false,
}: {
  state: IdentityState;
  compact?: boolean;
}) {
  const rendered = resolveRenderedState(state);
  const padding = compact ? PADDING_COMPACT : PADDING;

  if (rendered.kind === 'unregistered') {
    return (
      <span
        data-identity="unregistered"
        data-state="unregistered"
        className={`inline-flex items-center gap-1.5 rounded-full border border-white/10 text-xs tracking-wide text-white/40 ${padding}`}
      >
        No identity yet
      </span>
    );
  }

  return (
    <span
      data-identity="anchored"
      data-state="anchored"
      className={`inline-flex items-center gap-1.5 rounded-full border border-gold/40 text-xs tracking-wide ${padding}`}
    >
      <span className="font-mono text-[10px] tracking-[0.25em] text-white/40">
        COVNANT IDENTITY
      </span>
      <span className="font-mono text-gold-champagne">{rendered.uct}</span>
      <span
        className={`font-mono text-[10px] ${
          rendered.status === 'PROVISIONED' ? 'text-emerald-300' : 'text-gold-champagne'
        }`}
      >
        {rendered.status === 'PENDING' && rendered.reason
          ? `PENDING · ${rendered.reason}`
          : rendered.status}
      </span>
    </span>
  );
}
