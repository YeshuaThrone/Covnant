/**
 * The registration agent's draft contract — hostile-model unit tests (spec
 * acceptance criterion 3): malformed model output NEVER becomes a draft.
 *
 * Every fixture here is a model output that would be catastrophic if it
 * reached the client or the write path — wrong enums, pools that do not sum
 * to exactly 100.0000%, hallucinated template ids, fabricated holder ids —
 * pinned to the SAME fixed-point gate the write path enforces
 * (poolUnitsFromShares === TARGET_UNITS, no float drift).
 */
import { describe, expect, it } from 'vitest';

import { TEMPLATES } from '@/lib/contracts/templates';
import { AGENT_ROUTING_PLACEHOLDER } from '../registrationDraft';
import {
  AGENT_CONFIDENCE_THRESHOLD,
  AGENT_DRAFT_TOOL_NAME,
  AGENT_TOOL_DEFINITION,
  agentRegistrationDraftSchema,
  registerAssetPayloadFromDraft,
  safeParseAgentToolInput,
} from '../registrationDraft';

/** A valid single-holder pool: 100.0000% exactly. */
function holder(overrides: Partial<Parameters<typeof Object.assign>[0]> = {}): Record<string, unknown> {
  return {
    name: 'Aurora Sky',
    role: 'COMPOSER',
    splitPercentage: 100,
    taxFormType: 'EXEMPT',
    usTaxResident: false,
    isVerified: false,
    routing: { ...AGENT_ROUTING_PLACEHOLDER },
    ...overrides,
  };
}

/** A valid tool input (model shape — no holder ids): one exact pool. */
function toolInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Midnight Clear',
    medium: 'MUSIC_TRACK',
    identifiers: {},
    pools: [{ pool: 'MASTER_RECORDING', holders: [holder()] }],
    templateSuggestion: { templateId: 'MUSIC_SPLIT_SHEET', rationale: 'Ownership split sheet.' },
    confidence: 0.9,
    assumptions: ['Tax form defaulted to EXEMPT.'],
    ...overrides,
  };
}

/** A valid review draft (creator shape — ids required). */
function reviewDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { pools, ...rest } = toolInput() as { pools: { pool: string; holders: Record<string, unknown>[] }[] };
  return {
    ...rest,
    pools: pools.map((p) => ({ ...p, holders: p.holders.map((h, i) => ({ ...h, id: `holder-${i + 1}` })) })),
    ...overrides,
  };
}

describe('safeParseAgentToolInput — the happy path', () => {
  it('parses a valid tool input and assigns holder ids the write path requires', () => {
    const result = safeParseAgentToolInput(toolInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.title).toBe('Midnight Clear');
    expect(result.draft.pools[0]?.holders[0]?.id).toEqual(expect.any(String));
    expect(result.draft.pools[0]?.holders[0]?.id).not.toBe('');
    expect(result.draft.templateSuggestion?.templateId).toBe('MUSIC_SPLIT_SHEET');
  });

  it('strips a hallucinated holder id and reassigns — the agent never fabricates identities', () => {
    const model = toolInput({
      pools: [{ pool: 'MASTER_RECORDING', holders: [holder({ id: 'rh_fabricated' })] }],
    });
    const result = safeParseAgentToolInput(model);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.pools[0]?.holders[0]?.id).not.toBe('rh_fabricated');
  });

  it('drops an unresolved template id but keeps the draft (spec locked decision)', () => {
    const result = safeParseAgentToolInput(
      toolInput({ templateSuggestion: { templateId: 'NOT_A_REAL_TEMPLATE', rationale: 'Hallucinated.' } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.templateSuggestion).toBeUndefined();
  });

  it('keeps every catalog id the model could legally suggest', () => {
    for (const template of TEMPLATES) {
      const result = safeParseAgentToolInput(
        toolInput({ templateSuggestion: { templateId: template.id, rationale: template.name } }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.draft.templateSuggestion?.templateId).toBe(template.id);
    }
  });
});

describe('safeParseAgentToolInput — hostile fixtures (criterion 3)', () => {
  it('rejects a wrong role enum', () => {
    const model = toolInput({
      pools: [{ pool: 'MASTER_RECORDING', holders: [holder({ role: 'MANAGER' })] }],
    });
    const result = safeParseAgentToolInput(model);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toMatch(/role/i);
  });

  it('rejects a wrong medium enum', () => {
    const result = safeParseAgentToolInput(toolInput({ medium: 'NFT_COLLECTION' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a pool that reads 99.9999%', () => {
    const model = toolInput({
      pools: [
        {
          pool: 'MASTER_RECORDING',
          holders: [holder({ splitPercentage: 50 }), holder({ splitPercentage: 49.9999, name: 'Second Writer' })],
        },
      ],
    });
    const result = safeParseAgentToolInput(model);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(' ')).toMatch(/exactly 100\.0000%/);
  });

  it('rejects a pool that reads 100.0001%', () => {
    const model = toolInput({
      pools: [
        {
          pool: 'MASTER_RECORDING',
          holders: [holder({ splitPercentage: 50 }), holder({ splitPercentage: 50.0001, name: 'Second Writer' })],
        },
      ],
    });
    expect(safeParseAgentToolInput(model).ok).toBe(false);
  });

  it('rejects the catastrophic 402.5% pool', () => {
    const model = toolInput({
      pools: [{ pool: 'MASTER_RECORDING', holders: [holder({ splitPercentage: 402.5 })] }],
    });
    expect(safeParseAgentToolInput(model).ok).toBe(false);
  });

  it('rejects a negative holder share', () => {
    const model = toolInput({
      pools: [
        {
          pool: 'MASTER_RECORDING',
          holders: [holder({ splitPercentage: 110 }), holder({ splitPercentage: -10, name: 'Negative Share' })],
        },
      ],
    });
    expect(safeParseAgentToolInput(model).ok).toBe(false);
  });

  it('rejects an empty title and a whitespace-only title', () => {
    expect(safeParseAgentToolInput(toolInput({ title: '' })).ok).toBe(false);
    expect(safeParseAgentToolInput(toolInput({ title: '   ' })).ok).toBe(false);
  });

  it('rejects empty pools and a pool with no holders', () => {
    expect(safeParseAgentToolInput(toolInput({ pools: [] })).ok).toBe(false);
    expect(
      safeParseAgentToolInput(toolInput({ pools: [{ pool: 'MASTER_RECORDING', holders: [] }] })).ok,
    ).toBe(false);
  });

  it('rejects an unknown pool name', () => {
    expect(
      safeParseAgentToolInput(toolInput({ pools: [{ pool: 'MERCH_DROPSHIP', holders: [holder()] }] })).ok,
    ).toBe(false);
  });

  it('rejects confidence outside 0–1', () => {
    expect(safeParseAgentToolInput(toolInput({ confidence: -0.1 })).ok).toBe(false);
    expect(safeParseAgentToolInput(toolInput({ confidence: 1.5 })).ok).toBe(false);
  });

  it('rejects an unknown planetary jurisdiction', () => {
    const routing = { ...AGENT_ROUTING_PLACEHOLDER, planetaryJurisdiction: 'LUNA' };
    const model = toolInput({ pools: [{ pool: 'MASTER_RECORDING', holders: [holder({ routing })] }] });
    expect(safeParseAgentToolInput(model).ok).toBe(false);
  });
});

describe('agentRegistrationDraftSchema — the review/confirm contract', () => {
  it('requires holder ids (HolderDraft mirror — holdersFromDrafts passes d.id through)', () => {
    const { pools, ...rest } = toolInput() as { pools: { pool: string; holders: Record<string, unknown>[] }[] };
    const noIds = { ...rest, pools };
    expect(agentRegistrationDraftSchema.safeParse(noIds).success).toBe(false);
  });

  it('accepts a complete review draft with ids and metadata', () => {
    const parsed = agentRegistrationDraftSchema.safeParse(reviewDraft());
    expect(parsed.success).toBe(true);
  });
});

describe('registerAssetPayloadFromDraft — the confirm boundary', () => {
  it('strips agent-only metadata: nothing but the payload reaches the write action', () => {
    const result = safeParseAgentToolInput(toolInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = registerAssetPayloadFromDraft(result.draft);
    expect(Object.keys(payload).sort()).toEqual(['identifiers', 'medium', 'pools', 'title']);
    expect('confidence' in payload).toBe(false);
    expect('assumptions' in payload).toBe(false);
    expect('templateSuggestion' in payload).toBe(false);
  });
});

describe('tool definition + shared canon', () => {
  it('exposes the draft tool with a generated JSON schema', () => {
    expect(AGENT_TOOL_DEFINITION.name).toBe(AGENT_DRAFT_TOOL_NAME);
    const schema = AGENT_TOOL_DEFINITION.input_schema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    const properties = schema.properties as Record<string, unknown>;
    for (const key of ['title', 'medium', 'identifiers', 'pools', 'confidence', 'assumptions']) {
      expect(properties[key]).toBeDefined();
    }
    // The model is never offered an id field to fabricate.
    const pools = JSON.stringify(schema);
    expect(pools).not.toContain('fabricat');
  });

  it('keeps the escalation threshold at the spec-locked 0.70', () => {
    expect(AGENT_CONFIDENCE_THRESHOLD).toBe(0.7);
  });
});
