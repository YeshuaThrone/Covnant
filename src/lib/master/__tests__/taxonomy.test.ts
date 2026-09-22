/**
 * Master taxonomy canon gates — the seven-vertical master order (the six
 * founder-canon verticals plus the generation-4 Sports & Athletics expansion,
 * 2026-09-22), the exact render order, labels, and the expansion
 * subcategories pinned verbatim.
 */
import { describe, expect, it } from 'vitest';
import {
  ATOMIC_SECTOR_TO_VERTICAL,
  MASTER_CATEGORY_LABELS,
  MASTER_CATEGORY_ORDER,
  MASTER_SUBCATEGORIES,
  sectorsForVertical,
} from '../taxonomy';

describe('the seven-vertical master taxonomy', () => {
  it('pins the extended order — SPORTS_AND_ATHLETICS after LIVE_PERFORMANCE_AND_COMEDY', () => {
    expect(MASTER_CATEGORY_ORDER).toHaveLength(7);
    expect(MASTER_CATEGORY_ORDER[4]).toBe('SPORTS_AND_ATHLETICS');
    expect(MASTER_CATEGORY_ORDER[3]).toBe('LIVE_PERFORMANCE_AND_COMEDY');
  });

  it('labels the expansion vertical in the existing style — Sports & Athletics', () => {
    expect(MASTER_CATEGORY_LABELS.SPORTS_AND_ATHLETICS).toBe('Sports & Athletics');
  });

  it('pins the three expansion subcategories verbatim', () => {
    expect(MASTER_SUBCATEGORIES.SPORTS_AND_ATHLETICS).toEqual([
      'Traditional Sponsorship',
      'Tournament Prize Pools',
      'Athlete Endorsements',
    ]);
  });

  it('maps the expansion sectors onto their verticals and back — no unmapped door', () => {
    expect(ATOMIC_SECTOR_TO_VERTICAL.SPORTS).toBe('SPORTS_AND_ATHLETICS');
    expect(ATOMIC_SECTOR_TO_VERTICAL.SPORTS_AND_ATHLETICS).toBe('SPORTS_AND_ATHLETICS');
    expect(ATOMIC_SECTOR_TO_VERTICAL.ESPORTS).toBe('INTERACTIVE_AND_DIGITAL_MEDIA');
    expect(ATOMIC_SECTOR_TO_VERTICAL.SPONSORSHIP).toBe('COMMERCIAL_AND_BRAND_LICENSING');
    expect(sectorsForVertical('SPORTS_AND_ATHLETICS')).toEqual([
      'SPORTS',
      'SPORTS_AND_ATHLETICS',
    ]);
  });
});
