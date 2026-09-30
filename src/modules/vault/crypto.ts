/**
 * Vault credential crypto — the Plaid token cipher's pattern applied to the
 * UCT credential vault (PR 5). AES-256-GCM via node:crypto, key derived as
 * SHA-256 of env material with a sandbox fallback, wire format
 * `enc:v1:<iv>.<tag>.<ciphertext>` in base64url — the SAME convention as
 * src/modules/plaid/crypto.ts, so the codebase keeps one ciphertext shape
 * and one audit surface. This module adds what the Plaid one never needed:
 * the decrypt half, for the Astra agent that must USE the credentials
 * (PR 6) — routes never import it.
 *
 * Secrecy rules this module enforces by construction:
 *   - the plaintext never appears in an error message (failures throw
 *     VaultCryptoError with shape-only wording),
 *   - every encryption draws a fresh random IV, so encrypting the same
 *     credential twice never yields the same ciphertext,
 *   - GCM's auth tag fails any tampered byte before a plaintext is produced.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { PLAID_TOKEN_ENC_PREFIX } from '@/modules/don/constants';

/** Re-exported under the vault's own name — one wire format, two consumers. */
export const VAULT_CREDENTIALS_ENC_PREFIX = PLAID_TOKEN_ENC_PREFIX; // "enc:v1:"

/** Sandbox key material — the Plaid pattern's dev fallback; production sets the env. */
const SANDBOX_KEY_MATERIAL = 'don-engine-sandbox-distributor-vault-key';

export function distributorVaultKey(): Buffer {
  const fromEnv = process.env.DISTRIBUTOR_VAULT_ENCRYPTION_KEY;
  const material =
    typeof fromEnv === 'string' && fromEnv.trim() !== ''
      ? fromEnv.trim()
      : SANDBOX_KEY_MATERIAL;
  return createHash('sha256').update(material).digest();
}

export function isEncryptedCredential(value: string): boolean {
  return value.startsWith(VAULT_CREDENTIALS_ENC_PREFIX);
}

/** Malformed or tampered ciphertext — thrown with NO plaintext fragments. */
export class VaultCryptoError extends Error {
  constructor(
    public readonly reason:
      | 'malformed_ciphertext'
      | 'unsupported_version'
      | 'tampered_ciphertext',
    message: string,
  ) {
    super(message);
    this.name = 'VaultCryptoError';
  }
}

export function encryptCredential(
  plaintext: string,
  iv: Buffer = randomBytes(12),
): string {
  const cipher = createCipheriv('aes-256-gcm', distributorVaultKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VAULT_CREDENTIALS_ENC_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

/**
 * Reverses encryptCredential — the Astra agent's read path (PR 6), never a
 * route's. Throws VaultCryptoError on a malformed string or an auth-tag
 * failure (wrong key, tampered byte), without disclosing plaintext.
 */
export function decryptCredential(encString: string): string {
  if (!isEncryptedCredential(encString)) {
    throw new VaultCryptoError(
      'malformed_ciphertext',
      'Vault credential is not in the enc:v1 wire format.',
    );
  }
  const parts = encString.slice(VAULT_CREDENTIALS_ENC_PREFIX.length).split('.');
  if (parts.length !== 3) {
    throw new VaultCryptoError(
      'malformed_ciphertext',
      'Vault credential ciphertext does not carry iv.tag.ciphertext segments.',
    );
  }
  const [ivSegment, tagSegment, dataSegment] = parts;
  let iv: Buffer;
  let tag: Buffer;
  let encrypted: Buffer;
  try {
    iv = Buffer.from(ivSegment, 'base64url');
    tag = Buffer.from(tagSegment, 'base64url');
    encrypted = Buffer.from(dataSegment, 'base64url');
  } catch {
    throw new VaultCryptoError(
      'malformed_ciphertext',
      'Vault credential ciphertext segments are not valid base64url.',
    );
  }
  if (iv.length !== 12 || tag.length !== 16) {
    throw new VaultCryptoError(
      'malformed_ciphertext',
      'Vault credential ciphertext segments have unexpected lengths.',
    );
  }
  const decipher = createDecipheriv('aes-256-gcm', distributorVaultKey(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw new VaultCryptoError(
      'tampered_ciphertext',
      'Vault credential ciphertext failed authentication — wrong key or tampered bytes.',
    );
  }
}
