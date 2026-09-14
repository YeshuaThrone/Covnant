import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { StatementFile } from '../nodes/collection-node';
import { SdkMalformedInputError } from '../nodes/errors';
import { parseStatementFile } from './statement-parser';

/** Indexed access with an explicit test failure instead of an undefined. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${index}`);
  }
  return item;
}

/**
 * Dispatch: parseStatementFile routes each StatementFile.format to its
 * parser and revalidates every produced event through the canonical
 * contract before returning. The ddex-rdr path completes coverage of all
 * three formats through the dispatcher (csv and cwr run via ingest.test.ts).
 */

const DDEX_GOLDEN = readFileSync(new URL('./ddex/fixtures/golden-revenue-report.tsv', import.meta.url), 'utf8');

function ddexFile(content: string = DDEX_GOLDEN): StatementFile {
  return { format: 'ddex-rdr', name: 'revenue-report.tsv', content };
}

describe('statement parser dispatch', () => {
  it('routes ddex-rdr files to the DDEX RDR parser and revalidates events', () => {
    const events = parseStatementFile(ddexFile());
    expect(events).toHaveLength(2);
    expect(at(events, 0).statementFormat).toBe('ddex-rdr');
    expect(at(events, 0).grossMicros).toBe(12345000000n);
  });

  it('propagates the typed rejection unchanged', () => {
    expect(() => parseStatementFile(ddexFile('RHEA.01\t11'))).toThrowError(SdkMalformedInputError);
    try {
      parseStatementFile(ddexFile('RHEA.01\t11'));
    } catch (error) {
      expect((error as SdkMalformedInputError).reason).toBe('ddex:truncated_header:line_1');
      return;
    }
    throw new Error('expected ddex rejection');
  });
});
