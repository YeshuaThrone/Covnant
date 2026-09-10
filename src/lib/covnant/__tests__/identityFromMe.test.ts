/**
 * identityFromMe — the ONE translation point from the verified session
 * aggregate to the identity display unions. These tests pin the pass-through
 * contract: every string on the display unions is the aggregate's own value,
 * never a synthesized one, and nothing financial beyond the documented
 * status/identity fields crosses over.
 */

import { describe, expect, it } from 'vitest';

import {
  identityBadgeStateFromMe,
  identityChipFromMe,
  initialsFromStageName,
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

describe('identityChipFromMe — the greeting row chip', () => {
  it('carries only the initials and the verbatim UCT reference', () => {
    expect(identityChipFromMe(ME)).toEqual({
      initials: 'NR',
      uct: UCT,
    });
  });

  it('never carries financial fields onto the chip', () => {
    const chip = identityChipFromMe(ME) as Record<string, unknown>;
    expect('settlements' in chip).toBe(false);
    expect('recentSettlements' in chip).toBe(false);
    expect('accountNumber' in chip).toBe(false);
    expect('routingNumber' in chip).toBe(false);
  });
});

describe('initialsFromStageName — the chip avatar', () => {
  it('takes the first letter of each of the first two words, uppercased', () => {
    expect(initialsFromStageName('Nova Reign')).toBe('NR');
    expect(initialsFromStageName('nova')).toBe('NO');
  });

  it('ignores punctuation and takes the first letters after it', () => {
    expect(initialsFromStageName("D'Angelo")).toBe('DA');
    expect(initialsFromStageName('A$AP')).toBe('AA');
  });

  it('degrades honestly on an empty name', () => {
    expect(initialsFromStageName('')).toBe('');
  });
});
