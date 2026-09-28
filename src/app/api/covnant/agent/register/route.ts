/**
 * POST /api/covnant/agent/register — the registration agent's draft route.
 *
 * Turns a creator's free-form description into ONE structured registration
 * draft for the review screen. PROPOSE-NEVER-WRITE (spec locked decision):
 * this route imports no store, no SDK write function, and no server action —
 * the ONLY write path is the creator's own confirmation, which the review
 * screen submits to the existing `registerAssetAction`. The no-write boundary
 * is pinned by the route test's import-graph walk (criterion 5).
 *
 * Order of operations mirrors the hardening canon:
 *
 *   1. shared rate limiter, keyed by client address — the flood burns before
 *      the session round-trips (audit M5: a flood never reaches Supabase Auth,
 *      and here never reaches Anthropic either);
 *   2. `resolveSessionCreator` — registered creators ONLY. Sessionless →
 *      401 no_session; signed-in-but-unenrolled → 403 not_registered. The
 *      demo door never triggers a model call that costs credits;
 *   3. shared rate limiter, keyed by the verified creator's payee id — the
 *      per-creator budget (10 / 10 min, AGENT_RATE_LIMIT);
 *   4. input validation — {description} non-empty, bounded;
 *   5. model call — Anthropic Messages API in tool-use mode via
 *      src/lib/agent/modelClient (AGENT_MODEL, default claude-3-5-haiku);
 *   6. strict zod re-parse of the returned tool input — malformed output is
 *      NEVER repaired, partially returned, or stored;
 *   7. escalation — at most ONE retry with AGENT_MODEL_ESCALATION
 *      (default claude-3-5-sonnet), only when the first pass failed
 *      validation or came back below AGENT_CONFIDENCE_THRESHOLD, and only
 *      while AGENT_ESCALATION is on (default). Model/transport failures do
 *      NOT escalate (a different model id does not fix an API outage);
 *   8. respond {draft, confidence, warnings} — or the established
 *      {error, code} envelope.
 */

import {
  safeParseAgentToolInput,
  AGENT_CONFIDENCE_THRESHOLD,
  type AgentRegistrationDraft,
} from '@/lib/agent/registrationDraft';
import { requestRegistrationDraft } from '@/lib/agent/modelClient';
import { clientAddress } from '@/lib/server/clientAddress';
import { donJsonError } from '@/lib/server/http';
import { AGENT_RATE_LIMIT, checkSharedRateLimit } from '@/lib/server/rateLimit';
import { resolveSessionCreator } from '@/lib/server/sessionCreator';

export const dynamic = 'force-dynamic';

/** Credit guard: a prose description beyond this is not a registration. */
const MAX_DESCRIPTION_LENGTH = 8_000;

const DEFAULT_AGENT_MODEL = 'claude-3-5-haiku';
const DEFAULT_ESCALATION_MODEL = 'claude-3-5-sonnet';

type DraftAttempt =
  | { kind: 'valid'; draft: AgentRegistrationDraft }
  | { kind: 'invalid'; issues: string[] }
  | { kind: 'model_error'; error: string };

async function attemptDraft(
  modelId: string,
  description: string,
  apiKey: string,
): Promise<DraftAttempt> {
  const result = await requestRegistrationDraft(modelId, description, apiKey);
  if (!result.ok) return { kind: 'model_error', error: result.error };
  const parsed = safeParseAgentToolInput(result.toolInput);
  if (!parsed.ok) return { kind: 'invalid', issues: parsed.issues };
  return { kind: 'valid', draft: parsed.draft };
}

function escalationEnabled(): boolean {
  return process.env.AGENT_ESCALATION !== 'off';
}

function agentModel(): string {
  return process.env.AGENT_MODEL || DEFAULT_AGENT_MODEL;
}

function escalationModel(): string {
  return process.env.AGENT_MODEL_ESCALATION || DEFAULT_ESCALATION_MODEL;
}

function draftResponse(draft: AgentRegistrationDraft, warnings: string[]): Response {
  return Response.json(
    { draft, confidence: draft.confidence, warnings },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function POST(request: Request) {
  // 1 · Address-keyed shared limiter (canon: burn floods before the session hop).
  const addressLimit = await checkSharedRateLimit(
    `agent-register:addr:${clientAddress(request)}`,
    AGENT_RATE_LIMIT,
  );
  if (!addressLimit.ok) {
    return donJsonError(
      429,
      'rate_limited',
      `Rate limit exceeded. Retry after ${addressLimit.retryAfterSeconds}s.`,
    );
  }

  // 2 · Session gate — registered creators only, resolved from the VERIFIED session.
  const session = await resolveSessionCreator();
  if (session.kind === 'anonymous') {
    return donJsonError(401, 'no_session', 'Sign in to use the registration agent.');
  }
  if (session.kind === 'unregistered') {
    return donJsonError(403, 'not_registered', 'This session is not enrolled as a rights holder.');
  }

  // 3 · Creator-keyed shared limiter — the per-creator budget on the verified id.
  const creatorLimit = await checkSharedRateLimit(
    `agent-register:creator:${session.creator.payee_id}`,
    AGENT_RATE_LIMIT,
  );
  if (!creatorLimit.ok) {
    return donJsonError(
      429,
      'rate_limited',
      `Rate limit exceeded. Retry after ${creatorLimit.retryAfterSeconds}s.`,
    );
  }

  // 4 · Input validation — one bounded prose description, nothing else.
  const body: unknown = await request.json().catch(() => null);
  const description =
    typeof body === 'object' && body !== null && 'description' in body
      ? (body as { description?: unknown }).description
      : undefined;
  if (typeof description !== 'string' || description.trim().length === 0) {
    return donJsonError(400, 'malformed_body', 'Provide a prose description of the work.');
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return donJsonError(
      400,
      'invalid_description',
      `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`,
    );
  }

  // 5 · Fail closed with the gate's own verdict when the key is not configured.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return donJsonError(503, 'agent_not_configured', 'The registration agent is not configured.');
  }

  // 6 · First pass.
  const first = await attemptDraft(agentModel(), description, apiKey);
  if (first.kind === 'model_error') {
    console.error('Agent model call failed:', first.error);
    return donJsonError(502, 'agent_model_unavailable', 'The registration agent is unavailable.');
  }

  const lowConfidence = (draft: AgentRegistrationDraft): string[] =>
    draft.confidence < AGENT_CONFIDENCE_THRESHOLD
      ? [
          `Confidence ${draft.confidence} is below ${AGENT_CONFIDENCE_THRESHOLD} — review every field before confirming.`,
        ]
      : [];

  // 7 · Escalation: exactly ONE retry, only on validation failure or low confidence.
  if (first.kind === 'valid' && first.draft.confidence >= AGENT_CONFIDENCE_THRESHOLD) {
    return draftResponse(first.draft, []);
  }

  if (escalationEnabled()) {
    const second = await attemptDraft(escalationModel(), description, apiKey);
    if (second.kind === 'valid') {
      return draftResponse(second.draft, lowConfidence(second.draft));
    }
    if (second.kind === 'model_error') {
      console.error('Agent escalation call failed:', second.error);
      return donJsonError(502, 'agent_model_unavailable', 'The registration agent is unavailable.');
    }
    console.error('Agent draft failed validation on both passes:', second.issues);
    return donJsonError(
      502,
      'agent_draft_invalid',
      'The agent could not produce a valid draft. Edit the draft manually or use the registration form.',
    );
  }

  // 8 · Escalation off: a valid low-confidence draft still ships — flagged.
  if (first.kind === 'valid') {
    return draftResponse(first.draft, lowConfidence(first.draft));
  }
  console.error('Agent draft failed validation (escalation off):', first.issues);
  return donJsonError(
    502,
    'agent_draft_invalid',
    'The agent could not produce a valid draft. Edit the draft manually or use the registration form.',
  );
}
