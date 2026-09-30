/**
 * The UCT credential vault — record vocabulary for distributor_connections
 * (migration 0013, PR 5). snake_case fields match the database columns 1:1
 * (the Store seam convention — records are the rows). Types are re-exported
 * through the Store seam (src/lib/server/store.ts); the connect/status/
 * disconnect routes consume them and never touch store files.
 *
 * The secrecy contract, in one place: a DistributorConnectionRecord carries
 * ciphertext (`username_encrypted` / `password_encrypted`) because records
 * are rows — but a record is NEVER a response. The only row-to-response
 * path is `toConnectionStatus`, which projects the credential-free public
 * shape; the routes may serialize THAT and nothing else.
 */

/** The distributor dashboards the Astra agent traverses (migration 0013's check constraint). */
export const DISTRIBUTOR_CREDENTIAL_SOURCES = [
  'distrokid',
  'tunecore',
  'ascap',
  'bmi',
] as const;

export type DistributorConnectionSource = (typeof DISTRIBUTOR_CREDENTIAL_SOURCES)[number];

/** Connection lifecycle (migration 0013 check constraint). */
export type DistributorConnectionState = 'connected' | 'disconnected';

/**
 * Input for Store.createDistributorConnection — the connect route's one
 * store call. The ciphertexts are ALREADY applied (the route encrypts
 * app-side before the store boundary, the Plaid token precedent); the
 * store persists them verbatim and never sees plaintext.
 */
export interface DistributorConnectionInput {
  /** The verified session's payee key — the row's scope and its only owner. */
  holder_id: string;
  distributor: DistributorConnectionSource;
  username_encrypted: string;
  password_encrypted: string;
}

/**
 * One durable vault row. `username_encrypted` / `password_encrypted` are
 * AES-256-GCM ciphertext (`enc:v1:...`, src/modules/vault/crypto.ts) —
 * for rows and the Astra agent only, never for responses.
 */
export interface DistributorConnectionRecord {
  id: string;
  holder_id: string;
  distributor: DistributorConnectionSource;
  status: DistributorConnectionState;
  username_encrypted: string;
  password_encrypted: string;
  /** Astra traversal provenance (PR 6); null = never traversed. */
  last_verified_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The create call's outcome — the store KNOWS whether it rotated an
 * existing active row or inserted a fresh one, and surfaces that as data
 * instead of making callers infer it from timestamp equality (two calls in
 * the same millisecond would be indistinguishable).
 */
export interface DistributorConnectionUpsert {
  connection: DistributorConnectionRecord;
  /** true = an existing ACTIVE row's ciphertexts were rotated in place. */
  rotated: boolean;
}

/**
 * The credential-free projection every response serializes. A new field
 * joins this shape only after proving it is neither a credential nor
 * credential material (ciphertext included — the response surface leaks
 * nothing an offline brute-force could start from).
 */
export interface ConnectionPublicStatus {
  id: string;
  distributor: DistributorConnectionSource;
  status: DistributorConnectionState;
  created_at: string;
  updated_at: string;
}

/** The ONLY row-to-response path — projects away both ciphertexts. */
export function toConnectionStatus(record: DistributorConnectionRecord): ConnectionPublicStatus {
  return {
    id: record.id,
    distributor: record.distributor,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}
