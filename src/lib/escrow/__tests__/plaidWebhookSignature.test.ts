
import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PLAID_SIGNATURE_TOLERANCE_SECONDS,
  signPlaidVerificationJwt,
  verifyPlaidWebhookSignature,
  type PlaidWebhookJwk,
} from '../plaidWebhookSignature';

/**
 * The webhook signature machinery, exercised directly: ES256 over the exact
 * raw body, the iat freshness window, and every fail-closed refusal reason.
 * The EC pair mirrors Plaid's published key shape (kty EC, crv P-256).
 */

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const OTHER_PAIR = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const verificationKey = publicKey.export({ format: 'jwk' }) as PlaidWebhookJwk;

const BODY = JSON.stringify({
  webhook_type: 'TRANSFER',
  webhook_code: 'TRANSFER_POSTED',
  transfer_id: 'tr_1',
});

function signFor(key: typeof privateKey, body: string, overrides?: { claims?: Record<string, unknown>; header?: Record<string, unknown> }): string {
  return signPlaidVerificationJwt({
    header: { alg: 'ES256', kid: 'key-11', typ: 'JWT', ...overrides?.header },
    claims: {
      iat: Math.floor(Date.now() / 1000),
      request_body_sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      ...overrides?.claims,
    },
    signPayload: (input) =>
      cryptoSign('sha256', Buffer.from(input, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }),
  });
}

describe('verifyPlaidWebhookSignature', () => {
  it('accepts a correctly signed delivery over the exact raw body', () => {
    const verdict = verifyPlaidWebhookSignature({
      rawBody: BODY,
      verificationJwt: signFor(privateKey, BODY),
      verificationKey,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.claims.request_body_sha256).toBe(
        createHash('sha256').update(BODY, 'utf8').digest('hex'),
      );
    }
  });

  it('refuses a body that does not match the signed hash (timing-safe compare)', () => {
    const tampered = BODY.replace('TRANSFER_POSTED', 'TRANSFER_SETTLED');
    const verdict = verifyPlaidWebhookSignature({
      rawBody: tampered,
      verificationJwt: signFor(privateKey, BODY),
      verificationKey,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'body_hash_mismatch' });
  });

  it('refuses a signature from a different key', () => {
    const verdict = verifyPlaidWebhookSignature({
      rawBody: BODY,
      verificationJwt: signFor(OTHER_PAIR.privateKey, BODY),
      verificationKey,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('refuses garbage signature bytes', () => {
    const jwt = signFor(privateKey, BODY).split('.');
    const verdict = verifyPlaidWebhookSignature({
      rawBody: BODY,
      verificationJwt: `${jwt[0]}.${jwt[1]}.${'A'.repeat(20)}`,
      verificationKey,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('refuses stale and future iat claims with the symmetric tolerance', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(PLAID_SIGNATURE_TOLERANCE_SECONDS).toBe(300);
    const stale = verifyPlaidWebhookSignature({
      rawBody: BODY,
      verificationJwt: signFor(privateKey, BODY, { claims: { iat: now - 301 } }),
      verificationKey,
    });
    expect(stale).toMatchObject({ ok: false, reason: 'stale_iat' });
    const future = verifyPlaidWebhookSignature({
      rawBody: BODY,
      verificationJwt: signFor(privateKey, BODY, { claims: { iat: now + 301 } }),
      verificationKey,
    });
    expect(future).toMatchObject({ ok: false, reason: 'future_iat' });
    // Inside the window it still verifies.
    const fresh = verifyPlaidWebhookSignature({
      rawBody: BODY,
      verificationJwt: signFor(privateKey, BODY, { claims: { iat: now - 299 } }),
      verificationKey,
    });
    expect(fresh.ok).toBe(true);
  });

  it('refuses wrong algorithms, missing claims, and malformed tokens', () => {
    const base = { rawBody: BODY, verificationKey };
    expect(
      verifyPlaidWebhookSignature({
        ...base,
        verificationJwt: signFor(privateKey, BODY, { header: { alg: 'HS256' } }),
      }),
    ).toMatchObject({ ok: false, reason: 'bad_algorithm' });
    expect(
      verifyPlaidWebhookSignature({
        ...base,
        verificationJwt: signFor(privateKey, BODY, { header: { kid: '' } }),
      }),
    ).toMatchObject({ ok: false, reason: 'missing_kid' });
    expect(
      verifyPlaidWebhookSignature({
        ...base,
        verificationJwt: signFor(privateKey, BODY, { claims: { iat: undefined } }),
      }),
    ).toMatchObject({ ok: false, reason: 'missing_iat' });
    expect(
      verifyPlaidWebhookSignature({
        ...base,
        verificationJwt: signFor(privateKey, BODY, { claims: { request_body_sha256: undefined } }),
      }),
    ).toMatchObject({ ok: false, reason: 'missing_body_hash' });
    expect(
      verifyPlaidWebhookSignature({ ...base, verificationJwt: 'only.two' }),
    ).toMatchObject({ ok: false, reason: 'malformed_jwt' });
  });

  it('refuses a key that is not the claimed EC P-256 shape', () => {
    const rsaPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaJwk = rsaPair.publicKey.export({ format: 'jwk' }) as PlaidWebhookJwk;
    const verdict = verifyPlaidWebhookSignature({
      rawBody: BODY,
      verificationJwt: signFor(privateKey, BODY),
      verificationKey: rsaJwk,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'unsupported_key' });
  });
});
