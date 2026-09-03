import { describe, it, expect } from 'vitest';
import { BRAND } from '../brand';
import { resolveDataSourceMode } from '../data-source';

describe('brand tokens', () => {
  it('carries the locked Obsidian / Deep Gold palette', () => {
    expect(BRAND.colors.obsidian).toBe('#08080A');
    expect(BRAND.colors.obsidianDeep).toBe('#000000');
    expect(BRAND.colors.darkSlate).toBe('#121318');
    expect(BRAND.colors.metallicGold).toBe('#D4AF37');
    expect(BRAND.colors.champagne).toBe('#F3E5AB');
    expect(BRAND.colors.mutedGold).toBe('#997A15');
    expect(BRAND.colors.emerald).toBe('#10B981');
  });

  it('carries the locked tagline and descriptor', () => {
    expect(BRAND.tagline).toBe('Own Your Creation.');
    expect(BRAND.descriptor).toBe('Automated Contract Vault & Smart Ledger Verification');
    expect(BRAND.name).toBe('Covnant');
  });
});

describe('data source resolution', () => {
  it('falls back to the in-memory registry without Supabase credentials', () => {
    expect(resolveDataSourceMode({})).toBe('memory');
  });

  it('activates Supabase persistence when both credentials exist', () => {
    expect(
      resolveDataSourceMode({
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'key',
      })
    ).toBe('supabase');
  });

  it('stays in memory when only one credential is present', () => {
    expect(resolveDataSourceMode({ NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co' })).toBe('memory');
  });
});
