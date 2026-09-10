/**
 * The 201 session-capture act — adopt the Supabase session returned by a
 * creating signup response in the browser, so the freshly minted creator
 * lands on their workspace already signed in. Returns false when the
 * identity service is unconfigured or the adoption fails; the caller
 * renders the honest state either way (the composition never pretends a
 * capture succeeded).
 */

import { createBrowserSupabaseClient } from '@/lib/auth/browserClient';
import type { SealSession } from '@/components/landing/signupRequest';

export async function adoptSignupSession(session: SealSession): Promise<boolean> {
  const client = createBrowserSupabaseClient();
  if (!client) return false;
  const { error } = await client.auth.setSession({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
  });
  if (error) {
    // Surfaced, never swallowed: the seal composition still renders, and
    // the workspace honestly shows its unregistered state if the creator
    // proceeds without a captured session.
    console.warn('Covnant: the signup session could not be captured.', error);
    return false;
  }
  return true;
}
