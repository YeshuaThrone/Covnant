import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { StatementFile } from '../../nodes/collection-node';
import { SdkMalformedInputError } from '../../nodes/errors';
import { parseCsvStatement } from './csv-statement-parser';

/** Indexed access with an explicit test failure instead of an undefined. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${index}`);
  }
  return item;
}

/**
 * Golden fixture: the SDK's own strict RFC 4180 CSV profile (findings §D6:
 * no industry CSV statement standard exists, so the profile is documented in
 * code and pinned by this fixture) — exact header and order, one row per
 * canonical event, identifiers canonicalised, amounts in exact micros.
 */

const GOLDEN = readFileSync(new URL('./fixtures/golden-statement.csv', import.meta.url), 'utf8');

function csvFile(content: string): StatementFile {
  return { format: 'csv', name: 'statement.csv', content };
}

function expectMalformed(content: string, reason: string): void {
  try {
    parseCsvStatement(csvFile(content));
  } catch (error) {
    expect(error).toBeInstanceOf(SdkMalformedInputError);
    expect((error as SdkMalformedInputError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected rejection ${reason}`);
}

describe('CSV statement parser — golden fixture', () => {
  it('maps every data row onto a canonical event', () => {
    const events = parseCsvStatement(csvFile(GOLDEN));
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.eventId)).toEqual([
      'us-dsp-2024-000001',
      'us-dsp-2024-000002',
      'us-dsp-2024-000003',
    ]);
  });

  it('carries money in exact micros with the row currency', () => {
    const events = parseCsvStatement(csvFile(GOLDEN));
    expect(at(events, 0).grossMicros).toBe(1234000000n);
    expect(at(events, 1).grossMicros).toBe(5432000000n);
    expect(at(events, 2).grossMicros).toBe(7000000n);
    expect(at(events, 0).currency).toBe('USD');
  });

  it('canonicalises identifiers and optional columns', () => {
    const events = parseCsvStatement(csvFile(GOLDEN));
    expect(at(events, 0).identifiers.ISRC).toBe('USDMG1800001');
    expect(at(events, 0).identifiers.ISWC).toBeUndefined();
    expect(at(events, 1).identifiers.ISRC).toBe('USDMG1800009');
    expect(at(events, 2).identifiers.ISWC).toBe('T-034524680-1');
    expect(at(events, 0).period).toBe('2024-03');
    expect(at(events, 0).territory).toBe('US');
    expect(at(events, 0).platform).toBe('MyDSP');
    expect(at(events, 0).rightsPipeline).toBe('composition_mechanical');
    expect(at(events, 1).rightsPipeline).toBe('composition_performance');
    expect(at(events, 0).statementFormat).toBe('csv');
    expect(at(events, 0).source).toBe('statement');
  });
});

describe('CSV statement parser — structural rejections', () => {
  it('rejects an empty file', () => {
    expectMalformed('', 'csv:empty_statement_file');
  });

  it('rejects a wrong header order', () => {
    const swapped = GOLDEN.replace(
      'event_id,rights_pipeline,period,currency,gross_amount',
      'event_id,period,rights_pipeline,currency,gross_amount',
    );
    expectMalformed(swapped, 'csv:invalid_header');
  });

  it('rejects extra header columns', () => {
    const extra = GOLDEN.replace('isrc,iswc\r\n', 'isrc,iswc,notes\r\n');
    expectMalformed(extra, 'csv:invalid_header');
  });

  it('rejects files with a header and no data rows', () => {
    const headerOnly = GOLDEN.slice(0, GOLDEN.indexOf('\r\n') + 2);
    expectMalformed(headerOnly, 'csv:empty_statement_rows');
  });

  it('rejects rows with the wrong column count', () => {
    const short = GOLDEN.replace(
      'us-dsp-2024-000001,composition_mechanical,2024-03,USD,12.34,US,MyDSP,USDMG1800001,',
      'us-dsp-2024-000001,composition_mechanical,2024-03,USD',
    );
    expectMalformed(short, 'csv:invalid_column_count:4:row_2');
  });

  it('rejects unterminated quotes', () => {
    const unterminated = GOLDEN.replace('MyDSP,USDMG1800001,', '"MyDSP,USDMG1800001,');
    expectMalformed(unterminated, 'csv:unterminated_quote');
  });

  it('rejects duplicate event ids', () => {
    const duplicated = GOLDEN.replace(
      'us-dsp-2024-000002',
      'us-dsp-2024-000001',
    );
    expectMalformed(duplicated, 'csv:duplicate_event_id:us-dsp-2024-000001');
  });
});

describe('CSV statement parser — value rejections', () => {
  it('rejects missing required columns', () => {
    expectMalformed(
      GOLDEN.replace('us-dsp-2024-000001,composition_mechanical', ',composition_mechanical'),
      'csv:missing_column:event_id:row_2',
    );
    expectMalformed(
      GOLDEN.replace('us-dsp-2024-000001,composition_mechanical', 'us-dsp-2024-000001,'),
      'csv:missing_column:rights_pipeline:row_2',
    );
    expectMalformed(
      GOLDEN.replace('2024-03,USD,12.34', '2024-03,,12.34'),
      'csv:missing_column:currency:row_2',
    );
    expectMalformed(
      GOLDEN.replace('USD,12.34,US', 'USD,,US'),
      'csv:missing_column:gross_amount:row_2',
    );
  });

  it('rejects invalid rights pipelines', () => {
    expectMalformed(
      GOLDEN.replace('composition_mechanical,2024-03', 'master_sync,2024-03'),
      'csv:invalid_rights_pipeline:master_sync:row_2',
    );
  });

  it('rejects invalid currencies', () => {
    expectMalformed(GOLDEN.replace(',USD,12.34', ',usd,12.34'), 'csv:invalid_currency:usd:row_2');
  });

  it('rejects negative amounts distinctly from invalid ones', () => {
    expectMalformed(GOLDEN.replace('USD,12.34', 'USD,-1'), 'csv:negative_amount:row_2');
    expectMalformed(GOLDEN.replace('USD,12.34', 'USD,1.2.3'), 'csv:invalid_amount:row_2');
  });

  it('rejects rows with no canonical identifier', () => {
    const blanked = GOLDEN.replace(
      'us-dsp-2024-000002,composition_performance,2024-03,USD,54.32,GB,MyDSP,USDMG1800009,',
      'us-dsp-2024-000002,composition_performance,2024-03,USD,54.32,GB,MyDSP,,',
    );
    expectMalformed(blanked, 'csv:no_canonical_identifier:row_3');
  });

  it('rejects malformed ISRC and ISWC values', () => {
    expectMalformed(
      GOLDEN.replace('USDMG1800001', 'USDMG180000'),
      'csv:invalid_isrc:row_2',
    );
    expectMalformed(
      GOLDEN.replace('T-034524680-1', 'T0345246801'),
      'csv:invalid_iswc:row_4',
    );
  });

  it('rejects over-long platform values', () => {
    expectMalformed(
      GOLDEN.replace('MyDSP,USDMG1800001,', `${'x'.repeat(129)},USDMG1800001,`),
      'csv:platform_too_long:row_2',
    );
  });
});

describe('CSV statement parser — RFC 4180 quoting', () => {
  it('parses quoted cells containing commas and escaped quotes', () => {
    const quoted = [
      'event_id,rights_pipeline,period,currency,gross_amount,territory,platform,isrc,iswc',
      'us-dsp-2024-000009,composition_mechanical,2024-03,USD,1234.56,US,"My ""DSP"", Ltd",USDMG1800003,',
      '',
    ].join('\r\n');
    const events = parseCsvStatement(csvFile(quoted));
    expect(events).toHaveLength(1);
    expect(at(events, 0).grossMicros).toBe(123456000000n);
    expect(at(events, 0).platform).toBe('My "DSP", Ltd');
  });

  it('rejects misplaced quotes that do not open a cell', () => {
    const badQuote = [
      'event_id,rights_pipeline,period,currency,gross_amount,territory,platform,isrc,iswc',
      'us-dsp-2024-000009,composition_mechanical,2024-03,USD,12.34,US,My"DSP,USDMG1800003,',
      '',
    ].join('\r\n');
    expectMalformed(badQuote, 'csv:unterminated_quote');
  });
});
