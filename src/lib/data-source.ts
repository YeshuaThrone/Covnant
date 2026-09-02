/**
 * Data source resolution for the Covenant platform.
 *
 * The engine persists to Supabase when credentials are present; without them
 * it runs purely in-memory (v1 ships without authentication, and Supabase
 * persistence activates once keys are configured). The vendored
 * CovenantMasterSDK reads these env vars directly in its server actions; this
 * module exposes the same switch for the rest of the app and for tests.
 */
export type DataSourceMode = 'memory' | 'supabase';

export const SUPABASE_URL_ENV = 'NEXT_PUBLIC_SUPABASE_URL';
export const SUPABASE_SERVICE_ROLE_KEY_ENV = 'SUPABASE_SERVICE_ROLE_KEY';

export function resolveDataSourceMode(env: Record<string, string | undefined> = process.env): DataSourceMode {
  return env[SUPABASE_URL_ENV] && env[SUPABASE_SERVICE_ROLE_KEY_ENV] ? 'supabase' : 'memory';
}
