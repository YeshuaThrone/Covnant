/**
 * Matcher v1 tests — exact-hit, quarantine provenance, re-match on attach,
 * and the locked no-fuzzy rule.
 *
 * The fake db runs the vault adapter's REAL SQL semantics against an
 * in-memory `cbt_assets` table: the lookup SELECT's stored-side fold is
 * evaluated per the vault's documented lookup-boundary rules (vault.test.ts
 * pins the real SQL params), so attachExternalIdentifier → findByIdentifier
 * → rematchOpenEvents is exercised end-to-end, not stubbed at the seam.
 */

import { describe, expect, it } from 'vitest';

import { InMemoryStore } from '@/lib/server/inMemoryStore';
import type { Db, DbClient } from '@/lib/db';
import type { QueryResult, QueryResultRow } from 'pg';

import { attachExternalIdentifier } from '@/lib/covnant/vault';

import { parseCanonicalRoyaltyEvent } from '../contracts/royalty-event';
import {
  matchEvent,
  quarantineProvenance,
  rawPayloadText,
  rematchOpenEvents,
} from './match';

// ---------------------------------------------------------------------------
// Fixtures — an in-memory cbt_assets the REAL vault SQL runs against.
// ---------------------------------------------------------------------------

interface FakeAssetRow {
  cvt_code: string;
  cbt_code: string;
  title: string;
  medium: string;
  mapped_identifiers: Record<string, string>;
  rights_holders: Array<Record<string, unknown>>;
  holder_uct: string | null;
}

const ASSET_A: FakeAssetRow = {
  cvt_code: 'CVT-9F3A7C21-2026',
  cbt_code: 'CBT-TRK-1234567890AB',
  title: 'Test Song',
  medium: 'MUSIC_TRACK',
  mapped_identifiers: { isrc: 'USX7U2600001' },
  rights_holders: [{ uct: 'UCT-US-2026-9F3A7C21-K4' }],
  holder_uct: 'UCT-US-2026-9F3A7C21-K4',
};

const ASSET_B: FakeAssetRow = {
  cvt_code: 'CVT-44BB11DD-2026',
  cbt_code: 'CBT-REC-ABCDEF123456',
  title: 'B Side Work',
  medium: 'MUSIC_TRACK',
  mapped_identifiers: { iswc: 'T-123456789-1' },
  rights_holders: [],
  holder_uct: null,
};

/** The vault's documented lookup-boundary fold, by stored JSONB key. */
const FOLD_DASHLESS = new Set(['isrc', 'iswc']);
const FOLD_LOWER = new Set(['doi', 'epc_rfid']);

function foldStored(key: string, value: string): string {
  if (FOLD_DASHLESS.has(key)) return value.replaceAll('-', '').toUpperCase();
  if (FOLD_LOWER.has(key)) return value.toLowerCase();
  return value.toUpperCase();
}

function fakeDb(...assets: FakeAssetRow[]): { db: Db; queries: string[] } {
  const queries: string[] = [];

  const lookup = (sql: string, value: unknown): Array<Record<string, unknown>> => {
    // The per-kind lookup SELECT folds the stored side on exactly one
    // mapped_identifiers key — extract it from the SQL and compare exact.
    const key = /mapped_identifiers->>'([a-z_]+)'/.exec(sql)?.[1] ?? '';
    const hit = assets.find(
      (asset) => foldStored(key, asset.mapped_identifiers[key] ?? '') === value,
    );
    if (!hit) return [];
    return [
      {
        cvt_code: hit.cvt_code,
        cbt_code: hit.cbt_code,
        title: hit.title,
        medium: hit.medium,
        mapped_identifiers: hit.mapped_identifiers,
        uct: hit.holder_uct,
      },
    ];
  };

  const query = async <T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> => {
    queries.push(sql);
    if (/UPDATE cbt_assets/.test(sql)) {
      // attachExternalIdentifier's JSONB merge — [key, canonicalValue, cvtCode].
      const asset = assets.find((candidate) => candidate.cvt_code === params[2]);
      if (asset) {
        asset.mapped_identifiers = {
          ...asset.mapped_identifiers,
          [String(params[0])]: String(params[1]),
        };
      }
      return { rows: [] } as unknown as QueryResult<T>;
    }
    if (/FOR UPDATE/.test(sql)) {
      // The attach SELECT — keyed by cvt_code.
      const asset = assets.find((candidate) => candidate.cvt_code === params[0]);
      return {
        rows: (asset
          ? [
              {
                cvt_code: asset.cvt_code,
                cbt_code: asset.cbt_code,
                title: asset.title,
                medium: asset.medium,
                mapped_identifiers: asset.mapped_identifiers,
                holder_uct: asset.holder_uct,
              },
            ]
          : []) as unknown as T[],
      } as unknown as QueryResult<T>;
    }
    if (/FROM cbt_assets/.test(sql)) {
      return { rows: lookup(sql, params[0]) as T[] } as QueryResult<T>;
    }
    throw new Error(`fake db: unexpected sql — ${sql}`);
  };

  const db: Db = {
    query,
    transaction: async <T>(work: (tx: DbClient) => Promise<T>): Promise<T> =>
      work({ query } as DbClient),
  };
  return { db, queries };
}

function canonicalEvent(overrides: Record<string, unknown> = {}) {
  const parsed = parseCanonicalRoyaltyEvent({
    eventId: 'evt_001',
    rightsPipeline: 'master_digital_performance',
    source: 'webhook',
    period: '2026-08',
    currency: 'USD',
    grossMicros: 12345n,
    identifiers: { ISRC: 'USX7U2600001' },
    platform: null,
    territory: 'US',
    raw: { body: 'verbatim-source-payload', lines: 7 },
    ...overrides,
  });
  if (!parsed.ok) throw new Error(`fixture rejected: ${parsed.reason}`);
  return parsed.event;
}

// ---------------------------------------------------------------------------
// Exact hit → matched
// ---------------------------------------------------------------------------

describe('matchEvent — exact hit', () => {
  it('resolves an event whose identifier exactly hits mapped_identifiers', async () => {
    const store = new InMemoryStore();
    const { db } = fakeDb(ASSET_A);

    const resolution = await matchEvent(store, db, canonicalEvent());

    expect(resolution).toEqual({
      status: 'matched',
      cbtCode: 'CBT-TRK-1234567890AB',
    });
    // A matched event never enters the match queue.
    expect(await store.listMatchQueueEntries()).toEqual([]);
  });

  it('compares through the vault lookup boundary — the canonical folded value', async () => {
    const store = new InMemoryStore();
    const { db, queries } = fakeDb(ASSET_A);

    await matchEvent(store, db, canonicalEvent());

    // The lookup ran against cbt_assets with the exact canonical ISRC —
    // the query is the vault's own SQL, the param the exact-folded value.
    expect(queries.some((sql) => /FROM cbt_assets/.test(sql))).toBe(true);
  });

  it('tries identifiers in canonical order; the first exact hit wins', async () => {
    const store = new InMemoryStore();
    const both = fakeDb(ASSET_A, ASSET_B);

    // ISWC is first in the event's canonical order and hits asset B.
    const viaSecond = await matchEvent(
      store,
      both.db,
      canonicalEvent({ identifiers: { ISWC: 'T-123456789-1', ISRC: 'USX7U2600001' } }),
    );
    expect(viaSecond).toEqual({ status: 'matched', cbtCode: 'CBT-REC-ABCDEF123456' });

    // Swap the order and the other asset's code wins.
    const viaFirst = await matchEvent(
      store,
      both.db,
      canonicalEvent({ eventId: 'evt_002', identifiers: { ISRC: 'USX7U2600001', ISWC: 'T-123456789-1' } }),
    );
    expect(viaFirst).toEqual({ status: 'matched', cbtCode: 'CBT-TRK-1234567890AB' });
  });
});

// ---------------------------------------------------------------------------
// Miss → quarantined with FULL provenance
// ---------------------------------------------------------------------------

describe('matchEvent — miss quarantines with full provenance', () => {
  it('preserves every provenance field on the queue row', async () => {
    const store = new InMemoryStore();
    const { db } = fakeDb(ASSET_A); // holds USX7U2600001 — this event misses.

    const resolution = await matchEvent(
      store,
      db,
      canonicalEvent({
        identifiers: { ISRC: 'USX7U2600099', ISWC: 'T-987654321-9' },
        platform: 'YOUTUBE_CONTENT_ID',
        territory: 'DE',
        currency: 'EUR',
        grossMicros: 987654321n,
      }),
    );
    if (resolution.status !== 'quarantined') throw new Error('expected quarantine');
    expect(resolution.reason).toBe('no_identifier_match');

    const row = await store.getMatchQueueEntry(resolution.queueId);
    expect(row).toBeDefined();
    expect(row!.event_id).toBe('evt_001');
    expect(row!.status).toBe('open');
    expect(row!.reason).toBe('no_identifier_match');
    expect(row!.rights_pipeline).toBe('master_digital_performance');
    expect(row!.source).toBe('webhook');
    expect(row!.platform).toBe('YOUTUBE_CONTENT_ID');
    expect(row!.territory).toBe('DE');
    expect(row!.period).toBe('2026-08');
    expect(row!.currency).toBe('EUR');
    expect(row!.gross_micros).toBe('987654321');
    expect(JSON.parse(row!.identifiers_json ?? '{}')).toEqual({
      ISRC: 'USX7U2600099',
      ISWC: 'T-987654321-9',
    });
    // The raw payload is preserved verbatim — recovery never re-parses
    // from lossy intermediates.
    expect(JSON.parse(row!.raw_payload)).toEqual({
      body: 'verbatim-source-payload',
      lines: 7,
    });
    expect(row!.matched_cbt_code).toBeNull();
    expect(row!.resolved_at).toBeNull();
  });

  it('preserves a string raw payload byte-for-byte', async () => {
    const store = new InMemoryStore();
    const { db } = fakeDb();

    const resolution = await matchEvent(
      store,
      db,
      canonicalEvent({
        identifiers: { ISRC: 'USX7U2600099' },
        raw: 'HDR\nNWR-verbatim-body\r\n<eof>',
      }),
    );
    if (resolution.status !== 'quarantined') throw new Error('expected quarantine');

    const row = await store.getMatchQueueEntry(resolution.queueId);
    expect(row!.raw_payload).toBe('HDR\nNWR-verbatim-body\r\n<eof>');
  });
});

// ---------------------------------------------------------------------------
// The locked rule — NO fuzzy-matching path exists
// ---------------------------------------------------------------------------

describe('locked rule — no fuzzy matching, no auto-repair', () => {
  it('a one-digit near-miss never matches — it quarantines with the event value intact', async () => {
    const store = new InMemoryStore();
    const { db } = fakeDb(ASSET_A); // USX7U2600001 stored

    const resolution = await matchEvent(
      store,
      db,
      canonicalEvent({ identifiers: { ISRC: 'USX7U2600002' } }),
    );
    if (resolution.status !== 'quarantined') throw new Error('expected quarantine');

    // The resolution vocabulary offered no near-miss shape.
    expect(Object.keys(resolution)).toEqual(['status', 'queueId', 'reason']);

    // The stored near-miss never "corrected" the event's identifier.
    const row = await store.getMatchQueueEntry(resolution.queueId);
    expect(JSON.parse(row!.identifiers_json ?? '{}')).toEqual({ ISRC: 'USX7U2600002' });
  });

  it('a similar title never matches — only mapped_identifiers equality is consulted', async () => {
    const store = new InMemoryStore();
    // ASSET_A is titled 'Test Song'; the event claims a lookalike title
    // and an identifier that misses. Title similarity resolves nothing.
    const { db } = fakeDb(ASSET_A);

    const resolution = await matchEvent(
      store,
      db,
      canonicalEvent({
        identifiers: { ISRC: 'USX7U2600099' },
        raw: { title: 'Test Song (Live)' },
      }),
    );
    expect(resolution.status).toBe('quarantined');
  });

  it('the NIL sentinel never asserts a match from its own absence', async () => {
    const store = new InMemoryStore();
    const { db } = fakeDb(ASSET_A, ASSET_B);

    const resolution = await matchEvent(
      store,
      db,
      canonicalEvent({ identifiers: { NIL: 'NIL' } }),
    );
    expect(resolution).toMatchObject({ status: 'quarantined', reason: 'no_identifier_match' });
  });

  it('creator-party kinds never resolve against asset storage', async () => {
    const store = new InMemoryStore();
    const { db } = fakeDb(ASSET_A);

    const resolution = await matchEvent(
      store,
      db,
      canonicalEvent({ identifiers: { ISNI: '0000-0002-1825-0097' } }),
    );
    expect(resolution.status).toBe('quarantined');
  });

  it('quarantine never mutates asset storage — every db statement is a read', async () => {
    const store = new InMemoryStore();
    const { db, queries } = fakeDb(ASSET_A);

    await matchEvent(
      store,
      db,
      canonicalEvent({ identifiers: { ISRC: 'USX7U2600099' } }),
    );

    // No auto-attach, no repair write against cbt_assets — lookup only.
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((sql) => /SELECT/i.test(sql))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Quarantine-once — replays never double-preserve
// ---------------------------------------------------------------------------

describe('quarantine-once', () => {
  it('a replayed miss returns the original row — never a second quarantine', async () => {
    const store = new InMemoryStore();
    const { db } = fakeDb();

    const event = canonicalEvent({ identifiers: { ISRC: 'USX7U2600099' } });
    const first = await matchEvent(store, db, event);
    const replay = await matchEvent(store, db, event);

    expect(first.status).toBe('quarantined');
    expect(replay).toEqual(first);
    expect(await store.listMatchQueueEntries('open')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Re-match — identifier attach drains the queue
// ---------------------------------------------------------------------------

describe('rematchOpenEvents — identifier attach drains the queue', () => {
  it('drains an open entry once its identifier is attached through the vault', async () => {
    const store = new InMemoryStore();
    const { db } = fakeDb({ ...ASSET_A, mapped_identifiers: {} }); // asset exists, no ISRC yet

    const resolution = await matchEvent(
      store,
      db,
      canonicalEvent({ identifiers: { ISRC: 'USX7U2600001' } }),
    );
    if (resolution.status !== 'quarantined') throw new Error('expected quarantine');

    // Later, the identifier is attached through the vault attach surface.
    const attach = await attachExternalIdentifier(db, ASSET_A.cvt_code, {
      kind: 'ISRC',
      value: 'USX7U2600001',
    });
    expect(attach).toEqual({
      ok: true,
      attached: true,
      cvtCode: ASSET_A.cvt_code,
      cbtCode: ASSET_A.cbt_code,
    });

    const drain = await rematchOpenEvents(store, db);
    expect(drain).toEqual({ scanned: 1, matched: 1, unmatched: 0 });

    const row = await store.getMatchQueueEntry(resolution.queueId);
    expect(row!.status).toBe('matched');
    expect(row!.matched_cbt_code).toBe('CBT-TRK-1234567890AB');
    expect(row!.resolved_at).not.toBeNull();

    // Idempotent: nothing left to drain.
    expect(await rematchOpenEvents(store, db)).toEqual({ scanned: 0, matched: 0, unmatched: 0 });
  });

  it('leaves entries open until THEIR identifier arrives', async () => {
    const store = new InMemoryStore();
    const { db } = fakeDb({ ...ASSET_A, mapped_identifiers: {} });

    const first = await matchEvent(store, db, canonicalEvent({ identifiers: { ISRC: 'USX7U2600001' } }));
    const second = await matchEvent(
      store,
      db,
      canonicalEvent({ eventId: 'evt_002', identifiers: { ISRC: 'USX7U2600042' } }),
    );
    if (first.status !== 'quarantined' || second.status !== 'quarantined') {
      throw new Error('expected quarantines');
    }

    // Attach one identifier; only its event drains.
    await attachExternalIdentifier(db, ASSET_A.cvt_code, {
      kind: 'ISRC',
      value: 'USX7U2600001',
    });
    const drain = await rematchOpenEvents(store, db);
    expect(drain).toEqual({ scanned: 2, matched: 1, unmatched: 1 });

    expect((await store.getMatchQueueEntry(first.queueId))!.status).toBe('matched');
    const stillOpen = await store.getMatchQueueEntry(second.queueId);
    expect(stillOpen!.status).toBe('open');
    expect(stillOpen!.reason).toBe('no_identifier_match');

    // The remaining identifier attaches — the queue drains fully.
    await attachExternalIdentifier(db, ASSET_A.cvt_code, {
      kind: 'ISRC',
      value: 'USX7U2600042',
    });
    expect(await rematchOpenEvents(store, db)).toEqual({ scanned: 1, matched: 1, unmatched: 0 });
    expect(await store.listMatchQueueEntries('open')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pure provenance builder
// ---------------------------------------------------------------------------

describe('quarantineProvenance (pure core)', () => {
  it('maps the canonical event onto the queue vocabulary exactly', () => {
    const event = canonicalEvent({
      source: 'statement',
      statementFormat: 'ddex-rdr',
      grossMicros: 1n,
      identifiers: { UPC: '036000291452' },
    });
    const row = quarantineProvenance(event);

    expect(row).toMatchObject({
      event_id: 'evt_001',
      status: 'open',
      reason: 'no_identifier_match',
      rights_pipeline: 'master_digital_performance',
      source: 'statement',
      gross_micros: '1',
      identifiers_json: '{"UPC":"036000291452"}',
    });
  });

  it('rawPayloadText keeps strings verbatim and JSON-encodes structured payloads', () => {
    expect(rawPayloadText('HDR\nbody')).toBe('HDR\nbody');
    expect(rawPayloadText({ a: 1 })).toBe('{"a":1}');
  });
});
