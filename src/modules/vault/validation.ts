/**
 * Vault connect-request validation (PR 5). The body is deliberately tiny —
 * {distributor, username, password} — because the connect route is the UCT
 * layer's ONE vault write: it validates the shape, encrypts app-side, and
 * hands the ciphertexts to the store. `distributor` reuses the migration
 * 0013 check-constrained vocabulary verbatim; the credential fields are
 * bounded opaque strings (any characters a distributor login may contain,
 * including unicode and punctuation — never trimmed: a password's leading
 * space is part of the password).
 */

import { z } from 'zod';

import { DISTRIBUTOR_CREDENTIAL_SOURCES } from './records';

/**
 * The distributor vocabulary — the migration 0013 check constraint's exact
 * membership, so a validated body can never disagree with the column.
 */
export const distributorSchema = z.enum(DISTRIBUTOR_CREDENTIAL_SOURCES);

/**
 * Bounded opaque credential strings. The ceiling is generous (a distributor
 * login identifier or passphrase beyond 255 characters is not a real
 * account), and keeps a flood body from ever reaching the cipher.
 */
const credentialFieldSchema = z.string().min(1).max(255);

export const connectionRequestSchema = z.object({
  distributor: distributorSchema,
  username: credentialFieldSchema,
  password: credentialFieldSchema,
});

export type ConnectionRequestParse =
  | {
      ok: true;
      value: { distributor: (typeof DISTRIBUTOR_CREDENTIAL_SOURCES)[number]; username: string; password: string };
    }
  | { ok: false; message: string };

/** Parses the connect body into the route's shape, or a 422 message. */
export function parseConnectionRequest(body: unknown): ConnectionRequestParse {
  const parsed = connectionRequestSchema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  const first = parsed.error.issues[0];
  const field = first?.path?.join('.') ?? 'body';
  return {
    ok: false,
    message: `Invalid connection request: ${field} — ${first?.message ?? 'malformed payload'}.`,
  };
}
