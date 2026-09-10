/**
 * Preview-only demo access — the "paste link → dashboard" path.
 *
 * On PREVIEW deployments (Vercel sets VERCEL_ENV=preview for preview
 * environments), an unauthenticated /dashboard visit is routed through
 * /api/preview/demo-login, which signs in the seeded demo creator and
 * redirects back — a normal authenticated session for a normal creator
 * account, resolved by the SAME fail-closed resolveCovnantMe aggregate.
 * Nothing about session validation, RLS, or /api/covnant/me changes.
 *
 * The gate is the environment, nothing else: on production (VERCEL_ENV is
 * 'production' or anything else) the demo route 404s and /dashboard renders
 * the real visitor state. Tests pin both sides of that contract.
 *
 * The demo credentials are the e2e stub identity (already public in the
 * repo's e2e specs, per the user directive naming them) — a throwaway
 * creator account whose dashboard shows only honest empty/pending states.
 */

/** The seeded demo creator the preview auto-session signs in. */
export const PREVIEW_DEMO_CREATOR_EMAIL = 'nova@example.com';
export const PREVIEW_DEMO_CREATOR_PASSWORD = 'stub-password-1';

/** The route the preview hook bounces through. */
export const PREVIEW_DEMO_LOGIN_PATH = '/api/preview/demo-login';

/**
 * True when demo access may run. Injectable env keeps every caller
 * (route, page, tests) on one definition of "preview".
 */
export function isPreviewDemoAccessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL_ENV === 'preview';
}
