/**
 * identityFromMe — the ONE translation point from the verified session
 * aggregate to the identity display unions. These tests pin the pass-through
 * contract: every string on the display unions is the aggregate's own value,
 * never a synthesized one, and nothing financial beyond the documented
 * status/identity fields crosses over.
 */

import { describe, expect, it } from 'vitest';

import {
  creatorIdCardStateFromMe,
  identityBadgeStateFromMe,
} from '@/lib/covnant/identityFromMe';
import type { CovnantMeResponse } from '@/lib/covnant/types';
import { buildUct } from '@/lib/covnant/uct';

const UCT = buildUct('US', 2026, '9F3A7C21');

const ME: CovnantMeResponse = {
  profile: {
    id: 'auth_user_1',
    stage_name: 'Nova Reign',
    legal_name: 'Jordan A. Reyes',
    email: 'creator@example.com',
    phone: '+15125550123',
    phone_verified_at: null,
    core_industry: 'Music — Recording',
    title: 'Recording Artist',
    udr_terms_accepted_at: '2026-09-09T00:00:00.000Z',
    kyc_status: 'PENDING_INITIALIZATION',
    tax_form_type: 'W9',
    tax_verified: false,
    bank_account_linked: false,
    created_at: '2026-09-09T00:00:00.000Z',
  },
  identity: {
    uct: UCT,
    uctCreatedAt: '2026-09-09T00:00:00.000Z',
    jurisdiction: 'US',
    engine: 'music_recording',
  },
  role: 'COMPOSER',
  provisioning: { status: 'PENDING', reason: 'INCREASE_NOT_PROVISIONED' },
  settlements: {
    grossEarnings: '175000000',
    taxWithheld: '52500000',
    availableEscrowBalance: '97500000',
    isTaxVerified: false,
  },
  registeredAssets: 1,
  activeContracts: 3,
  settlementsByCurrency: [{ currency: 'USD', grossUnits: '175000000', netUnits: '122500000' }],
  recentSettlements: [],
};

describe('identityBadgeStateFromMe — the sidebar pill', () => {
  it('passes the identity + provisioning facts through verbatim', () => {
    expect(identityBadgeStateFromMe(ME)).toEqual({
      kind: 'anchored',
      uct: UCT,
      status: 'PENDING',
      uctCreatedAt: '2026-09-09T00:00:00.000Z',
      jurisdiction: 'US',
    });
  });
});

describe('creatorIdCardStateFromMe — the dashboard centerpiece', () => {
  it('adds the stage name and role to the same verbatim identity facts', () => {
    expect(creatorIdCardStateFromMe(ME)).toEqual({
      kind: 'anchored',
      stageName: 'Nova Reign',
      uct: UCT,
      status: 'PENDING',
      uctCreatedAt: '2026-09-09T00:00:00.000Z',
      jurisdiction: 'US',
      role: 'COMPOSER',
    });
  });

  it('never carries financial fields onto the card state', () => {
    const state = creatorIdCardStateFromMe(ME) as Record<string, unknown>;
    expect('settlements' in state).toBe(false);
    expect('recentSettlements' in state).toBe(false);
    expect('accountNumber' in state).toBe(false);
    expect('routingNumber' in state).toBe(false);
  });
});
