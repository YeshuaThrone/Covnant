/**
 * Plaid webhook signature verification — Plaid's OWN scheme (JWT over JWK),
 * distinct from the Stripe HMAC and Standard Webhooks verifiers elsewhere in
 * the repo. Pinned from Plaid's webhook-verification documentation
 * (plaid.com/docs/api/webhooks/webhook-verification/, retrieved 2026-10-06):
 *
 *   header:   Plaid-Verification: <compact JWS JWT>   (case-insensitive name)
 *   jwt head: { "alg": "ES256", "kid": "<uuid>", "typ": "JWT" }
 *   jwt body: { "iat": <unix-seconds>, "request_body_sha256": "<hex>" }
 *   key:      POST /webhook_verification_key/get { client_id, secret, key_id }
 *             → { key: { kty: "EC", crv: "P-256", use: "sig", x, y, ... } }
 *
 * Verification steps, in the documented order:
 *   1. alg must be exactly "ES256" — anything else rejects (no `none`, no HMAC).
 *   2. The JWK matching the header's kid verifies the signature (EC P-256;
 *      JWS EC signatures are the raw r‖s form — node's `dsaEncoding:
 *      'ieee-p1363'`).
 *   3. `iat` must be no more than 5 minutes old (Plaid's replay recommendation)
 *      and not meaningfully in the future.
 *   4. SHA-256 over the EXACT raw request body must equal the
 *      `request_body_sha256` claim, compared in constant time — the body the
 *      route parses is provably the body Plaid signed.
 *
 * Fail-closed throughout: a missing header, a bad signature, a stale/absent
 * iat, or a body-hash mismatch refuses the delivery before any parse. The
 * key transport is injected — production wires it to Plaid's
 * credential-gated /webhook_verification_key/get (src/lib/escrow/plaidApi.ts);
 * tests sign with locally generated ES256 keypairs and serve the matching JWK
 * through a fake transport. The live rail is never faked-enabled here.
 */

import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

/** Plaid's documented replay window: reject webhooks older than 5 minutes. */
export const PLAID_SIGNATURE_TOLERANCE_SECONDS = 300;

/** The only JWT algorithm Plaid documents for webhook signatures. */
const REQUIRED_ALG = 'ES256';
const REQUIRED_CRV = 'P-256';
const REQUIRED_KTY = 'EC';

/** The JWT header as Plaid documents it. */
export interface PlaidJwtHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

/** The JWT claim set as Plaid documents it. */
export interface PlaidJwtClaims {
  iat?: unknown;
  request_body_sha256?: unknown;
}

/** The webhook verification key as returned by /webhook_verification_key/get. */
export interface PlaidWebhookJwk {
  kty?: unknown;
  crv?: unknown;
  use?: unknown;
  x?: unknown;
  y?: unknown;
  kid?: unknown;
}

/** Decode a JWS segment as JSON without trusting a byte of it. Returns null on any malformation. */
function decodeJsonSegment<T>(segment: string): T | null {
  let json: string;
  try {
    json = Buffer.from(segment, 'base64url').toString('utf8');
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * The verification result. `claims` is returned only on `ok` — the claims of
 * a JWT whose signature, iat, and body-hash all checked out.
 */
export type PlaidSignatureVerification =
  | { ok: true; claims: PlaidJwtClaims }
  | { ok: false; reason: 'malformed_jwt' | 'bad_algorithm' | 'missing_kid' | 'unsupported_key' | 'bad_signature' | 'missing_iat' | 'stale_iat' | 'future_iat' | 'missing_body_hash' | 'body_hash_mismatch' };

/**
 * Verify a Plaid webhook's signature against a verification-key JWK, per the
 * documented steps. Pure — no I/O; the caller supplies the key material
 * (already fetched for the JWT's kid) and the exact raw body bytes.
 */
export function verifyPlaidWebhookSignature(params: {
  rawBody: string;
  verificationJwt: string;
  verificationKey: PlaidWebhookJwk;
  /** Unix-seconds now; defaults to the wall clock. Injectable for tests. */
  nowSeconds?: number;
}): PlaidSignatureVerification {
  const parts = params.verificationJwt.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed_jwt' };
  }
  const [headSegment, payloadSegment, sigSegment] = parts;

  const header = decodeJsonSegment<PlaidJwtHeader>(headSegment);
  if (header === null || typeof header !== 'object') {
    return { ok: false, reason: 'malformed_jwt' };
  }
  // Step 1 — algorithm pin: reject anything that is not exactly ES256.
  if (header.alg !== REQUIRED_ALG) {
    return { ok: false, reason: 'bad_algorithm' };
  }
  if (typeof header.kid !== 'string' || header.kid === '') {
    return { ok: false, reason: 'missing_kid' };
  }

  // Step 2 — signature over header.payload with the kid's JWK.
  const jwk = params.verificationKey;
  if (
    typeof jwk !== 'object' ||
    jwk === null ||
    jwk.kty !== REQUIRED_KTY ||
    jwk.crv !== REQUIRED_CRV ||
    typeof jwk.x !== 'string' ||
    typeof jwk.y !== 'string' ||
    jwk.x === '' ||
    jwk.y === ''
  ) {
    return { ok: false, reason: 'unsupported_key' };
  }
  try {
    const signature = Buffer.from(sigSegment, 'base64url');
    const publicKey = createPublicKey({ key: jwk as { kty: string; crv: string; x: string; y: string }, format: 'jwk' });
    const verified = cryptoVerify(
      'sha256',
      Buffer.from(`${headSegment}.${payloadSegment}`, 'ascii'),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signature,
    );
    if (!verified) {
      return { ok: false, reason: 'bad_signature' };
    }
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }

  const claims = decodeJsonSegment<PlaidJwtClaims>(payloadSegment);
  if (claims === null || typeof claims !== 'object') {
    return { ok: false, reason: 'malformed_jwt' };
  }

  // Step 3 — iat freshness (Plaid's 5-minute replay recommendation).
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) {
    return { ok: false, reason: 'missing_iat' };
  }
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (now - claims.iat > PLAID_SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale_iat' };
  }
  // A claim from the future is clock garbage or an attack — refuse with the
  // same symmetric tolerance as staleness.
  if (claims.iat - now > PLAID_SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'future_iat' };
  }

  // Step 4 — the body Plaid signed is the body received (timing-safe).
  if (typeof claims.request_body_sha256 !== 'string' || claims.request_body_sha256 === '') {
    return { ok: false, reason: 'missing_body_hash' };
  }
  const bodyHash = createHash('sha256').update(params.rawBody, 'utf8').digest('hex');
  const claimed = Buffer.from(claims.request_body_sha256, 'utf8');
  const computed = Buffer.from(bodyHash, 'utf8');
  if (claimed.length !== computed.length || !timingSafeEqual(claimed, computed)) {
    return { ok: false, reason: 'body_hash_mismatch' };
  }

  return { ok: true, claims };
}

/**
 * Sign a verification JWT the way Plaid does — for TESTS only: real
 * deliveries verify, they never construct. `signPayload` must produce the
 * raw r‖s (ieee-p1363) ECDSA signature over the signing input, matching the
 * `dsaEncoding: 'ieee-p1363'` verification above.
 */
export function signPlaidVerificationJwt(params: {
  header: { alg: string; kid: string; typ?: string };
  claims: { iat: number; request_body_sha256: string };
  signPayload: (signingInput: string) => Buffer;
}): string {
  const headSegment = Buffer.from(JSON.stringify(params.header), 'utf8').toString('base64url');
  const payloadSegment = Buffer.from(JSON.stringify(params.claims), 'utf8').toString('base64url');
  const signature = params.signPayload(`${headSegment}.${payloadSegment}`);
  return `${headSegment}.${payloadSegment}.${signature.toString('base64url')}`;
}
