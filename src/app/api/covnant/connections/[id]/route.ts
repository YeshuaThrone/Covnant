/**
 * DELETE /api/covnant/connections/:id — the vault's explicit disconnect
 * (migration 0013, PR 5). The holder's own act, on the verified session:
 * the store lookup is holder-scoped first, so a foreign id and an unknown
 * id are the SAME 404 on the wire — the OTP no-enumeration rule. Ciphertexts
 * stay on the (now disconnected) row — the holder's history is theirs; a
 * reconnect after disconnect inserts a fresh row (the migration's partial
 * unique index only binds ACTIVE rows).
 */

import { NextRequest, NextResponse } from 'next/server';

import { clientAddress } from '@/lib/server/clientAddress';
import { donJsonError } from '@/lib/server/http';
import { checkSharedRateLimit, CONNECTIONS_RATE_LIMIT } from '@/lib/server/rateLimit';
import { resolveSessionCreator } from '@/lib/server/sessionCreator';
import { getStore } from '@/lib/server/store';
import { toConnectionStatus } from '@/modules/vault/records';

export const dynamic = 'force-dynamic';

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  // 1 · Address-keyed shared limiter.
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

  // 2 · Identity — the verified creator session only.
  const session = await resolveSessionCreator();
  if (session.kind === 'anonymous') {
    return donJsonError(401, 'no_session', 'Sign in to manage your connections.');
  }
  if (session.kind === 'unregistered') {
    return donJsonError(
      403,
      'not_registered',
      'This session is not enrolled as a rights holder.',
    );
  }
  const holderId = session.creator.payee_id;

  // 3 · Identity-keyed shared limiter.
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

  // 4 · The holder-scoped disconnect. One 404 for unknown AND foreign —
  //     no existence disclosure.
  const record = await getStore().disconnectDistributorConnection(holderId, id);
  if (record === undefined) {
    return donJsonError(404, 'not_found', 'No such connection.');
  }

  return NextResponse.json(
    { ok: true, connection: toConnectionStatus(record) },
    { headers: { 'cache-control': 'no-store' } },
  );
}
