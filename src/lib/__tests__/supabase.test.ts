import { describe, expect, it } from 'vitest';

import { normalizeSupabaseUrl } from '../supabase';

describe('normalizeSupabaseUrl', () => {
  it('passes a project base URL through unchanged', () => {
    expect(normalizeSupabaseUrl('https://xyz.supabase.co')).toBe(
      'https://xyz.supabase.co',
    );
  });

  it('strips a REST path pasted from the dashboard endpoint', () => {
    expect(normalizeSupabaseUrl('https://xyz.supabase.co/rest/v1')).toBe(
      'https://xyz.supabase.co',
    );
  });

  it('strips a REST path with a trailing slash', () => {
    expect(normalizeSupabaseUrl('https://xyz.supabase.co/rest/v1/')).toBe(
      'https://xyz.supabase.co',
    );
  });

  it('strips a lone trailing slash', () => {
    expect(normalizeSupabaseUrl('https://xyz.supabase.co/')).toBe(
      'https://xyz.supabase.co',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeSupabaseUrl('  https://xyz.supabase.co/rest/v1/  ')).toBe(
      'https://xyz.supabase.co',
    );
  });

  it('is idempotent on an already-normalized value', () => {
    expect(normalizeSupabaseUrl('https://xyz.supabase.co')).toBe(
      normalizeSupabaseUrl(normalizeSupabaseUrl('https://xyz.supabase.co')),
    );
  });
});
