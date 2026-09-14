/**
 * Statement-ingest provenance — wires the parsers to the Store's
 * `statement_ingests` methods (PR 3 migration/store layer).
 *
 * The wrapper never imports a store implementation: it declares the one
 * method it needs as a STRUCTURAL seam that the real `Store` (and the test
 * InMemoryStore) already satisfies. Provenance is recorded for BOTH
 * outcomes, mirroring the quarantine discipline of the matcher:
 *
 * - PARSE OK  → one `status: 'parsed'` row with the event count, then the
 *   events are returned to the caller, who owns the downstream writes;
 * - PARSE FAIL → one `status: 'failed'` row with the typed reason, then the
 *   original `SdkMalformedInputError` is rethrown UNCHANGED. Exactly one
 *   write happens on the failure path (the failure record itself — that is
 *   provenance, not a partial royalty write), and ZERO canonical events
 *   exist at that point because the parsers are pure and write nothing.
 *
 * If the provenance write itself fails, the store error propagates as-is —
 * never swallowed, never replaced with a fabricated success.
 */

import type { CanonicalRoyaltyEvent } from '../contracts/royalty-event';
import type { StatementFile } from '../nodes/collection-node';
import { SdkMalformedInputError } from '../nodes/errors';
import { parseStatementFile } from './statement-parser';

/** The store-side statement formats of the statement_ingests table (PR 3). */
export type StoreStatementFormat = 'ddex' | 'cwr' | 'csv_statement';

/** Maps a statement wire format onto the store's ingest-format vocabulary. */
export function statementFormatToStoreFormat(
  format: StatementFile['format'],
): StoreStatementFormat {
  switch (format) {
    case 'ddex-rdr':
      return 'ddex';
    case 'cwr':
      return 'cwr';
    case 'csv':
      return 'csv_statement';
  }
}

/**
 * The statement_ingests row as the PR 3 Store defines it — structurally
 * identical to `Omit<StatementIngestRecord, 'id'>`, so the real Store
 * satisfies this seam without a type-level dependency.
 */
export interface StatementIngestRow {
  readonly format: StoreStatementFormat;
  readonly source: 'statement' | 'manual';
  readonly file_name: string;
  readonly content: string;
  readonly status: 'parsed' | 'failed';
  readonly event_count: number | null;
  readonly error: string | null;
  readonly created_at: string;
}

/** The minimal statement_ingests seam — the PR 3 Store implements this. */
export interface StatementIngestStore {
  insertStatementIngest(row: StatementIngestRow): Promise<{ id: string } & StatementIngestRow>;
}

/** The outcome of a recorded ingest: provenance id plus the parsed events. */
export interface RecordedStatementIngest {
  readonly ingestId: string;
  readonly events: readonly CanonicalRoyaltyEvent[];
}

/**
 * Parses a statement file and records its provenance via the Store's
 * statement_ingests method. Throws the parser's typed rejection AFTER
 * recording a failed-ingest row; returns the provenance id and events on
 * success. `now` is injectable so tests can pin the row's created_at.
 */
export async function recordStatementIngest(
  store: StatementIngestStore,
  file: StatementFile,
  now: Date = new Date(),
): Promise<RecordedStatementIngest> {
  const base = {
    format: statementFormatToStoreFormat(file.format),
    source: 'statement' as const,
    file_name: file.name,
    content: file.content,
  };
  try {
    const events = parseStatementFile(file);
    const inserted = await store.insertStatementIngest({
      ...base,
      status: 'parsed',
      event_count: events.length,
      error: null,
      created_at: now.toISOString(),
    });
    return { ingestId: inserted.id, events };
  } catch (error) {
    if (!(error instanceof SdkMalformedInputError)) throw error;
    await store.insertStatementIngest({
      ...base,
      status: 'failed',
      event_count: null,
      error: error.reason,
      created_at: now.toISOString(),
    });
    throw error;
  }
}
