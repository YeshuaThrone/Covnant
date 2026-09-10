import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createAdminClient, createAuthClient, readSupabaseEnv } from '../supabase';

/**
 * Unit tests for the server Supabase factory. Two invariants: the env
 * reader's credential fallbacks, and — load-bearing — the URL
 * normalization: the factory MUST reuse the shared normalizeSupabaseUrl
 * (the PGRST125 production-incident fix, 2026-09-03) so a /rest/v1-suffixed
 * configured URL cannot regress the client into doubled request paths.
 */

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ __fakeClient: true })),
}));

const mockCreateClient = vi.mocked(createClient);

const PUBLIC_ENV = {
  // Bare-tsc gate: next/types/global augments NODE_ENV as required on ProcessEnv.
  NODE_ENV: 'test' as const,
  NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
};

describe('readSupabaseEnv', () => {
  it('reads the documented public credential names', () => {
    expect(readSupabaseEnv(PUBLIC_ENV)).toEqual({
      url: 'https://proj.supabase.co',
      anonKey: 'anon-key',
      serviceRoleKey: 'service-key',
    });
  });

  it('prefers the non-public server-side fallbacks when both names are set', () => {
    const env = {
      ...PUBLIC_ENV,
      SUPABASE_URL: 'https://server-side.supabase.co',
      SUPABASE_ANON_KEY: 'server-anon-key',
    };
    expect(readSupabaseEnv(env)).toEqual({
      url: 'https://server-side.supabase.co',
      anonKey: 'server-anon-key',
      serviceRoleKey: 'service-key',
    });
  });

  it.each([
    ['the project URL', { NODE_ENV: 'test' as const, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'service-key' }],
    ['the anon key', { NODE_ENV: 'test' as const, NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key' }],
    ['the service role key', { NODE_ENV: 'test' as const, NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key' }],
  ])('returns null when %s is missing', (_label, env) => {
    expect(readSupabaseEnv(env)).toBeNull();
  });
});

describe('client factories reuse the shared URL normalization', () => {
  beforeEach(() => {
    mockCreateClient.mockClear();
  });

  it('normalizes a /rest/v1-suffixed URL to the project base for both clients', () => {
    const env = {
      url: 'https://proj.supabase.co/rest/v1/',
      anonKey: 'anon-key',
      serviceRoleKey: 'service-key',
    };

    createAuthClient(env);
    createAdminClient(env);

    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    expect(mockCreateClient).toHaveBeenNthCalledWith(1, 'https://proj.supabase.co', 'anon-key', {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    expect(mockCreateClient).toHaveBeenNthCalledWith(
      2,
      'https://proj.supabase.co',
      'service-key',
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  });

  it('leaves an already-normalized base URL untouched', () => {
    createAuthClient({ url: 'https://proj.supabase.co', anonKey: 'anon-key', serviceRoleKey: 'service-key' });
    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://proj.supabase.co',
      'anon-key',
      expect.anything(),
    );
  });
});
