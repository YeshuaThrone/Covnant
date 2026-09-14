import { describe, expect, it } from 'vitest';
import {
  parseCanonicalRoyaltyEvent,
  RIGHTS_PIPELINES,
  STATEMENT_FORMATS,
} from '../contracts/royalty-event';
import type { RightsPipeline, StatementFormat } from '../contracts/royalty-event';
import { SdkMalformedInputError, SdkNotConfiguredError } from './errors';
import {
  ASCAP_SANDBOX_NODE,
  SANDBOX_NODES,
  SPOTIFY_SANDBOX_NODE,
  THE_MLC_SANDBOX_NODE,
  YOUTUBE_CONTENT_ID_SANDBOX_NODE,
  SandboxCollectionNode,
} from './sandbox-nodes';
import type { StatementFile } from './collection-node';

/**
 * A valid canonical-event wire record. The skeleton nodes ingest exactly
 * this wire shape — platform-specific normalization arrives with the live
 * clients, so the sandbox exercises the canonical boundary itself.
 */
function wireEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'evt_test_0001',
    rightsPipeline: 'master_digital_performance',
    source: 'webhook',
    period: '2026-08',
    currency: 'USD',
    grossMicros: 1234567890n,
    identifiers: { ISRC: 'USS1M2677777' },
    platform: 'SPOTIFY',
    territory: 'US',
    raw: { provider: 'test-suite', reference_id: 'evt_test_0001' },
    ...overrides,
  };
}

function statementFile(overrides: Partial<StatementFile> = {}): StatementFile {
  return {
    name: 'ascap-2026-08.csv',
    format: 'csv',
    content: 'work_id,amount\nW001,100\n',
    ...overrides,
  };
}

function wireSnapshot(payload: Record<string, unknown>): string {
  return JSON.stringify({ ...payload, grossMicros: String(payload.grossMicros) });
}

async function rejectedInput(fn: () => Promise<unknown>): Promise<SdkMalformedInputError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof SdkMalformedInputError) return error;
    throw error;
  }
  throw new Error('expected the call to reject');
}

async function rejectedNotConfigured(fn: () => Promise<unknown>): Promise<SdkNotConfiguredError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof SdkNotConfiguredError) return error;
    throw error;
  }
  throw new Error('expected the call to reject');
}

describe('sandbox roster — one pure node per pipeline', () => {
  it('maps the spec-recommended roster onto all four pipelines', () => {
    expect(SPOTIFY_SANDBOX_NODE.platform).toBe('spotify');
    expect(SPOTIFY_SANDBOX_NODE.pipelines).toEqual(['master_digital_performance']);
    expect(YOUTUBE_CONTENT_ID_SANDBOX_NODE.platform).toBe('youtube_content_id');
    expect(YOUTUBE_CONTENT_ID_SANDBOX_NODE.pipelines).toEqual(['master_interactive']);
    expect(ASCAP_SANDBOX_NODE.platform).toBe('ascap');
    expect(ASCAP_SANDBOX_NODE.pipelines).toEqual(['composition_performance']);
    expect(THE_MLC_SANDBOX_NODE.platform).toBe('the_mlc');
    expect(THE_MLC_SANDBOX_NODE.pipelines).toEqual(['composition_mechanical']);
  });

  it('covers every pipeline in the roster exactly once', () => {
    const covered = SANDBOX_NODES.flatMap((node) => node.pipelines).sort();
    expect(covered).toEqual([...RIGHTS_PIPELINES].sort());
  });

  it('sandbox operation is always configured — no credentials to check', () => {
    for (const node of SANDBOX_NODES) {
      expect(node.isConfigured()).toBe(true);
    }
  });
});

describe('SandboxCollectionNode.ingestWebhook — normalize or reject, never drop', () => {
  it('normalizes a single wire event through the canonical parser', async () => {
    const expected = parseCanonicalRoyaltyEvent(wireEvent());
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    const events = await SPOTIFY_SANDBOX_NODE.ingestWebhook(wireEvent());
    expect(events).toEqual([expected.event]);
    expect(events[0]?.eventId).toBe('evt_test_0001');
    expect(events[0]?.grossMicros).toBe(1234567890n);
  });

  it('normalizes a batch in order, across every node in the roster', async () => {
    const cases: readonly (readonly [CollectionNodeLike, Record<string, unknown>])[] = [
      [SPOTIFY_SANDBOX_NODE, wireEvent({ eventId: 'sp_1' })],
      [
        YOUTUBE_CONTENT_ID_SANDBOX_NODE,
        wireEvent({
          eventId: 'yt_1',
          rightsPipeline: 'master_interactive',
          platform: 'YOUTUBE_CONTENT_ID',
        }),
      ],
      [
        ASCAP_SANDBOX_NODE,
        wireEvent({ eventId: 'as_1', rightsPipeline: 'composition_performance', platform: null }),
      ],
      [
        THE_MLC_SANDBOX_NODE,
        wireEvent({
          eventId: 'mlc_1',
          rightsPipeline: 'composition_mechanical',
          platform: null,
          identifiers: { MLC_WORK_ID: 'MLC000123456789' },
        }),
      ],
    ];
    for (const [node, first] of cases) {
      const second = { ...first, eventId: `${String(first.eventId)}_b` };
      const events = await node.ingestWebhook([first, second]);
      expect(events.map((event) => event.eventId)).toEqual([first.eventId, second.eventId]);
    }
  });

  it('is pure: the same input yields the same events and the payload is untouched', async () => {
    const payload = wireEvent();
    const before = wireSnapshot(payload);
    const first = await SPOTIFY_SANDBOX_NODE.ingestWebhook(payload);
    const second = await SPOTIFY_SANDBOX_NODE.ingestWebhook(payload);
    expect(first).toEqual(second);
    expect(wireSnapshot(payload)).toBe(before);
  });

  it('rejects non-object payloads with a stable reason', async () => {
    for (const payload of ['nope', 42, true, null]) {
      const error = await rejectedInput(() => SPOTIFY_SANDBOX_NODE.ingestWebhook(payload));
      expect(error.reason).toBe('webhook_payload_not_an_object');
      expect(error.index).toBeNull();
    }
  });

  it('rejects an empty batch — a node never returns silence for a payload', async () => {
    const error = await rejectedInput(() => SPOTIFY_SANDBOX_NODE.ingestWebhook([]));
    expect(error.reason).toBe('empty_webhook_payload');
  });

  it('surfaces the canonical parser rejection with the offending item index', async () => {
    // Omit the key entirely (not an undefined value) to hit the missing-key path.
    const { currency: _currency, ...withoutCurrency } = wireEvent();
    const error = await rejectedInput(() =>
      SPOTIFY_SANDBOX_NODE.ingestWebhook([wireEvent(), withoutCurrency]),
    );
    expect(error.reason).toBe('missing_key:currency');
    expect(error.index).toBe(1);
  });

  it('rejects non-canonical identifiers — canonicalization is not repair', async () => {
    const lowercased = wireEvent({ identifiers: { ISRC: 'uss1m2677777' } });
    const error = await rejectedInput(() => SPOTIFY_SANDBOX_NODE.ingestWebhook(lowercased));
    expect(error.reason).toBe('non_canonical_identifier:ISRC');
  });

  it('rejects events outside the node pipeline mandate', async () => {
    const foreign = wireEvent({ rightsPipeline: 'composition_performance' });
    const error = await rejectedInput(() => SPOTIFY_SANDBOX_NODE.ingestWebhook(foreign));
    expect(error.reason).toBe('pipeline_not_handled:composition_performance');
    expect(error.index).toBe(0);
  });
});

describe('SandboxCollectionNode.parseStatement — fail closed until parsers land', () => {
  it('validates the envelope, then refuses every format with a typed not-configured error', async () => {
    for (const node of SANDBOX_NODES) {
      for (const format of STATEMENT_FORMATS) {
        const error = await rejectedNotConfigured(() =>
          node.parseStatement(statementFile({ format })),
        );
        expect(error.code).toBe('statement_parser_not_configured');
      }
    }
  });

  it('rejects a malformed envelope structurally, before any parser question', async () => {
    const notAnObject = 'ascap.csv' as unknown as StatementFile;
    expect(
      (await rejectedInput(() => SPOTIFY_SANDBOX_NODE.parseStatement(notAnObject))).reason,
    ).toBe('statement_file_not_an_object');

    const untrimmedName = statementFile({ name: '  ascap.csv' });
    expect(
      (await rejectedInput(() => SPOTIFY_SANDBOX_NODE.parseStatement(untrimmedName))).reason,
    ).toBe('invalid_statement_file_name');

    const badFormat = statementFile({ format: 'xlsx' as StatementFormat });
    expect(
      (await rejectedInput(() => SPOTIFY_SANDBOX_NODE.parseStatement(badFormat))).reason,
    ).toBe('invalid_statement_file_format:xlsx');

    const emptyContent = statementFile({ content: '' });
    expect(
      (await rejectedInput(() => SPOTIFY_SANDBOX_NODE.parseStatement(emptyContent))).reason,
    ).toBe('empty_statement_file_content');
  });
});

describe('SandboxCollectionNode construction — a malformed node never registers', () => {
  it('rejects platform keys outside the registry vocabulary', () => {
    for (const platform of ['Spotify', '1chain', 'space jam', '']) {
      expect(
        () => new SandboxCollectionNode({ platform, pipelines: ['master_interactive'] }),
      ).toThrow(SdkMalformedInputError);
    }
  });

  it('rejects an empty pipeline list, a foreign pipeline, and duplicates', () => {
    expect(() => new SandboxCollectionNode({ platform: 'spotify', pipelines: [] })).toThrow(
      SdkMalformedInputError,
    );
    expect(
      () =>
        new SandboxCollectionNode({
          platform: 'spotify',
          pipelines: ['not_a_pipeline' as unknown as RightsPipeline],
        }),
    ).toThrow(SdkMalformedInputError);
    expect(
      () =>
        new SandboxCollectionNode({
          platform: 'spotify',
          pipelines: ['master_digital_performance', 'master_digital_performance'],
        }),
    ).toThrow(SdkMalformedInputError);
  });
});

/** Structural type for the roster batch test — the nodes all satisfy it. */
type CollectionNodeLike = {
  ingestWebhook(payload: unknown): Promise<readonly { eventId: string }[]>;
};
