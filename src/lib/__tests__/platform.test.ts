import { describe, it, expect } from 'vitest';
import { BRAND } from '../brand';
import { resolveDataSourceMode } from '../data-source';

describe('brand tokens', () => {
  it('carries the locked Deep Onyx / Electric Blue / Metallic Gold palette', () => {
    expect(BRAND.colors.deepOnyx).toBe('#0D0F12');
    expect(BRAND.colors.electricBlue).toBe('#0066FF');
    expect(BRAND.colors.electricBlueBright).toBe('#00C8FF');
    expect(BRAND.colors.metallicGold).toBe('#D4AF37');
    expect(BRAND.colors.metallicGoldBright).toBe('#FFD700');
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
