/**
 * The vault's cipher battery (PR 5) — round-trip, secrecy, and tamper
 * properties of the AES-256-GCM credential cipher (the Plaid token
 * pattern's wire format, extended with the decrypt half the Astra agent
 * will use in PR 6):
 *
 *   - round-trip: decryptCredential(encryptCredential(x)) === x, for
 *     credentials carrying unicode, punctuation, and leading whitespace
 *     (a password's leading space is part of the password);
 *   - fresh IVs: encrypting the SAME plaintext twice never yields the
 *     same ciphertext (offline fingerprinting of the vault's at-rest
 *     column must learn nothing);
 *   - wire format: the enc:v1 prefix (the house convention) and the
 *     iv.tag.ciphertext segments;
 *   - tamper: a flipped ciphertext byte fails authentication with
 *     VaultCryptoError('tampered_ciphertext') — and the error NEVER
 *     carries a plaintext fragment;
 *   - malformed: a non-enc:v1 string or a truncated segment fails with
 *     'malformed_ciphertext', never a crypto primitive error.
 */
import { describe, expect, it } from 'vitest';

import {
  VAULT_CREDENTIALS_ENC_PREFIX,
  VaultCryptoError,
  decryptCredential,
  encryptCredential,
  isEncryptedCredential,
} from '../crypto';

const CREDENTIALS = [
  'artist@distrokid.com',
  'pässwörd with späces and — dashes',
  ' leading space is part of the password ',
  'p@$$w0rd!"#$%&\'()*+,-./:;<=>?[]^_`{|}~',
  '0',
];

describe('vault credential cipher — round-trip and secrecy', () => {
  it.each(CREDENTIALS)('round-trips a credential verbatim: %s', (plaintext) => {
    expect(decryptCredential(encryptCredential(plaintext))).toBe(plaintext);
  });

  it('draws a fresh IV per encryption — same plaintext, different ciphertext', () => {
    const first = encryptCredential('artist@distrokid.com');
    const second = encryptCredential('artist@distrokid.com');
    expect(first).not.toBe(second);
    // Both still decrypt to the same plaintext.
    expect(decryptCredential(first)).toBe('artist@distrokid.com');
    expect(decryptCredential(second)).toBe('artist@distrokid.com');
  });

  it('emits the house enc:v1 wire format with iv.tag.ciphertext segments', () => {
    const enc = encryptCredential('artist@distrokid.com');
    expect(enc.startsWith(VAULT_CREDENTIALS_ENC_PREFIX)).toBe(true);
    const segments = enc.slice(VAULT_CREDENTIALS_ENC_PREFIX.length).split('.');
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(segment).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    }
  });

  it('isEncryptedCredential distinguishes ciphertext from plaintext', () => {
    expect(isEncryptedCredential(encryptCredential('x'))).toBe(true);
    expect(isEncryptedCredential('artist@distrokid.com')).toBe(false);
    expect(isEncryptedCredential('')).toBe(false);
  });
});

describe('vault credential cipher — tamper and malformed input', () => {
  it('fails authentication on a flipped ciphertext byte — never producing plaintext', () => {
    const enc = encryptCredential('artist@distrokid.com');
    const tampered = `${enc.slice(0, -2)}${enc.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
    expect(() => decryptCredential(tampered)).toThrow(VaultCryptoError);
    try {
      decryptCredential(tampered);
      expect.unreachable('tampered ciphertext must throw');
    } catch (error) {
      expect((error as VaultCryptoError).reason).toBe('tampered_ciphertext');
      // The error NEVER discloses the plaintext.
      expect((error as Error).message).not.toContain('artist@distrokid.com');
    }
  });

  it('rejects a non-enc:v1 string as malformed — a plaintext never decrypts', () => {
    expect(() => decryptCredential('artist@distrokid.com')).toThrow(VaultCryptoError);
    try {
      decryptCredential('artist@distrokid.com');
      expect.unreachable('plaintext must not decrypt');
    } catch (error) {
      expect((error as VaultCryptoError).reason).toBe('malformed_ciphertext');
      expect((error as Error).message).not.toContain('artist@distrokid.com');
    }
  });

  it('rejects a truncated segment as malformed', () => {
    expect(() => decryptCredential(`${VAULT_CREDENTIALS_ENC_PREFIX}onlytwo.segments`)).toThrow(
      VaultCryptoError,
    );
  });

  it('rejects a corrupted IV segment as malformed', () => {
    expect(() => decryptCredential(`${VAULT_CREDENTIALS_ENC_PREFIX}%.%.%`)).toThrow(
      VaultCryptoError,
    );
  });
});
