import { describe, expect, it } from 'vitest';
import type { IdentifierKind } from './identifiers';
import {
  RIGHTS_PIPELINES,
  deserializeRoyaltyEvent,
  parseCanonicalRoyaltyEvent,
  serializeRoyaltyEvent,
  type CanonicalRoyaltyEvent,
} from './royalty-event';

function baseEvent(overrides: Partial<CanonicalRoyaltyEvent> = {}): CanonicalRoyaltyEvent {
  return {
    eventId: 'evt_01JABCDEF0001',
    rightsPipeline: 'master_interactive',
    source: 'webhook',
    period: '2026-08',
    currency: 'USD',
    grossMicros: 1234567890n,
    identifiers: { ISRC: 'USS1M2677777' },
    platform: 'youtube',
    territory: 'US',
    raw: { provider: 'test-suite', reference_id: 'evt_01JABCDEF0001' },
    ...overrides,
  };
}

/**
 * The in-memory record the parser sees: grossMicros stays a bigint (the
 * parser's contract for in-memory events) while `raw` is cloned into plain
 * JSON-shaped data, as it would arrive from any real source.
 */
function eventAsRecord(event: CanonicalRoyaltyEvent): Record<string, unknown> {
  return {
    eventId: event.eventId,
    rightsPipeline: event.rightsPipeline,
    source: event.source,
    ...(event.statementFormat === undefined ? {} : { statementFormat: event.statementFormat }),
    period: event.period,
    currency: event.currency,
    grossMicros: event.grossMicros,
    identifiers: { ...event.identifiers },
    platform: event.platform,
    territory: event.territory,
    raw: JSON.parse(JSON.stringify(event.raw)) as unknown,
  };
}

describe('parseCanonicalRoyaltyEvent — the type boundary', () => {
  it('accepts a valid event for every one of the four pipelines', () => {
    for (const rightsPipeline of RIGHTS_PIPELINES) {
      const result = parseCanonicalRoyaltyEvent(eventAsRecord(baseEvent({ rightsPipeline })));
      expect(result.ok, `pipeline ${rightsPipeline} rejected`).toBe(true);
      if (result.ok) {
        expect(result.event.rightsPipeline).toBe(rightsPipeline);
        expect(result.event.grossMicros).toBe(1234567890n);
      }
    }
  });

  it('accepts a statement event with its format and a null platform', () => {
    const record = eventAsRecord(
      baseEvent({ source: 'statement', statementFormat: 'ddex-rdr', platform: null }),
    );
    const result = parseCanonicalRoyaltyEvent(record);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.statementFormat).toBe('ddex-rdr');
      expect(result.event.platform).toBeNull();
    }
  });

  it('rejects non-objects, arrays, and null outright', () => {
    for (const bad of [null, undefined, 42, 'event', [], true]) {
      const result = parseCanonicalRoyaltyEvent(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('not_an_object');
    }
  });

  it('rejects unknown top-level keys — the canonical event has exactly its keys', () => {
    const record = eventAsRecord(baseEvent());
    record.amount = 99; // A float, exactly what the canonical form must not admit.
    const result = parseCanonicalRoyaltyEvent(record);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_key:amount');
  });

  it('rejects missing required keys with a stable reason each', () => {
    for (const key of ['eventId', 'rightsPipeline', 'grossMicros', 'identifiers', 'raw']) {
      const record = eventAsRecord(baseEvent());
      delete record[key];
      const result = parseCanonicalRoyaltyEvent(record);
      expect(result.ok, `missing ${key} was not rejected`).toBe(false);
      if (!result.ok) expect(result.reason).toBe(`missing_key:${key}`);
    }
  });

  it('rejects malformed events with stable, testable reasons', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...eventAsRecord(baseEvent()), eventId: '' }, 'invalid_event_id'],
      [{ ...eventAsRecord(baseEvent()), eventId: ' padded' }, 'invalid_event_id'],
      [
        { ...eventAsRecord(baseEvent()), rightsPipeline: 'composition_sync' },
        'invalid_rights_pipeline:composition_sync',
      ],
      [
        { ...eventAsRecord(baseEvent()), source: 'carrier_pigeon' },
        'invalid_source:carrier_pigeon',
      ],
      [
        { ...eventAsRecord(baseEvent()), statementFormat: 'cwr' }, // format without statement source
        'statement_format_requires_statement_source',
      ],
      [{ ...eventAsRecord(baseEvent()), currency: 'usd' }, 'invalid_currency:usd'],
      [{ ...eventAsRecord(baseEvent()), currency: 'US' }, 'invalid_currency:US'],
      [
        { ...eventAsRecord(baseEvent()), grossMicros: 1234567890 }, // number, not bigint
        'invalid_gross_micros',
      ],
      [{ ...eventAsRecord(baseEvent()), period: '' }, 'invalid_period'],
      [{ ...eventAsRecord(baseEvent()), territory: 'usa' }, 'invalid_territory'],
      [{ ...eventAsRecord(baseEvent()), platform: '  ' }, 'invalid_platform'],
    ];
    for (const [record, reason] of cases) {
      const result = parseCanonicalRoyaltyEvent(record);
      expect(result.ok, `expected rejection ${reason}`).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
    }
  });

  it('rejects a string gross — the transport form never leaks into the in-memory boundary', () => {
    const record = eventAsRecord(baseEvent());
    record.grossMicros = '1234567890'; // What JSON.parse hands back before BigInt rebuilding.
    const result = parseCanonicalRoyaltyEvent(record);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_gross_micros');
  });

  it('rejects a negative gross — reversals travel the royalty.reversed path, not here', () => {
    const record = eventAsRecord(baseEvent());
    record.grossMicros = -1n;
    const result = parseCanonicalRoyaltyEvent(record);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_gross_micros');
  });

  it('rejects float money — the exact shape fixed-point exists to prevent', () => {
    const record = eventAsRecord(baseEvent());
    record.grossMicros = 12.34;
    const result = parseCanonicalRoyaltyEvent(record);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_gross_micros');
  });

  describe('identifiers at the boundary', () => {
    const wrap = (identifiers: unknown): Record<string, unknown> => ({
      ...eventAsRecord(baseEvent()),
      identifiers,
    });

    it('rejects an empty identifiers map — at least one identifier is required', () => {
      const result = parseCanonicalRoyaltyEvent(wrap({}));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('identifiers_empty');
    });

    it('rejects unknown identifier kinds', () => {
      const result = parseCanonicalRoyaltyEvent(wrap({ CATALOG_NUMBER: 'ABC-123' }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unknown_identifier_kind:CATALOG_NUMBER');
    });

    it('rejects non-canonical identifier values instead of repairing them', () => {
      const result = parseCanonicalRoyaltyEvent(wrap({ ISRC: 'US-S1M-26-77777' }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('non_canonical_identifier:ISRC');
    });

    it('rejects non-string identifier values', () => {
      const result = parseCanonicalRoyaltyEvent(wrap({ ISRC: 123456789012 }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid_identifier_value:ISRC');
    });

    it('accepts any of the 20 kinds as keys — spot-check across asset and creator', () => {
      const result = parseCanonicalRoyaltyEvent(
        wrap({
          ISWC: 'T-034524680-1',
          IPI: '00123456789',
          EIDR: '10.5240/7791-8534-2C23-9030-8610-5',
          NIL: 'NIL',
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.event.identifiers.ISWC).toBe('T-034524680-1');
        expect(result.event.identifiers.IPI).toBe('00123456789');
        expect(result.event.identifiers.EIDR).toBe('10.5240/7791-8534-2C23-9030-8610-5');
        expect(result.event.identifiers.NIL).toBe('NIL');
      }
    });
  });
});

describe('royalty-event transport — BigInt-safe JSON round trip', () => {
  const kindFixtures: Array<[IdentifierKind, string]> = [
    ['ISRC', 'USS1M2677777'],
    ['ISWC', 'T-034524680-1'],
    ['ISAN', 'B159D89F3D6F0A45'],
    ['EIDR', '10.5240/7791-8534-2C23-9030-8610-5'],
    ['DOI', '10.5281/zenodo.1234567'],
    ['UPC', '036000291452'],
    ['EAN', '4006381333931'],
    ['ISMN', '979-0-2600-1234-5'],
    ['GRID', 'A1-24TYZ-96XVQ4B123-8'],
    ['ISBN', '9780306406157'],
    ['ISSN', '2049-3630'],
    ['GTIN', '00614141000158'],
    ['MLC_WORK_ID', 'MLC-1234567'],
    ['HFA_SONG_ID', 'HFA-12345678'],
    ['TUNE_CODE', 'AB12CD34'],
    ['ISNI', '0000-0002-1825-009X'],
    ['IPI', '00123456789'],
    ['IPN', 'PERFORMER-01'],
    ['EPC_RFID', 'urn:epc:id:sgtin:0614141.107346.2017'],
    ['NIL', 'NIL'],
  ];

  it('round-trips an event carrying every one of the 20 identifier kinds losslessly', () => {
    const identifiers = Object.fromEntries(kindFixtures) as Partial<Record<IdentifierKind, string>>;
    const event = baseEvent({ identifiers });
    const result = deserializeRoyaltyEvent(serializeRoyaltyEvent(event));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event).toEqual(event);
      expect(result.event.grossMicros).toBe(1234567890n);
      expect(Object.keys(result.event.identifiers)).toHaveLength(20);
    }
  });

  it('preserves enormous gross values exactly — no float ever touches the money path', () => {
    const huge = 123456789012345678901234567890n;
    const event = baseEvent({ grossMicros: huge });
    const result = deserializeRoyaltyEvent(serializeRoyaltyEvent(event));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.grossMicros).toBe(huge);
  });

  it('omits statementFormat when absent and restores that absence exactly', () => {
    const wire = JSON.parse(serializeRoyaltyEvent(baseEvent())) as Record<string, unknown>;
    expect('statementFormat' in wire).toBe(false);
    const result = deserializeRoyaltyEvent(serializeRoyaltyEvent(baseEvent()));
    expect(result.ok).toBe(true);
    if (result.ok) expect('statementFormat' in result.event).toBe(false);
  });

  it('keeps the raw payload verbatim through the round trip', () => {
    const raw = { nested: { list: [1, 'two', { three: 3 }] }, exact: true };
    const event = baseEvent({ raw });
    const result = deserializeRoyaltyEvent(serializeRoyaltyEvent(event));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.raw).toEqual(raw);
  });

  it('rejects corrupt transport — not JSON, not an object, not a bigint string', () => {
    for (const [corrupt, reason] of [
      ['not json at all', 'not_json'],
      ['[1,2,3]', 'not_an_object'],
      ['{"grossMicros": 12.5, "eventId": "x"}', 'invalid_gross_micros'],
      ['{"grossMicros": "12x", "eventId": "x"}', 'invalid_gross_micros'],
    ] as const) {
      const result = deserializeRoyaltyEvent(corrupt);
      expect(result.ok, `corrupt input ${corrupt} was accepted`).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
    }
  });

  it('re-validates a serialized event whose payload was tampered in transit', () => {
    const wire = eventAsRecord(baseEvent());
    wire.rightsPipeline = 'master_sync'; // Tampered after serialization.
    const result = parseCanonicalRoyaltyEvent(wire);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_rights_pipeline:master_sync');
  });
});
