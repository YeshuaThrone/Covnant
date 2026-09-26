/**
 * Timing-safe shared-secret checks for inbound webhooks.
 *
 * The claims webhook has no Supabase session and no admin console — its
 * callers are machines presenting a provisioning-time secret. The check
 * fails CLOSED: an unset secret refuses every request (the webhook is
 * unavailable, never open), and a presented secret is compared through a
 * fixed-domain HMAC so the comparison time never varies with the input
 * (the same discipline the admin gate's safeEqual uses).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const WEBHOOK_KEY_DOMAIN = 'covnant-webhook-secret';

function mac(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

/**
 * Constant-time string equality — timingSafeEqual throws on length
 * mismatch, so both sides are normalized through the fixed-domain HMAC and
 * a length mismatch burns one self-comparison to keep the timing flat.
 */
export function timingSafeStringsEqual(a: string, b: string): boolean {
  const left = Buffer.from(mac(a, WEBHOOK_KEY_DOMAIN), 'utf8');
  const right = Buffer.from(mac(b, WEBHOOK_KEY_DOMAIN), 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * The presented-vs-configured webhook secret check. False when the secret
 * is unset/empty (fail closed), when nothing was presented, or on any
 * mismatch — the caller answers 401 and processes nothing.
 */
export function sharedSecretMatches(presented: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret || secret.length === 0) return false;
  if (!presented || presented.length === 0) return false;
  return timingSafeStringsEqual(presented, secret);
}
