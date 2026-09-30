/**
 * CVT Astra extraction agent — credential custody and redaction (PR 6).
 *
 * Vault credentials exist in this worker's memory for exactly one span:
 * from `decryptCredential` (PR 5's house AES-256-GCM read path) until the
 * traversal's session closes. They are passed ONLY into the session's
 * fill() seam, and every string that could ever leave the process —
 * artifacts, error messages, vision-engine payloads — passes through
 * `redactCredentials` first. The no-credential-leak test drives all three
 * lanes (artifact, error, vision) through the scrubber and asserts the
 * plaintexts never survive.
 *
 * The scrubber is exact-string replacement: credential values (and
 * usernames, and the vault's own ciphertexts) are replaced with a fixed
 * house token before anything serializes. Exact strings mean no false
 * positives on statement content; the redaction test also proves
 * statement bytes survive the scrubber byte-identical.
 */

import type { DecryptedDistributorCredentials } from '@/modules/vault/records';

/** The house redaction token — what a scrubbed value becomes. */
export const ASTRA_REDACTION_TOKEN = '[redacted]';

/**
 * Every secret string that must never appear outside the process: the
 * username, the password, and — belt and suspenders — the vault's own
 * ciphertext for both (a leaked ciphertext plus the service-role key would
 * be a decrypt oracle).
 */
export function credentialSecrets(
  credentials: DecryptedDistributorCredentials,
): readonly string[] {
  return [
    credentials.username,
    credentials.password,
    credentials.encryptedUsername,
    credentials.encryptedPassword,
  ].filter((value) => value.length > 0);
}

/**
 * The redaction gate — replace every known secret with the house token.
 * Pure: same input, same output, no state. Statement content passes
 * through untouched except where it collides with a secret (which is
 * exactly when it MUST be replaced).
 */
export function redactCredentials(
  text: string,
  secrets: readonly string[],
): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    redacted = redacted.split(secret).join(ASTRA_REDACTION_TOKEN);
  }
  return redacted;
}

/**
 * The scrubber for thrown traversal errors: message redacted. The
 * traversal engine wraps every catch with this — a raw error's message
 * could embed a filled value (some dashboards echo the username in an
 * "invalid credentials for X" message).
 */
export function redactError(
  error: unknown,
  secrets: readonly string[],
): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactCredentials(message, secrets);
}
