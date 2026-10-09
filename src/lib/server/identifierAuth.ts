/**
 * Tenant-aware JWT authentication + RBAC — founder canon v24 (artifact
 * Founder v24 Tenant-Aware JWT Authentication + RBAC Middleware), adapted
 * to Next.js App Router per the v13 precedent: Express middleware becomes
 * guard helpers whose verdicts the route maps to responses. Status codes,
 * messages, and body shapes are byte-compatible with the founder contract.
 *
 * ENGINE MIDDLEWARE CHAIN (canon order): authenticateJWT → requireRole →
 * slidingWindowRateLimiter (v22) → validateIdentifier syntax gate →
 * handler. The telemetry webhook stays HMAC-only (machine-to-machine, no
 * JWT). Expired tokens return 403 (founder choice, carried verbatim — the
 * 403 body does not distinguish invalid vs expired, avoiding token-intel
 * leakage).
 *
 * SECRET HANDLING (audit S1 — the strongest dev-only-canon warning,
 * carried in the PR body): the founder default
 * 'secure_jwt_secret_secret_2026' was a public constant in source — a
 * well-known signing key lets anyone forge admin tokens. It is REMOVED:
 * JWT_SECRET is required in EVERY environment, and when it is unset every
 * bearer request is rejected (the 403 verify-failure path) — fail closed
 * unconditionally, local dev included.
 *
 * ROLE VOCAB RELATIONSHIP (flagged): the four JWT roles gate the
 * identifier-ENGINE API surfaces only; the platform's UCT/CVT/CBT tiers
 * and Supabase Auth remain the platform models — coexistence by layer,
 * same pattern as the two rate limiters (v22). Mapping flagged for founder
 * confirmation.
 */

import jwt from 'jsonwebtoken';

export type UserRole = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'OPERATOR' | 'VIEWER';

export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  roles: UserRole[];
}

/**
 * The signing secret for the current runtime — undefined whenever
 * JWT_SECRET is unset, in EVERY environment (fail closed; no dev fallback).
 */
function jwtSecret(): string | undefined {
  return process.env.JWT_SECRET || undefined;
}

/** The founder 401 body — carried verbatim. */
export const MISSING_AUTH_HEADER_BODY = {
  error: 'Missing or malformed Authorization header.',
} as const;

/** The founder 403 body — carried verbatim (invalid AND expired alike). */
export const INVALID_TOKEN_BODY = {
  error: 'Invalid or expired authentication token.',
} as const;

/** The founder requireRole 401 body — carried verbatim. */
export const NO_USER_CONTEXT_BODY = {
  error: 'Unauthorized request context.',
} as const;

/**
 * Verify the Bearer JWT and resolve the user context. Returns the user on
 * success or the founder-contract error Response (401/403) the route
 * returns unchanged.
 */
export function authenticateJWT(
  request: Request,
): { ok: true; user: AuthenticatedUser } | { ok: false; response: Response } {
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      ok: false,
      response: Response.json(MISSING_AUTH_HEADER_BODY, { status: 401 }),
    };
  }
  const token = authHeader.split(' ')[1];
  const secret = jwtSecret();
  if (!secret) {
    // Fail closed: an unset JWT_SECRET rejects every bearer request in
    // every environment (refuse-to-start is impossible per-request; the
    // reject-all equivalent is this path).
    console.error(
      '[identifier-engine] JWT_SECRET is unset — failing closed on all bearer requests.',
    );
    return {
      ok: false,
      response: Response.json(INVALID_TOKEN_BODY, { status: 403 }),
    };
  }
  try {
    const decoded = jwt.verify(token, secret) as AuthenticatedUser;
    return { ok: true, user: decoded };
  } catch {
    return {
      ok: false,
      response: Response.json(INVALID_TOKEN_BODY, { status: 403 }),
    };
  }
}

/**
 * Enforce role-based access control (canon v24). 401 'Unauthorized request
 * context.' without user context; 403 {error, requiredRoles, userRoles} on
 * a role miss.
 */
export function requireRole(
  user: AuthenticatedUser | null,
  allowedRoles: UserRole[],
): { ok: true } | { ok: false; response: Response } {
  if (!user) {
    return {
      ok: false,
      response: Response.json(NO_USER_CONTEXT_BODY, { status: 401 }),
    };
  }
  const hasPermission = user.roles.some((role) => allowedRoles.includes(role));
  if (!hasPermission) {
    return {
      ok: false,
      response: Response.json(
        {
          error: 'Forbidden: Insufficient role privileges to execute this operation.',
          requiredRoles: allowedRoles,
          userRoles: user.roles,
        },
        { status: 403 },
      ),
    };
  }
  return { ok: true };
}

/**
 * The ingestion write surface's role budget (founder v24 defines the four
 * roles; VIEWER is read-only by name). FLAGGED for founder confirmation —
 * the canon does not bind roles per surface.
 */
export const ENGINE_INGEST_ROLES: UserRole[] = [
  'SUPER_ADMIN',
  'TENANT_ADMIN',
  'OPERATOR',
];
