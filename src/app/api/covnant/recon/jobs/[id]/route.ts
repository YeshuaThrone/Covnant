/**
 * GET /api/covnant/recon/jobs/:id — the recon status poll (spec
 * art_7M0snhxc, build item 2). The v1 completion path: the UI polls this
 * route while the CVT worker processes; the pg_net callback is the later
 * push channel, not a replacement.
 *
 * Access is owner-or-operator: the operator gate, else the verified creator
 * session — and a job is returned only when `requested_by` matches the
 * session's own holder key. Every other caller (sessionless, unenrolled,
 * or a registered creator reading a job they did not request) sees the
 * SAME 404 — the OTP no-enumeration rule: a foreign id and an unknown id
 * are indistinguishable on the wire.
 */

import { NextRequest, NextResponse } from 'next/server';

import { requireHolderAccess } from '@/lib/server/apiAccess';
import { donJsonError } from '@/lib/server/http';
import { getStore } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  const access = await requireHolderAccess(request, null);
  if (!access.ok) {
    return donJsonError(access.status, access.code, access.message);
  }

  const job = await getStore().getReconJob(id);
  // One 404 for unknown AND foreign — no existence disclosure.
  if (job === undefined || (access.role !== 'operator' && job.requested_by !== access.holderId)) {
    return donJsonError(404, 'not_found', 'No such recon job.');
  }

  return NextResponse.json(
    { ok: true, job },
    { headers: { 'cache-control': 'no-store' } },
  );
}
