/**
 * POST /api/admin/vault/identifiers — attach one external identifier to a
 * vault asset; GET /api/admin/vault/identifiers — resolve an external
 * identifier back to its asset.
 *
 * The vault adapter's first PRODUCTION call sites (attachExternalIdentifier /
 * findByIdentifier in src/lib/covnant/vault.ts — previously test-only). The
 * adapter owns every rule that matters here: it addresses assets by their
 * stored CVT code, canonicalizes through the SDK contracts registry's
 * IdentifierSpec (one canonicalizer for attach and lookup, so PR 7's exact
 * matching sees consistent forms on both sides), merges idempotently into
 * cbt_assets.mapped_identifiers (identical pair = no-op, one value per
 * kind, sibling keys survive), and never auto-creates, never fuzzy-matches.
 *
 * GATED: the signed admin session cookie is verified before any data is
 * touched — an unset ADMIN_DASHBOARD_PASSWORD answers 503
 * admin_not_configured, an absent/expired/invalid cookie answers 401, and
 * neither failure response carries data.
 *
 * Fail-closed elsewhere: an unconfigured DATABASE_URL answers 503
 * db_not_configured before any query runs. Rate limited per address AFTER
 * validation so a malformed body never burns the bucket.
 *
 * Idempotency on the wire: a replayed attach reads 200 attached:false —
 * never an error, never a duplicate.
 */

import { checkAdminGate } from '@/lib/admin/gate';
import { getDb } from '@/lib/db';
import { jsonError } from '@/lib/server/http';
import { ADMIN_API_RATE_LIMIT, checkRateLimit } from '@/lib/server/rateLimit';
import {
  VAULT_EXTERNAL_IDENTIFIER_KINDS,
  attachExternalIdentifier,
  findByIdentifier,
  type VaultExternalIdentifierKind,
} from '@/lib/covnant/vault';

export const dynamic = 'force-dynamic';

const VAULT_KIND_SET: ReadonlySet<string> = new Set(VAULT_EXTERNAL_IDENTIFIER_KINDS);

function isVaultKind(kind: unknown): kind is VaultExternalIdentifierKind {
  return typeof kind === 'string' && VAULT_KIND_SET.has(kind);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function clientAddress(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'
  );
}

function rateLimited(retryAfterSeconds: number): Response {
  return jsonError(
    429,
    'rate_limited',
    `Too many vault requests. Try again in ${retryAfterSeconds}s.`,
  );
}

export async function POST(request: Request): Promise<Response> {
  const gate = checkAdminGate(request);
  if (!gate.ok) return jsonError(gate.status, gate.code, gate.message);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'malformed_body', 'Request body must be valid JSON.');
  }
  const payload = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const assetRef = payload.assetRef;
  const kind = payload.kind;
  const value = payload.value;

  if (!isNonEmptyString(assetRef)) {
    return jsonError(400, 'missing_asset_ref', 'assetRef (the stored CVT code) is required.');
  }
  if (!isVaultKind(kind)) {
    return jsonError(
      422,
      'invalid_kind',
      `kind must be one of: ${VAULT_EXTERNAL_IDENTIFIER_KINDS.join(', ')}.`,
    );
  }
  if (!isNonEmptyString(value)) {
    return jsonError(400, 'missing_value', 'value is required.');
  }

  const verdict = checkRateLimit(`covnant-admin-vault:${clientAddress(request)}`, ADMIN_API_RATE_LIMIT);
  if (!verdict.ok) return rateLimited(verdict.retryAfterSeconds);

  const db = getDb();
  if (!db) {
    return jsonError(503, 'db_not_configured', 'Database is not configured (DATABASE_URL).');
  }

  const result = await attachExternalIdentifier(db, assetRef.trim(), { kind, value });
  if (!result.ok) {
    return result.reason === 'INVALID_IDENTIFIER'
      ? jsonError(
          422,
          'invalid_identifier',
          'value is not a valid code of the requested kind — canonicalization is strict, never a repair.',
        )
      : jsonError(404, 'asset_not_found', 'No vault asset carries that CVT code.');
  }

  return Response.json(
    { ok: true, attached: result.attached, cvtCode: result.cvtCode, cbtCode: result.cbtCode },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function GET(request: Request): Promise<Response> {
  const gate = checkAdminGate(request);
  if (!gate.ok) return jsonError(gate.status, gate.code, gate.message);

  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  const value = url.searchParams.get('value');

  if (!isVaultKind(kind)) {
    return jsonError(
      422,
      'invalid_kind',
      `kind must be one of: ${VAULT_EXTERNAL_IDENTIFIER_KINDS.join(', ')}.`,
    );
  }
  if (!isNonEmptyString(value)) {
    return jsonError(400, 'missing_value', 'value is required.');
  }

  const verdict = checkRateLimit(`covnant-admin-vault:${clientAddress(request)}`, ADMIN_API_RATE_LIMIT);
  if (!verdict.ok) return rateLimited(verdict.retryAfterSeconds);

  const db = getDb();
  if (!db) {
    return jsonError(503, 'db_not_configured', 'Database is not configured (DATABASE_URL).');
  }

  const asset = await findByIdentifier(db, kind, value);
  return Response.json(
    {
      ok: true,
      found: asset !== null,
      ...(asset ? { asset } : {}),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
