/**
 * Contract template catalog gates — directive §4: twenty deterministic
 * agreements across five categories, with the Fashion & Apparel vertical
 * mapping onto the persistence-safe FILM_MEDIA_MERCH industry and generating
 * deterministically from the asset of record.
 */
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  CLAUSE_LABELS,
  getTemplate,
  TEMPLATES,
} from '../templates';
import type { PoolName } from '@/lib/splits/shared';
import {
  DEFAULT_FIELDS,
  generateAgreement,
  type AgreementContext,
  type AgreementParty,
  type AgreementPool,
} from '../generator';

const party: AgreementParty = {
  name: 'Atelier Vale',
  role: 'Rights Holder',
  pools: 'Master',
  sharePercent: '100.0000',
  isni: undefined,
  ipi: undefined,
};

const pool: AgreementPool = {
  pool: 'MASTER' as PoolName,
  label: 'Master',
  totalPercent: '100.0000',
  holders: [party],
};

const ctx: AgreementContext = {
  asset: {
    title: 'Vale Autumn Capsule',
    mediumLabel: 'Fashion Design',
    cbtCode: 'CBT-TRK-F4SH10NTEST1',
    displayCode: 'CVT-TRK-EST1',
    identifiers: [],
  },
  pools: [pool],
  parties: [party],
  fields: DEFAULT_FIELDS,
};

describe('contract template catalog', () => {
  it('lists twenty deterministic agreements across five categories', () => {
    expect(TEMPLATES).toHaveLength(20);
    expect(CATEGORY_ORDER).toEqual(['MUSIC', 'FILM_TV', 'GAMING', 'CREATORS', 'FASHION']);
    for (const category of CATEGORY_ORDER) {
      expect(CATEGORY_LABELS[category]).toBeTruthy();
      expect(TEMPLATES.some((t) => t.category === category)).toBe(true);
    }
  });

  it('adds the Fashion & Apparel vertical on the persistence-safe industry', () => {
    const fashion = TEMPLATES.filter((t) => t.category === 'FASHION');
    expect(fashion.map((t) => t.name)).toEqual([
      'Fashion Design License Agreement',
      'Apparel Manufacturing & Production Agreement',
      'Brand Collaboration Agreement',
      'Runway/Event Talent Release',
    ]);
    for (const t of fashion) {
      expect(t.industry).toBe('FILM_MEDIA_MERCH');
      for (const clause of t.clauseOrder) {
        expect(CLAUSE_LABELS[clause], `label for ${clause}`).toBeTruthy();
      }
    }
  });

  it('generates the Fashion Design License deterministically from the asset of record', () => {
    const template = getTemplate('FASHION_DESIGN_LICENSE');
    expect(template).toBeDefined();

    const first = generateAgreement(template!, ctx);
    const second = generateAgreement(template!, ctx);
    expect(first.document).toBe(second.document);
    expect(first.document).toContain('FASHION DESIGN LICENSE AGREEMENT');
    expect(first.document).toContain('CBT-TRK-F4SH10NTEST1');
    expect(first.document).toContain('Vale Autumn Capsule');
  });
});
