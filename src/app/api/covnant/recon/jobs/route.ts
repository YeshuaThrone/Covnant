/**
 * POST /api/covnant/recon/jobs — the UCT layer's recon enqueue (spec
 * art_7M0snhxc, build item 2).
 *
 * The Deep Royalties isolation contract, expressed as a request cycle: this
 * handler performs ONE store insert and returns 202. No parsing, no model
 * call, no outbound fetch, no dashboard automation — the heavy work happens
 * in the CVT worker (a standalone process that claims
 * `royalty_recon_jobs`), never here. The route's import graph is pinned by
 * the boundary test in this directory: no engine, no parser, no worker
 * module may appear in it.
 *
 * Order of operations mirrors the hardening canon (the agent route):
 *
 *   1. shared rate limiter, keyed by client address — the flood burns
 *      before the session round-trips;
 *   2. identity — the operator gate first (an ingest-scoped job has no
 *      creator session), else `resolveSessionCreator`: sessionless →
 *      401 no_session, signed-in-but-unenrolled → 403 not_registered;
 *   3. shared rate limiter, keyed by the verified identity — the per-creator
 *      budget (`recon:creator:<payee_id>`);
 *   4. zod validation — {source, ingest_id?}, source bounded to the
 *      statement_ingests vocabulary;
 *   5. ingest ownership — statement_ingests carries NO creator linkage
 *      column, so a creator's claim to an ingest cannot be verified by the
 *      schema. Rather than trust a client-supplied tie, ingest-scoped jobs
 *      require the operator gate; a creator naming an ingest gets a 403
 *      that explains the rule (the ingest's existence is never confirmed
 *      either way — no enumeration);
 *   6. ONE store insert → 202 {ok, job:{id, status:'pending'}}.
 */

import { NextRequest, NextResponse } from 'next/server';

import { clientAddress } from '@/lib/server/clientAddress';
import { donJsonError } from '@/lib/server/http';
import { checkSharedRateLimit, RECON_RATE_LIMIT } from '@/lib/server/rateLimit';
import { requireOperator } from '@/lib/server/apiAccess';
import { resolveSessionCreator } from '@/lib/server/sessionCreator';
import { getStore } from '@/lib/server/store';
import { parseReconJobRequest } from '@/modules/recon/validation';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  // 1 · Address-keyed shared limiter (canon: burn floods before the identity hops).
  const addressLimit = await checkSharedRateLimit(
    `recon:addr:${clientAddress(request)}`,
    RECON_RATE_LIMIT,
  );
  if (!addressLimit.ok) {
    return donJsonError(
      429,
      'rate_limited',
      `Rate limit exceeded. Retry after ${addressLimit.retryAfterSeconds}s.`,
    );
  }

  // 2 · Identity — operator, else the verified creator session.
  const operator = requireOperator(request);
  let requestedBy: string | null = null;
  if (!operator.ok) {
    const creatorGate = await creatorPayeeIdOrResponse();
    if (typeof creatorGate === 'string') {
      requestedBy = creatorGate;
    } else {
      return creatorGate; // the 401 no_session / 403 not_registered response
    }
  }

  // 3 · Identity-keyed shared limiter — the per-creator budget on the
  //     verified id (operators ride the address budget above).
  const identityLimit = await checkSharedRateLimit(
    `recon:creator:${requestedBy ?? 'operator'}`,
    RECON_RATE_LIMIT,
  );
  if (!identityLimit.ok) {
    return donJsonError(
      429,
      'rate_limited',
      `Rate limit exceeded. Retry after ${identityLimit.retryAfterSeconds}s.`,
    );
  }

  // 4 · Body validation — one bounded {source, ingest_id?}.
  const body: unknown = await request.json().catch(() => null);
  const parsed = parseReconJobRequest(body);
  if (!parsed.ok) return donJsonError(422, 'invalid_recon_job', parsed.message);

  // 5 · Ingest ownership — the schema cannot prove a creator's tie to an
  //     ingest (no linkage column), so ingest-scoped jobs are operator-only.
  if (parsed.value.ingest_id !== undefined && !operator.ok) {
    return donJsonError(
      403,
      'ingest_requires_operator',
      'Recon jobs scoped to a stored statement ingest require operator access.',
    );
  }

  // 6 · The ONE write. Everything after this is the response.
  const result = await getStore().createReconJob({
    source: parsed.value.source,
    ingest_id: parsed.value.ingest_id ?? null,
    requested_by: requestedBy,
  });

  // The request cycle ENDS here. No parsing, no model call, no fetch fan-out.
  return NextResponse.json(
    { ok: true, job: { id: result.id, status: 'pending' } },
    { status: 202 },
  );
}

/**
 * The session gate in one shape: the verified creator's payee id, or the
 * error response to return. Fail-closed — the identity comes from the
 * VERIFIED session (supabase.auth.getUser()), never a client field.
 */
async function creatorPayeeIdOrResponse(): Promise<string | ReturnType<typeof donJsonError>> {
  const session = await resolveSessionCreator();
  if (session.kind === 'anonymous') {
    return donJsonError(401, 'no_session', 'Sign in to request a royalty reconciliation.');
  }
  if (session.kind === 'unregistered') {
    return donJsonError(403, 'not_registered', 'This session is not enrolled as a rights holder.');
  }
  return session.creator.payee_id;
}
