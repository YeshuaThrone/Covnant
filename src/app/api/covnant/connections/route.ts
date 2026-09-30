/**
 * /api/covnant/connections — the UCT credential vault's connect + status
 * surface (migration 0013, PR 5).
 *
 * POST hands the vault a distributor login so the Astra extraction agent
 * can traverse that dashboard with zero manual uploads. The secrecy
 * contract, enforced at the only boundary that matters (this route):
 *
 *   - the plaintext credentials live in the request body and in the cipher
 *     call — encryptCredential's output is the LAST form they ever take;
 *   - the response serializes `toConnectionStatus` ONLY — no plaintext, no
 *     ciphertext, ever (the no-plaintext-in-logs and
 *     credentials-never-returned tests in this directory pin both halves);
 *   - the holder id is the VERIFIED session's payee key — never a client
 *     field. There is no operator path: the vault stores the holder's own
 *     credentials, and operator-on-behalf would be a delegation surface
 *     this PR does not open.
 *
 * Order of operations mirrors the hardening canon (the recon enqueue
 * route): shared rate limiter keyed by client address — the flood burns
 * before the session round-trips; the session gate; the identity-keyed
 * shared limiter; zod validation; the encrypt + one store call.
 */

import { NextRequest, NextResponse } from 'next/server';

import { clientAddress } from '@/lib/server/clientAddress';
import { donJsonError } from '@/lib/server/http';
import { checkSharedRateLimit, CONNECTIONS_RATE_LIMIT } from '@/lib/server/rateLimit';
import { resolveSessionCreator } from '@/lib/server/sessionCreator';
import { getStore } from '@/lib/server/store';
import { encryptCredential } from '@/modules/vault/crypto';
import { toConnectionStatus } from '@/modules/vault/records';
import { parseConnectionRequest } from '@/modules/vault/validation';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  // 1 · Address-keyed shared limiter (canon: burn floods before the identity hop).
  const addressLimit = await checkSharedRateLimit(
    `connections:addr:${clientAddress(request)}`,
    CONNECTIONS_RATE_LIMIT,
  );
  if (!addressLimit.ok) {
    return donJsonError(
      429,
      'rate_limited',
      `Rate limit exceeded. Retry after ${addressLimit.retryAfterSeconds}s.`,
    );
  }

  // 2 · Identity — the verified creator session only (holder-scoped by
  //     construction; the holder id never comes from the client).
  const session = await resolveSessionCreator();
  if (session.kind === 'anonymous') {
    return donJsonError(401, 'no_session', 'Sign in to connect a distributor.');
  }
  if (session.kind === 'unregistered') {
    return donJsonError(
      403,
      'not_registered',
      'This session is not enrolled as a rights holder.',
    );
  }
  const holderId = session.creator.payee_id;

  // 3 · Identity-keyed shared limiter — the per-holder budget on the
  //     verified id.
  const holderLimit = await checkSharedRateLimit(
    `connections:holder:${holderId}`,
    CONNECTIONS_RATE_LIMIT,
  );
  if (!holderLimit.ok) {
    return donJsonError(
      429,
      'rate_limited',
      `Rate limit exceeded. Retry after ${holderLimit.retryAfterSeconds}s.`,
    );
  }

  // 4 · Body validation — {distributor, username, password}, bounded.
  const body: unknown = await request.json().catch(() => null);
  const parsed = parseConnectionRequest(body);
  if (!parsed.ok) return donJsonError(422, 'invalid_connection', parsed.message);

  // 5 · The cipher boundary — after this point the plaintext no longer
  //     exists anywhere in the request cycle.
  const { connection, rotated } = await getStore().createDistributorConnection({
    holder_id: holderId,
    distributor: parsed.value.distributor,
    username_encrypted: encryptCredential(parsed.value.username),
    password_encrypted: encryptCredential(parsed.value.password),
  });

  // 6 · The credential-free projection. 201 = a new connection, 200 = an
  //     existing active one whose credentials were rotated in place — the
  //     store's own account of which happened, never a timestamp guess.
  return NextResponse.json(
    { ok: true, connection: toConnectionStatus(connection) },
    { status: rotated ? 200 : 201, headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * GET — the holder's connection statuses. Same canon: limiter, session,
 * limiter, then a read that hands back ONLY the credential-free shapes.
 */
export async function GET(request: NextRequest) {
  const addressLimit = await checkSharedRateLimit(
    `connections:addr:${clientAddress(request)}`,
    CONNECTIONS_RATE_LIMIT,
  );
  if (!addressLimit.ok) {
    return donJsonError(
      429,
      'rate_limited',
      `Rate limit exceeded. Retry after ${addressLimit.retryAfterSeconds}s.`,
    );
  }

  const session = await resolveSessionCreator();
  if (session.kind === 'anonymous') {
    return donJsonError(401, 'no_session', 'Sign in to view your connections.');
  }
  if (session.kind === 'unregistered') {
    return donJsonError(
      403,
      'not_registered',
      'This session is not enrolled as a rights holder.',
    );
  }
  const holderId = session.creator.payee_id;

  const holderLimit = await checkSharedRateLimit(
    `connections:holder:${holderId}`,
    CONNECTIONS_RATE_LIMIT,
  );
  if (!holderLimit.ok) {
    return donJsonError(
      429,
      'rate_limited',
      `Rate limit exceeded. Retry after ${holderLimit.retryAfterSeconds}s.`,
    );
  }

  const records = await getStore().listDistributorConnections(holderId);
  return NextResponse.json(
    { ok: true, connections: records.map(toConnectionStatus) },
    { headers: { 'cache-control': 'no-store' } },
  );
}
