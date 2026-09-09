/**
 * Admin console gate — server-side shared-secret check + signed session
 * cookie, scoped to the admin surface.
 *
 * Fail-closed by construction:
 *   - ADMIN_DASHBOARD_PASSWORD unset → every admin route/action answers
 *     503 admin_not_configured (the supabase_not_configured shape) — the
 *     console is unavailable, never open.
 *   - Wrong password → 401; no cookie is minted and no state changes.
 *   - Every /api/admin route and the gated server action verify the signed
 *     cookie before touching data; an absent/expired/invalid cookie is
 *     401 admin_not_authenticated. Neither failure response carries data.
 *
 * Deliberately NOT global middleware: middleware.ts is the session
 * foundation PR's file and may merge mid-flight — a shared-secret console
 * gate must not collide with it. The checks live beside the surfaces that
 * need them (routes here, the /admin page with the PR G console UI).
 *
 * Session token: HMAC-SHA256 over an expiry epoch, keyed by the admin
 * password itself — rotating the password invalidates every outstanding
 * session at once, with no second secret to configure or leak. Signature
 * comparison is constant-time (timingSafeEqual); the password is never
 * logged, never echoed, and never leaves the server.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_COOKIE_NAME = 'covnant_admin_session';

/** One operator shift — the cookie re-prompts rather than persisting for weeks. */
export const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 8;

/** HMAC key domain-separates the gate from any other HMAC use of the secret. */
const GATE_KEY_DOMAIN = 'covnant-admin-gate';

/** Reads the configured secret; null when unset or empty (fail closed). */
export function readAdminPassword(env: NodeJS.ProcessEnv = process.env): string | null {
  const password = env.ADMIN_DASHBOARD_PASSWORD;
  return password && password.length > 0 ? password : null;
}

function mac(payload: string, password: string): string {
  return createHmac('sha256', password).update(payload).digest('hex');
}

/**
 * Constant-time string comparison. timingSafeEqual throws on length
 * mismatch, so lengths are normalized through a fixed-domain HMAC first and
 * a mismatched length burns one self-comparison to keep the timing flat.
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(mac(a, GATE_KEY_DOMAIN), 'utf8');
  const right = Buffer.from(mac(b, GATE_KEY_DOMAIN), 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Shared-secret check for the login exchange. Fails closed when unset. */
export function adminPasswordMatches(candidate: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const password = readAdminPassword(env);
  if (!password) return false;
  return safeEqual(candidate, password);
}

/**
 * Mints a signed session token, or null when the secret is unset (a caller
 * that checks the password first already returned its fail-closed error —
 * this is the second, paranoid guard).
 */
export function mintAdminSessionToken(
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const password = readAdminPassword(env);
  if (!password) return null;
  const expiresAt = now.getTime() + ADMIN_SESSION_TTL_SECONDS * 1000;
  const payload = String(expiresAt);
  return `${payload}.${mac(payload, password)}`;
}

export type AdminGateFailure = {
  ok: false;
  status: 401 | 503;
  code: 'admin_not_configured' | 'admin_not_authenticated';
  message: string;
};

export type AdminGateVerdict = { ok: true } | AdminGateFailure;

const NOT_CONFIGURED: AdminGateFailure = {
  ok: false,
  status: 503,
  code: 'admin_not_configured',
  message: 'Admin dashboard is not configured.',
};

const NOT_AUTHENTICATED: AdminGateFailure = {
  ok: false,
  status: 401,
  code: 'admin_not_authenticated',
  message: 'Admin sign-in required.',
};

/**
 * Core token check — the gate for the server action (which reads the cookie
 * itself via next/headers) and for every route's cookie header.
 */
export function verifyAdminSession(
  token: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): AdminGateVerdict {
  const password = readAdminPassword(env);
  if (!password) return NOT_CONFIGURED;
  if (!token) return NOT_AUTHENTICATED;

  const dot = token.lastIndexOf('.');
  if (dot <= 0) return NOT_AUTHENTICATED;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, mac(payload, password))) return NOT_AUTHENTICATED;

  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    return { ok: false, status: 401, code: 'admin_not_authenticated', message: 'Admin session expired. Sign in again.' };
  }
  return { ok: true };
}

/** Parses a raw Cookie header for the admin session token (null if absent). */
export function adminSessionTokenFromCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === ADMIN_COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/**
 * Route-level gate — verifies the request's session cookie against the
 * configured secret. Accepts anything with a headers.get (Request,
 * NextRequest) so routes pass their request straight in.
 */
export function checkAdminGate(
  request: { headers: { get(name: string): string | null } },
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): AdminGateVerdict {
  return verifyAdminSession(adminSessionTokenFromCookieHeader(request.headers.get('cookie')), env, now);
}

/** Serialize the Set-Cookie value: signed, httpOnly, SameSite, Secure in production. */
export function adminSessionCookie(token: string): string {
  const attributes = [
    `${ADMIN_COOKIE_NAME}=${token}`,
    'Path=/',
    `Max-Age=${ADMIN_SESSION_TTL_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (process.env.NODE_ENV === 'production') attributes.push('Secure');
  return attributes.join('; ');
}
