/**
 * creatorPages — the shared server resolution for the three creator
 * surfaces (/covnant-id, /virtual-card, /sync-license) and the Settings
 * rebuild. Mirrors dashboardLive's dual-door posture exactly:
 *
 *   dev-seed mode (DON_DEV_SEED=1) ──► the seeded demo persona
 *                                     (getSeededStore — never the live
 *                                     store singleton) + the DEMO DATA
 *                                     marker
 *   verified session ──────────────► the session creator through the
 *                                     live store
 *   anonymous, no dev seed ────────► null — pages render their honest
 *                                     signed-out state
 *
 * Read failures throw — a broken identity read must never silently render
 * as a demo page.
 */

import {
  DEV_SEED_CREATOR,
  getSeededStore,
  isDevSeedMode,
} from '@/lib/server/devSeed';
import type { CreatorUctRecord } from '@/lib/server/store';
import { getStore } from '@/lib/server/store';
import type { IdentityState } from '@/components/brand/IdentityBadge';
import {
  resolveSessionCreator,
  type SessionCreator,
} from '@/lib/server/sessionCreator';

export interface CreatorPageContext {
  /** The resolved creator — the seeded persona on the demo door. */
  creator: SessionCreator;
  /** True on the dev-seed demo door — the page carries the DEMO DATA marker. */
  demo: boolean;
}

/**
 * Resolves the page's creator + store for the current door. Returns null
 * only for a genuinely anonymous visitor outside dev-seed mode; every
 * other state resolves or throws.
 */
export async function loadCreatorPageContext(): Promise<CreatorPageContext | null> {
  const resolution = await resolveSessionCreator();

  if (resolution.kind === 'registered') {
    return { creator: resolution.creator, demo: false };
  }

  // The demo door — the seeded persona through the seeded store. Fires
  // only on an anonymous/unregistered session resolution while dev-seed
  // mode is on; production without a session renders the signed-out state.
  if (isDevSeedMode()) {
    return { creator: DEV_SEED_CREATOR, demo: true };
  }

  return null;
}

/** The store for the resolved door — the seeded store on the demo door. */
export async function storeForContext(context: CreatorPageContext) {
  return context.demo ? getSeededStore() : getStore();
}

/**
 * The IdentityBadge state from the kernel's UCT read — never invented.
 * A creator with no UCT row, or a malformed one, renders the honest
 * "No identity yet" state (the badge itself re-validates the format).
 */
export function identityStateFor(
  creator: SessionCreator,
  uct: CreatorUctRecord | undefined,
): IdentityState {
  if (uct === undefined) {
    return { kind: 'unregistered' };
  }
  return {
    kind: 'anchored',
    uct: uct.uctNumber,
    status: creator.provisioning_status,
  };
}
