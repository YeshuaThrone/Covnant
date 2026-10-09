/**
 * Server-action access gate — the session-based twin of apiAccess.ts.
 *
 * The route gates (requireRegisteredOrOperator and siblings) read the
 * Request's cookie header; 'use server' actions have no Request — they read
 * the same sessions through next/headers. This module composes the same two
 * established identity helpers into the same verdict vocabulary, so an
 * action and a route can never disagree about who may write:
 *
 *   - the signed operator cookie (verifyAdminSession — fail closed when the
 *     admin secret is unset, and the seeded-preview carve-out inside that
 *     gate applies unchanged, which keeps the e2e web server's flows open);
 *   - OR a registered creator session (resolveSessionCreator — the
 *     JWT-validated identity, never a client-supplied id).
 *
 * Failure is fail-closed and honest, mirroring apiAccess's mapping: an
 * anonymous session is no_session, a signed-in-but-unenrolled session is
 * not_registered, and a session READ FAILURE (SessionCreatorReadError) is
 * its own named refusal — never silently treated as anonymous, never let
 * through. Every refusal rides the calling action's own result shape; this
 * module never throws for a refused caller.
 */

import { cookies } from 'next/headers';
import { ADMIN_COOKIE_NAME, verifyAdminSession } from '@/lib/admin/gate';
import {
  resolveSessionCreator,
  SessionCreatorReadError,
  type SessionCreatorResolution,
} from '@/lib/server/sessionCreator';

export type ActionAccessFailure = {
  ok: false;
  code: 'no_session' | 'not_registered' | 'profile_read_failed' | 'registry_read_failed';
  message: string;
};

export type ActionAccess = { ok: true; role: 'operator' | 'owner' } | ActionAccessFailure;

/**
 * Operator (signed admin cookie) OR any registered creator session — the
 * server-action form of apiAccess.requireRegisteredOrOperator. Anonymous
 * callers are refused before the action touches any store.
 */
export async function requireRegisteredOrOperatorAction(): Promise<ActionAccess> {
  const cookieStore = await cookies();
  if (verifyAdminSession(cookieStore.get(ADMIN_COOKIE_NAME)?.value).ok) {
    return { ok: true, role: 'operator' };
  }

  let session: SessionCreatorResolution;
  try {
    session = await resolveSessionCreator();
  } catch (error) {
    // A read failure is neither "anonymous" nor "authorized" — refuse with
    // the read's own named code and let non-read errors keep throwing.
    if (error instanceof SessionCreatorReadError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }

  if (session.kind === 'registered') return { ok: true, role: 'owner' };
  if (session.kind === 'anonymous') {
    return { ok: false, code: 'no_session', message: 'Sign in to make this change.' };
  }
  return {
    ok: false,
    code: 'not_registered',
    message: 'This session is not enrolled as a rights holder.',
  };
}
