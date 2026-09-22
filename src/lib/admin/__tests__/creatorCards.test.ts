/**
 * creatorCards tests — the Creators View data adapter's honesty contract:
 * real rows carry only signup columns (registry fields stay null, never
 * fabricated), and the disclosed demo set derives every UCT through the REAL
 * buildUct checksum, hides behind no name ban, and matches the UCT pattern.
 */

import { describe, expect, it } from 'vitest';
import { buildUct, isValidUct } from '@/lib/covnant/uct';
import { DEMO_CREATOR_CARDS, mapProfileToCard } from '../creatorCards';
import type { AdminCreatorProfile } from '../types';

function profileRow(overrides: Partial<AdminCreatorProfile> = {}): AdminCreatorProfile {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    stage_name: 'VALE SOUNDS',
    legal_name: 'Marcus Vale',
    email: 'marcus.vale@example.com',
    phone: '+1 (312) 555-0148',
    phone_verified_at: null,
    core_industry: 'Music — Producer',
    title: 'Producer / Engineer',
    udr_terms_accepted_at: '2026-09-21T00:00:00.000Z',
    created_at: '2026-09-21T00:00:00.000Z',
    kyc_status: 'PENDING_INITIALIZATION',
    tax_form_type: 'W9',
    tax_verified: false,
    bank_account_linked: false,
    ...overrides,
  };
}

describe('mapProfileToCard', () => {
  it('carries the signup columns the row actually holds', () => {
    const card = mapProfileToCard(profileRow());
    expect(card).toMatchObject({
      stage_name: 'VALE SOUNDS',
      legal_name: 'Marcus Vale',
      email: 'marcus.vale@example.com',
      phone: '+1 (312) 555-0148',
      core_industry: 'Music — Producer',
      title: 'Producer / Engineer',
    });
  });

  it('never fabricates registry-resolved fields — they stay null until the join', () => {
    const card = mapProfileToCard(profileRow());
    expect(card.uct).toBeNull();
    expect(card.uctCreatedAt).toBeNull();
    expect(card.jurisdiction).toBeNull();
    expect(card.engine).toBeNull();
    expect(card.status).toBeNull();
  });

  it('carries nullable columns honestly (null phone, null title)', () => {
    const card = mapProfileToCard(profileRow({ phone: null, title: null }));
    expect(card.phone).toBeNull();
    expect(card.title).toBeNull();
  });
});

describe('DEMO_CREATOR_CARDS (disclosed demo door set)', () => {
  it('derives every demo UCT through the real buildUct checksum pattern', () => {
    for (const card of DEMO_CREATOR_CARDS) {
      expect(card.uct).not.toBeNull();
      expect(isValidUct(card.uct)).toBe(true);
      expect(card.uctCreatedAt).not.toBeNull();
    }
  });

  it('uses deterministic derivations — recomputing buildUct matches the stored tags', () => {
    expect(DEMO_CREATOR_CARDS[0].uct).toBe(buildUct('US', 2026, '9A3F02B7'));
    expect(DEMO_CREATOR_CARDS[2].uct).toBe(buildUct('UK', 2026, '7B2D9F41'));
  });

  it('excludes the banned Nova Reign placeholder (seed canon)', () => {
    const names = DEMO_CREATOR_CARDS.map((c) => `${c.legal_name} ${c.stage_name}`).join(' ');
    expect(names).not.toMatch(/Nova Reign|NOVA REIGN/i);
  });

  it('carries only the honest issuance vocabulary and unique demo emails', () => {
    const statuses = new Set(DEMO_CREATOR_CARDS.map((c) => c.status));
    for (const status of statuses) {
      expect(['PROVISIONED', 'PENDING']).toContain(status);
    }
    expect(new Set(DEMO_CREATOR_CARDS.map((c) => c.email)).size).toBe(DEMO_CREATOR_CARDS.length);
  });
});
