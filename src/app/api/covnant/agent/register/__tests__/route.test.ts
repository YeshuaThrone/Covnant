/**
 * POST /api/covnant/agent/register — route battery with a FAKE model client
 * (the real Anthropic API is never called from tests).
 *
 * Covers the spec's route criteria:
 *   1 — auth battery: sessionless → 401 no_session, unenrolled → 403
 *       not_registered, and the model client is never reached by either;
 *   2 — rate limit: the shared limiter's 10-per-10-minutes budget enforced
 *       per address + per creator, in-memory fallback (no DATABASE_URL here);
 *   4 — exactly ONE escalation, only on validation failure or low confidence;
 *   3 — malformed model output → clean {error, code:'agent_draft_invalid'},
 *       never a partial draft.
 *
 * The import-boundary walk lives in route.boundary.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentModelResult } from '@/lib/agent/modelClient';

vi.mock('@/lib/agent/modelClient', () => ({ requestRegistrationDraft: vi.fn() }));
vi.mock('@/lib/server/sessionCreator', () => ({ resolveSessionCreator: vi.fn() }));

import { requestRegistrationDraft } from '@/lib/agent/modelClient';
import { resolveSessionCreator } from '@/lib/server/sessionCreator';
import { resetRateLimits } from '@/lib/server/rateLimit';
import { AGENT_ROUTING_PLACEHOLDER } from '@/lib/agent/registrationDraft';
import { POST } from '../route';

const mockModel = vi.mocked(requestRegistrationDraft);
const mockSession = vi.mocked(resolveSessionCreator);

/** A model-shaped valid tool input (no holder ids — the model never emits them). */
function validToolInput(confidence: number): Record<string, unknown> {
  return {
    title: 'Midnight Clear',
    medium: 'MUSIC_TRACK',
    identifiers: { isrc: 'US-S1Z-26-00001' },
    pools: [
      {
        pool: 'MASTER_RECORDING',
        holders: [
          {
            name: 'Aurora Sky',
            role: 'COMPOSER',
            splitPercentage: 60,
            taxFormType: 'EXEMPT',
            usTaxResident: false,
            isVerified: false,
            routing: { ...AGENT_ROUTING_PLACEHOLDER },
          },
          {
            name: 'Second Writer',
            role: 'LYRICIST',
            splitPercentage: 40,
            taxFormType: 'EXEMPT',
            usTaxResident: false,
            isVerified: false,
            routing: { ...AGENT_ROUTING_PLACEHOLDER },
          },
        ],
      },
    ],
    templateSuggestion: { templateId: 'MUSIC_SPLIT_SHEET', rationale: 'Ownership split sheet.' },
    confidence,
    assumptions: ['Tax form defaulted to EXEMPT.'],
  };
}

function modelOk(toolInput: unknown): AgentModelResult {
  return { ok: true, toolInput };
}

function agentRequest(description: unknown): Request {
  return new Request('http://localhost/api/covnant/agent/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.7',
    },
    body: typeof description === 'string' ? JSON.stringify({ description }) : JSON.stringify(description),
  });
}

const REGISTERED = {
  kind: 'registered' as const,
  creator: {
    payee_id: 'rh_test_creator',
    stage_name: 'Aurora Sky',
    kyc_status: 'verified',
    bank_account_linked: true,
    provisioning_status: 'PROVISIONED' as const,
  },
};

beforeEach(() => {
  resetRateLimits();
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
  vi.stubEnv('AGENT_ESCALATION', '');
  mockSession.mockResolvedValue(REGISTERED);
  mockModel.mockResolvedValue(modelOk(validToolInput(0.9)));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  resetRateLimits();
});

describe('auth battery — the demo door never reaches the model (criterion 1)', () => {
  it('rejects a sessionless caller with the standard 401 envelope and never calls the model', async () => {
    mockSession.mockResolvedValue({ kind: 'anonymous' });
    const response = await POST(agentRequest('A song I wrote last summer'));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe('no_session');
    expect(body.error).toBeTruthy();
    expect(mockModel).not.toHaveBeenCalled();
  });

  it('rejects a signed-in but unenrolled session with 403 not_registered and never calls the model', async () => {
    mockSession.mockResolvedValue({ kind: 'unregistered', reason: 'holder_not_found' });
    const response = await POST(agentRequest('A song I wrote last summer'));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe('not_registered');
    expect(mockModel).not.toHaveBeenCalled();
  });
});

describe('rate limit — the shared limiter burns before the model does (criterion 2)', () => {
  it('admits the first 10 drafts and 429s the 11th before the model call', async () => {
    for (let i = 0; i < 10; i += 1) {
      const response = await POST(agentRequest(`Draft number ${i} of my catalog`));
      expect(response.status).toBe(200);
    }
    expect(mockModel).toHaveBeenCalledTimes(10);

    const eleventh = await POST(agentRequest('Draft number 11'));
    expect(eleventh.status).toBe(429);
    const body = (await eleventh.json()) as { error: string; code: string };
    expect(body.code).toBe('rate_limited');
    // The 11th request never reached the model — credits did not burn.
    expect(mockModel).toHaveBeenCalledTimes(10);
  });
});

describe('input validation', () => {
  it('400s a body without a description, an empty description, and unparseable JSON', async () => {
    for (const bad of [{}, { description: '' }, { description: '   ' }, { description: 42 }]) {
      const response = await POST(agentRequest(bad));
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe('malformed_body');
    }
    const unparseable = new Request('http://localhost/api/covnant/agent/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    const response = await POST(unparseable);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('malformed_body');
  });

  it('400s an oversized description (credit guard) with invalid_description', async () => {
    const response = await POST(agentRequest('x'.repeat(8_001)));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('invalid_description');
  });

  it('503s agent_not_configured when the key is absent — without calling the model', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const response = await POST(agentRequest('A song'));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('agent_not_configured');
    expect(mockModel).not.toHaveBeenCalled();
  });
});

describe('strict parse — malformed model output never becomes a draft (criterion 3)', () => {
  it('escalates once on a malformed first pass, then succeeds', async () => {
    mockModel
      .mockResolvedValueOnce(modelOk({ pools: [{ pool: 'MASTER_RECORDING', holders: [{ splitPercentage: 402.5 }] }] }))
      .mockResolvedValueOnce(modelOk(validToolInput(0.88)));
    const response = await POST(agentRequest('A song'));
    expect(response.status).toBe(200);
    expect(mockModel).toHaveBeenCalledTimes(2);
    const body = (await response.json()) as { draft: { title: string }; warnings: string[] };
    expect(body.draft.title).toBe('Midnight Clear');
  });

  it('returns the clean agent_draft_invalid envelope when BOTH passes are malformed — exactly 2 calls', async () => {
    mockModel.mockResolvedValue(modelOk({ garbage: true }));
    const response = await POST(agentRequest('A song'));
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe('agent_draft_invalid');
    expect(body.error).toBeTruthy();
    expect(mockModel).toHaveBeenCalledTimes(2);
  });

  it('returns agent_draft_invalid after ONE call with escalation off', async () => {
    vi.stubEnv('AGENT_ESCALATION', 'off');
    mockModel.mockResolvedValue(modelOk({ garbage: true }));
    const response = await POST(agentRequest('A song'));
    expect(response.status).toBe(502);
    expect(((await response.json()) as { code: string }).code).toBe('agent_draft_invalid');
    expect(mockModel).toHaveBeenCalledTimes(1);
  });
});

describe('escalation — exactly one retry, only on failure (criterion 4)', () => {
  it('does NOT escalate when the first pass is valid and confident', async () => {
    const response = await POST(agentRequest('A song'));
    expect(response.status).toBe(200);
    expect(mockModel).toHaveBeenCalledTimes(1);
    const body = (await response.json()) as { draft: { confidence: number }; warnings: string[] };
    expect(body.draft.confidence).toBe(0.9);
    expect(body.warnings).toEqual([]);
  });

  it('escalates exactly once on low confidence and returns the escalation draft', async () => {
    mockModel
      .mockResolvedValueOnce(modelOk(validToolInput(0.42)))
      .mockResolvedValueOnce(modelOk(validToolInput(0.91)));
    const response = await POST(agentRequest('A song'));
    expect(response.status).toBe(200);
    expect(mockModel).toHaveBeenCalledTimes(2);
    const body = (await response.json()) as { draft: { confidence: number }; warnings: string[] };
    expect(body.draft.confidence).toBe(0.91);
    expect(body.warnings).toEqual([]);
  });

  it('accepts a still-low-confidence escalation draft but flags it in warnings', async () => {
    mockModel
      .mockResolvedValueOnce(modelOk(validToolInput(0.42)))
      .mockResolvedValueOnce(modelOk(validToolInput(0.55)));
    const response = await POST(agentRequest('A song'));
    expect(response.status).toBe(200);
    expect(mockModel).toHaveBeenCalledTimes(2);
    const body = (await response.json()) as { warnings: string[] };
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatch(/below 0\.7/i);
  });

  it('ships a low-confidence draft flagged in warnings when escalation is off — one call', async () => {
    vi.stubEnv('AGENT_ESCALATION', 'off');
    mockModel.mockResolvedValue(modelOk(validToolInput(0.42)));
    const response = await POST(agentRequest('A song'));
    expect(response.status).toBe(200);
    expect(mockModel).toHaveBeenCalledTimes(1);
    const body = (await response.json()) as { warnings: string[] };
    expect(body.warnings).toHaveLength(1);
  });

  it('does NOT escalate on a model/transport failure — a different model id cannot fix an outage', async () => {
    mockModel.mockResolvedValue({ ok: false, error: 'Anthropic API responded 500.' });
    const response = await POST(agentRequest('A song'));
    expect(response.status).toBe(502);
    expect(((await response.json()) as { code: string }).code).toBe('agent_model_unavailable');
    expect(mockModel).toHaveBeenCalledTimes(1);
  });
});
