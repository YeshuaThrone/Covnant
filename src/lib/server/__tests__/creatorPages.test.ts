/**
 * creatorPages unit tests — the shared identity mapping and the store-door
 * choice. identityStateFor maps the kernel's UCT record to the IdentityBadge
 * state; storeForContext picks the seeded store on the demo door and the
 * live store on the session door — never swapped.
 */

import { describe, expect, it } from 'vitest';

import { identityStateFor, storeForContext } from '../creatorPages';
import { DEV_SEED_CREATOR, getSeededStore } from '@/lib/server/devSeed';
import { getStore, type CreatorUctRecord } from '@/lib/server/store';
import type { IdentityState } from '@/components/brand/IdentityBadge';

const seededUct: CreatorUctRecord = {
  creatorId: DEV_SEED_CREATOR.payee_id,
  uctNumber: 'UCT-US-2026-8C4F1E7A-A9',
  isni: null,
};

describe('identityStateFor', () => {
  it('maps a UCT record to the anchored state with the creator status', () => {
    const state = identityStateFor(DEV_SEED_CREATOR, seededUct);
    expect(state).toEqual({
      kind: 'anchored',
      uct: 'UCT-US-2026-8C4F1E7A-A9',
      status: 'PROVISIONED',
    });
  });

  it('maps a missing UCT record to the honest unregistered state', () => {
    const state: IdentityState = identityStateFor(DEV_SEED_CREATOR, undefined);
    expect(state).toEqual({ kind: 'unregistered' });
  });
});

describe('storeForContext', () => {
  it('resolves the seeded store on the demo door', async () => {
    const store = await storeForContext({ creator: DEV_SEED_CREATOR, demo: true });
    expect(store).toBe(await getSeededStore());
  });

  it('resolves the live store on the session door — the doors never swap', async () => {
    const store = await storeForContext({ creator: DEV_SEED_CREATOR, demo: false });
    expect(store).toBe(getStore());
    expect(store).not.toBe(getSeededStore());
  });
});
