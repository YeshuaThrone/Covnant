/**
 * identityFromMe — pure mappers from the verified session aggregate
 * (CovnantMeResponse) to the identity display unions. ONE translation
 * point so the sidebar badge, the dashboard greeting chip, and any future
 * surface interpret the aggregate identically.
 *
 * The Creator ID card mapper was removed with the card itself (user
 * directive 2026-09-10: "dont build no id" — no identity panel on the
 * dashboard home; the only identity there is the small greeting chip).
 *
 * No string here is ever synthesized: values pass through from the
 * aggregate or the field is omitted.
 */

import type { IdentityState } from '@/components/brand/IdentityBadge';
import type { CovnantMeResponse } from '@/lib/covnant/types';

/** The sidebar pill's state — UCT + issuance facts, status text only. */
export function identityBadgeStateFromMe(me: CovnantMeResponse): IdentityState {
  return {
    kind: 'anchored',
    uct: me.identity.uct,
    status: me.provisioning.status,
    uctCreatedAt: me.identity.uctCreatedAt,
    jurisdiction: me.identity.jurisdiction,
  };
}

/**
 * Initials for the greeting chip's avatar — the first letter of each of
 * the first two words ("Nova Reign" → "NR"); a single word contributes
 * its first two letters ("nova" → "NO"). Word boundaries are any run of
 * non-letter/number characters, so punctuation never becomes an initial.
 * Pure and deterministic so server and client never disagree.
 */
export function initialsFromStageName(stageName: string): string {
  const words = stageName.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** The greeting chip's state — initials + the compact UCT reference only. */
export function identityChipFromMe(me: CovnantMeResponse): { initials: string; uct: string } {
  return {
    initials: initialsFromStageName(me.profile.stage_name),
    uct: me.identity.uct,
  };
}
