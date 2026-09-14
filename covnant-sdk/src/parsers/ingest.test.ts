import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '@/lib/server/inMemoryStore';
import type { StatementFile } from '../nodes/collection-node';
import { SdkMalformedInputError } from '../nodes/errors';
import {
  recordStatementIngest,
  statementFormatToStoreFormat,
  type StatementIngestRow,
} from './ingest';

/**
 * Statement-ingest provenance: every accepted or rejected statement leaves
 * exactly one statement_ingests row through the PR 3 Store methods, and a
 * malformed statement produces ZERO royalty-event writes — the parsers are
 * pure, so the only store write on the failure path is the failure row
 * itself (provenance, not a partial royalty write).
 */

const CSV_GOLDEN = readFileSync(new URL('./csv/fixtures/golden-statement.csv', import.meta.url), 'utf8');
const CWR_GOLDEN = readFileSync(new URL('./cwr/fixtures/golden-registration.cw21', import.meta.url), 'utf8');

function csvFile(content: string = CSV_GOLDEN): StatementFile {
  return { format: 'csv', name: 'statement.csv', content };
}

/** Spy seam: counts every store write and forwards to the real PR 3 store. */
function spyOverRealStore(): {
  store: Parameters<typeof recordStatementIngest>[0];
  real: InMemoryStore;
  writes: StatementIngestRow[];
} {
  const real = new InMemoryStore();
  const writes: StatementIngestRow[] = [];
  const store = {
    async insertStatementIngest(row: StatementIngestRow) {
      writes.push(row);
      return real.insertStatementIngest(row);
    },
  };
  return { store, real, writes };
}

describe('statement ingest provenance — parsed path', () => {
  it('records one parsed row and returns the events', async () => {
    const { store, real, writes } = spyOverRealStore();
    const now = new Date('2026-09-14T10:00:00.000Z');

    const result = await recordStatementIngest(store, csvFile(), now);

    expect(result.events).toHaveLength(3);
    expect(writes).toHaveLength(1);
    const row = writes[0]!;
    expect(row.status).toBe('parsed');
    expect(row.event_count).toBe(3);
    expect(row.error).toBeNull();
    expect(row.format).toBe('csv_statement');
    expect(row.file_name).toBe('statement.csv');
    expect(row.content).toBe(CSV_GOLDEN);
    expect(row.created_at).toBe('2026-09-14T10:00:00.000Z');

    const stored = await real.getStatementIngest(result.ingestId);
    expect(stored?.status).toBe('parsed');
    expect(stored?.event_count).toBe(3);
  });

  it('maps the three statement formats onto the store vocabulary', () => {
    expect(statementFormatToStoreFormat('ddex-rdr')).toBe('ddex');
    expect(statementFormatToStoreFormat('cwr')).toBe('cwr');
    expect(statementFormatToStoreFormat('csv')).toBe('csv_statement');
  });

  it('records CWR registrations through the same seam', async () => {
    const { store, writes } = spyOverRealStore();
    const result = await recordStatementIngest(store, {
      format: 'cwr',
      name: 'demo-registration.cw21',
      content: CWR_GOLDEN,
    });
    expect(result.events).toHaveLength(2);
    expect(writes[0]!.format).toBe('cwr');
    expect(writes[0]!.status).toBe('parsed');
    expect(writes[0]!.event_count).toBe(2);
  });
});

describe('statement ingest provenance — rejected path', () => {
  it('records exactly one failed row and rethrows the typed reason untouched', async () => {
    const { store, writes } = spyOverRealStore();
    const malformed = csvFile(CSV_GOLDEN.replace('composition_mechanical,2024-03', 'master_sync,2024-03'));
    const now = new Date('2026-09-14T11:30:00.000Z');

    await expect(recordStatementIngest(store, malformed, now)).rejects.toMatchObject({
      reason: 'csv:invalid_rights_pipeline:master_sync:row_2',
    });

    expect(writes).toHaveLength(1);
    const row = writes[0]!;
    expect(row.status).toBe('failed');
    expect(row.event_count).toBeNull();
    expect(row.error).toBe('csv:invalid_rights_pipeline:master_sync:row_2');
    expect(row.content).toBe(malformed.content);
    expect(row.created_at).toBe('2026-09-14T11:30:00.000Z');
  });

  it('never touches the royalty-event surface on rejection', async () => {
    // The store seam exposes exactly one write method; on the failure path it
    // is called once, with the failure row — so no event-shaped write can
    // have happened. Assert the call accounting directly.
    const calls: string[] = [];
    const accountingStore = {
      async insertStatementIngest(row: StatementIngestRow) {
        calls.push(row.status);
        return { id: 'ing-1', ...row };
      },
    };

    await expect(
      recordStatementIngest(
        accountingStore,
        csvFile('event_id,rights_pipeline,period,currency,gross_amount,territory,platform,isrc,iswc\r\n'),
      ),
    ).rejects.toBeInstanceOf(SdkMalformedInputError);
    expect(calls).toEqual(['failed']);
  });

  it('propagates store failures unchanged instead of swallowing them', async () => {
    const failingStore = {
      async insertStatementIngest(): Promise<{ id: string } & StatementIngestRow> {
        throw new Error('store unavailable');
      },
    };
    await expect(recordStatementIngest(failingStore, csvFile())).rejects.toThrow('store unavailable');
  });
});
