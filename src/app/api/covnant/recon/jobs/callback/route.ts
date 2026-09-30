/**
 * POST /api/covnant/recon/jobs/callback — the pg_net completion webhook's
 * UCT target (spec art_7M0snhxc, build item 2).
 *
 * The migration-0011 trigger fires this when a job's status moves to
 * completed/failed AND the `app.recon_webhook_url`/`app.recon_webhook_secret`
 * database settings are set — so in the production flow the row is ALREADY
 * terminal when the notification lands, and the honest answer is a replay
 * no-op. The guarded transitions below exist for the degraded case (a
 * trigger fire lost between the worker's write and the POST): the payload
 * carries the worker's own result summary, which is applied verbatim —
 * this route never invents counts.
 *
 * Auth is the Standard Webhooks HMAC (the DSP ingestor's gate), keyed by
 * RECON_CALLBACK_SECRET — unset fails closed 401 signature_not_configured,
 * exactly mirroring the DSP webhook's posture.
 */

import { NextRequest, NextResponse } from 'next/server';

import { authenticateStandardWebhook } from '@/modules/don/webhookSignature';
import { isTerminalReconJob } from '@/modules/recon/records';
import { parseReconJobCallback } from '@/modules/recon/validation';
import { donJsonError } from '@/lib/server/http';
import { getStore } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  // Signature gate — BEFORE the body is parsed or the store is read. The
  // raw bytes are exactly what the HMAC covered.
  const auth = await authenticateStandardWebhook(request, 'RECON_CALLBACK_SECRET');
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = JSON.parse(auth.rawBody);
  } catch {
    return donJsonError(400, 'malformed_body', 'Request body must be valid JSON.');
  }
  const parsed = parseReconJobCallback(body);
  if (!parsed.ok) return donJsonError(422, 'invalid_recon_callback', parsed.message);

  const job = await getStore().getReconJob(parsed.value.job_id);
  // The caller holds the signing secret (the worker host / operator) — a
  // plain 404 for an unknown id is honest here, no enumeration concern.
  if (job === undefined) {
    return donJsonError(404, 'not_found', 'No such recon job.');
  }

  // Terminal rows are authoritative: every notification about one is a
  // replay — the no-op the idempotency contract requires.
  if (isTerminalReconJob(job)) {
    return NextResponse.json({ ok: true, replay: true });
  }

  if (parsed.value.status === 'completed') {
    if (!parsed.value.result) {
      return donJsonError(
        422,
        'missing_recon_result',
        'A completed recon job callback must carry the worker result summary.',
      );
    }
    const updated = await getStore().completeReconJob(parsed.value.job_id, parsed.value.result);
    return NextResponse.json({
      ok: true,
      replay: false,
      job: updated === undefined ? null : { id: updated.id, status: updated.status },
    });
  }

  // Announced failure: the guarded fail method records the error and either
  // re-pools the job (retry budget) or makes failure terminal — the row's
  // actual post-transition state is echoed, never the announcement.
  const updated = await getStore().failReconJob(
    parsed.value.job_id,
    parsed.value.error ?? 'worker reported failure without a reason',
  );
  return NextResponse.json({
    ok: true,
    replay: false,
    job: updated === undefined ? null : { id: updated.id, status: updated.status },
  });
}
