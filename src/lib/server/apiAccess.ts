/**
 * Route-level access control for the money/data API surfaces — the ONE
 * module that answers "who is calling, and whose data may they touch?"
 *
 * Three verdicts, composed from the two established identity helpers:
 *
 *   - requireOperator(request)          — the admin gate ONLY (signed
 *     operator cookie). Every release/payout initiation and every
 *     operator-only engine surface (reversals, dispute locks, recoupment,
 *     split calculation, BaaS rails) answers this.
 *   - requireHolderAccess(request, id?) — operator OR the OWNING creator.
 *     A creator session's holder id is DERIVED from the verified session
 *     (resolveSessionCreator), never read from the client: a supplied id
 *     that differs from the session's own is 403 holder_mismatch. This is
 *     the IDOR wall for every "give me holder X's numbers" surface.
 *   - requireRegisteredOrOperator(request) — operator OR any registered
 *     creator, no holder binding (the /api/ledger read).
 *
 * Failure mapping is fail-closed and honest: no admin secret configured →
 * 503 admin_not_configured (the gate's own verdict, unchanged); no valid
 * operator cookie → 401; no creator session → 401 no_session; a signed-in
 * creator reaching for another holder's data → 403 holder_mismatch; a
 * signed-in but unenrolled session → 403 not_registered. No failure
 * response carries data.
 */

import { checkAdminGate, type AdminGateFailure } from '@/lib/admin/gate';
import { resolveSessionCreator } from '@/lib/server/sessionCreator';

/** The failure shape every access verdict shares (status + named code). */
export type ApiAccessFailure = {
  ok: false;
  status: 401 | 403 | 503;
  code: 'admin_not_configured' | 'admin_not_authenticated' | 'no_session' | 'not_registered' | 'holder_mismatch';
  message: string;
};

export type OperatorAccess = { ok: true; role: 'operator' } | ApiAccessFailure;

/**
 * Operator-only surfaces: the signed admin session cookie, verified before
 * any data is touched. The gate's verdict passes through unchanged — an
 * unset ADMIN_DASHBOARD_PASSWORD stays 503 admin_not_configured, an
 * absent/expired/invalid cookie stays 401 (the console routes' posture).
 */
export function requireOperator(request: {
  headers: { get(name: string): string | null };
}): OperatorAccess {
  const gate = checkAdminGate(request);
  if (gate.ok) return { ok: true, role: 'operator' };
  const failure: AdminGateFailure = gate;
  return { ok: false, status: failure.status, code: failure.code, message: failure.message };
}

export type HolderAccess =
  | { ok: true; role: 'operator' | 'owner'; holderId: string | null }
  | ApiAccessFailure;

/**
 * Holder-scoped surfaces. `requestedHolderId` is whatever the CLIENT named
 * (query param, body field) — treated as a claim to VERIFY, never trusted.
 *
 * - Operator: may address any holder; null holderId = the unscoped request
 *   (e.g. "list every vault"). The route decides what unscoped means.
 * - Owner: holderId is ALWAYS the session's own payee_id. A supplied id
 *   that differs from it is refused 403 before any read runs; when the
 *   client names no id, own is implied.
 * - Neither identity → 401 no_session.
 */
export async function requireHolderAccess(
  request: { headers: { get(name: string): string | null } },
  requestedHolderId?: string | null,
): Promise<HolderAccess> {
  const requested = requestedHolderId?.trim() ? requestedHolderId.trim() : null;
  if (checkAdminGate(request).ok) {
    return { ok: true, role: 'operator', holderId: requested };
  }

  const session = await resolveSessionCreator();
  if (session.kind === 'anonymous') {
    return {
      ok: false,
      status: 401,
      code: 'no_session',
      message: 'Sign in to access holder data.',
    };
  }
  if (session.kind === 'unregistered') {
    return {
      ok: false,
      status: 403,
      code: 'not_registered',
      message: 'This session is not enrolled as a rights holder.',
    };
  }

  const own = session.creator.payee_id;
  if (requested !== null && requested !== own) {
    return {
      ok: false,
      status: 403,
      code: 'holder_mismatch',
      message: 'The requested holder does not belong to this session.',
    };
  }
  return { ok: true, role: 'owner', holderId: own };
}

export type ReaderAccess = { ok: true; role: 'operator' | 'owner' } | ApiAccessFailure;

/**
 * Reader surfaces with no holder binding (GET /api/ledger): the operator
 * cookie OR any registered creator session. Anonymous callers get 401; a
 * signed-in but unenrolled session gets 403 — authenticated, not authorized.
 */
export async function requireRegisteredOrOperator(request: {
  headers: { get(name: string): string | null };
}): Promise<ReaderAccess> {
  if (checkAdminGate(request).ok) return { ok: true, role: 'operator' };

  const session = await resolveSessionCreator();
  if (session.kind === 'registered') return { ok: true, role: 'owner' };
  if (session.kind === 'anonymous') {
    return {
      ok: false,
      status: 401,
      code: 'no_session',
      message: 'Sign in to read the ledger.',
    };
  }
  return {
    ok: false,
    status: 403,
    code: 'not_registered',
    message: 'This session is not enrolled as a rights holder.',
  };
}
