/**
 * Luminate v1 tests — the reserved surface refuses fail-closed, and the
 * extension point wires a mapper without inventing a single format detail.
 */

import { describe, expect, it } from 'vitest';

import { parseCanonicalRoyaltyEvent } from '../contracts/royalty-event';
import { SdkMalformedInputError, SdkNotConfiguredError } from '../nodes/errors';
import {
  LUMINATE_NOT_CONFIGURED,
  RESERVED_LUMINATE_INGEST,
  createLuminateIngest,
  type LuminateStatementInput,
} from './luminate';

const STATEMENT: LuminateStatementInput = {
  fileName: 'luminate-streaming-week.txt',
  content: 'reserved — the layout arrives with the user streaming modules',
};

describe('the reserved surface', () => {
  it('refuses every parse with the typed luminate_not_configured refusal', () => {
    expect(RESERVED_LUMINATE_INGEST.state).toBe('reserved');
    expect(() => RESERVED_LUMINATE_INGEST.parseStatement(STATEMENT)).toThrowError(SdkNotConfiguredError);
    try {
      RESERVED_LUMINATE_INGEST.parseStatement(STATEMENT);
    } catch (error) {
      expect((error as SdkNotConfiguredError).code).toBe(LUMINATE_NOT_CONFIGURED);
    }
  });

  it('is what null configuration builds', () => {
    expect(createLuminateIngest(null)).toBe(RESERVED_LUMINATE_INGEST);
  });
});

describe('the extension point', () => {
  it('wires a mapper and delegates to it verbatim — no format invented', () => {
    const parsed = parseCanonicalRoyaltyEvent({
      eventId: 'lum_001',
      rightsPipeline: 'master_digital_performance',
      source: 'statement',
      period: '2026-08',
      currency: 'USD',
      grossMicros: 42n,
      identifiers: { ISRC: 'USX7U2600001' },
      platform: null,
      territory: null,
      raw: STATEMENT,
    });
    if (!parsed.ok) throw new Error(`fixture rejected: ${parsed.reason}`);
    const event = parsed.event;

    const layout = { userSupplied: 'structure' };
    const seen: Array<{ statement: LuminateStatementInput; layout: unknown }> = [];
    const ingest = createLuminateIngest({
      layout,
      mapStatement: (statement, suppliedLayout) => {
        seen.push({ statement, layout: suppliedLayout });
        return [event];
      },
    });

    expect(ingest.state).toBe('wired');
    expect(ingest.parseStatement(STATEMENT)).toEqual([event]);
    expect(seen).toEqual([{ statement: STATEMENT, layout }]);
  });

  it('throws at the wiring site on malformed configuration — never at parse time', () => {
    expect(() =>
      createLuminateIngest({ layout: 'not an object' as never, mapStatement: () => [] }),
    ).toThrowError(SdkMalformedInputError);
    try {
      createLuminateIngest({ layout: {}, mapStatement: 'nope' as never });
    } catch (error) {
      expect((error as SdkMalformedInputError).reason).toBe('invalid_luminate_config:mapStatement');
    }
    try {
      createLuminateIngest({ layout: 7 as never, mapStatement: () => [] });
    } catch (error) {
      expect((error as SdkMalformedInputError).reason).toBe('invalid_luminate_config:layout');
    }
  });
});
