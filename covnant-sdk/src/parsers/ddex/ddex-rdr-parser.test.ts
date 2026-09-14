import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { StatementFile } from '../../nodes/collection-node';
import { SdkMalformedInputError } from '../../nodes/errors';
import { parseDdexRdrStatement } from './ddex-rdr-parser';

/** Indexed access with an explicit test failure instead of an undefined. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${index}`);
  }
  return item;
}

/**
 * Golden fixture: a DDEX RDR-R RevenueReport in the published record layout
 * (RHEA.01 header, RS01.01 revenue summary, RS02.01 allocated-party summary,
 * RD01.01 revenue details, RFOO footer), tab-separated with referential
 * integrity between the summary records.
 */

const GOLDEN = readFileSync(new URL('./fixtures/golden-revenue-report.tsv', import.meta.url), 'utf8');
const GOLDEN_RECORDS = GOLDEN.split('\n').filter((line) => line.length > 0);

function ddexFile(content: string): StatementFile {
  return { format: 'ddex-rdr', name: 'revenue-report.tsv', content };
}

/** The golden file with the record at `index` replaced or dropped. */
function withRecordAt(index: number, replacement: string | null): string {
  const records = [...GOLDEN_RECORDS];
  if (replacement === null) records.splice(index, 1);
  else records[index] = replacement;
  return records.join('\n') + '\n';
}

/** Replaces one tab-separated cell of the record at `index`. */
function withCellAt(index: number, cell: number, value: string): string {
  const cells = at(GOLDEN_RECORDS, index).split('\t');
  cells[cell] = value;
  return withRecordAt(index, cells.join('\t'));
}

/** The golden file with one extra record inserted before the footer. */
function withInsertedRecord(record: string): string {
  const records = [...GOLDEN_RECORDS];
  records.splice(records.length - 1, 0, record);
  return records.join('\n') + '\n';
}

function expectMalformed(content: string, reason: string): void {
  try {
    parseDdexRdrStatement(ddexFile(content));
  } catch (error) {
    expect(error).toBeInstanceOf(SdkMalformedInputError);
    expect((error as SdkMalformedInputError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected rejection ${reason}`);
}

describe('DDEX RDR-R parser — golden fixture', () => {
  it('maps both revenue details onto canonical events', () => {
    const events = parseDdexRdrStatement(ddexFile(GOLDEN));
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.eventId)).toEqual(['98765654321-1', '98765654321-2']);
  });

  it('carries money in exact micros with the summary currency', () => {
    const events = parseDdexRdrStatement(ddexFile(GOLDEN));
    expect(at(events, 0).grossMicros).toBe(12345000000n);
    expect(at(events, 1).grossMicros).toBe(5432000000n);
    expect(at(events, 0).currency).toBe('EUR');
    expect(at(events, 1).currency).toBe('EUR');
  });

  it('derives the period from the usage window and keys on the ISRC', () => {
    const events = parseDdexRdrStatement(ddexFile(GOLDEN));
    expect(at(events, 0).period).toBe('2014-12-01/2014-12-31');
    expect(at(events, 0).identifiers.ISRC).toBe('USDMG1800001');
    expect(at(events, 0).rightsPipeline).toBe('master_digital_performance');
    expect(at(events, 0).territory).toBe('US');
    expect(at(events, 1).territory).toBe('GB');
    expect(at(events, 0).statementFormat).toBe('ddex-rdr');
    expect(typeof at(events, 0).raw).toBe('string');
    expect((at(events, 0).raw as string).startsWith('RD01.01\t')).toBe(true);
  });
});

describe('DDEX RDR-R parser — structural rejections', () => {
  it('rejects a file not opening with RHEA.01', () => {
    expectMalformed(withRecordAt(0, 'RS01.01\t123'), 'ddex:invalid_header_record');
  });

  it('rejects a missing RFOO footer', () => {
    const records = [...GOLDEN_RECORDS];
    records.pop();
    expectMalformed(records.join('\n') + '\n', 'ddex:missing_footer_record');
  });

  it('rejects unknown record types', () => {
    expectMalformed(withInsertedRecord('RQST.01\t1'), 'ddex:unknown_record_type:RQST.01');
  });

  it('rejects unsupported revenue-detail variants', () => {
    expectMalformed(
      withInsertedRecord('RD02.01\t5\t1440'),
      'ddex:unsupported_revenue_details_record:RD02.01',
    );
  });

  it('rejects empty record lines mid-message', () => {
    const records = [...GOLDEN_RECORDS];
    records.splice(3, 0, '');
    expectMalformed(records.join('\n') + '\n', 'ddex:empty_record_line:4');
  });

  it('rejects truncated revenue-detail records', () => {
    expectMalformed(withCellAt(3, 34, ''), 'ddex:missing_cell:RD01.01.PayingMlcGrossAmount:line_4');
  });

  it('rejects truncated allocated-party records', () => {
    expectMalformed(withRecordAt(2, 'RS02.01\t123'), 'ddex:truncated_allocated_party:line_3');
  });

  it('rejects a missing revenue summary record', () => {
    expectMalformed(withRecordAt(1, null), 'ddex:no_revenue_summary_record');
  });

  it('rejects a missing allocated-party summary record', () => {
    expectMalformed(withRecordAt(2, null), 'ddex:no_allocated_party_summary_record');
  });

  it('rejects messages with no revenue details', () => {
    const records = [...GOLDEN_RECORDS];
    const footer = records.pop()!;
    const withoutDetails = [...records.slice(0, 3), footer.replace('\t2\t2\t', '\t1\t0\t')];
    expectMalformed(withoutDetails.join('\n') + '\n', 'ddex:no_revenue_details');
  });

  it('rejects dangling detail-to-party references', () => {
    expectMalformed(withCellAt(3, 2, '9999'), 'ddex:dangling_reference:RD01.01-9999');
  });

  it('rejects dangling party-to-summary references', () => {
    expectMalformed(withCellAt(2, 1, '999'), 'ddex:dangling_reference:RS02.01-999');
  });

  it('rejects footer count mismatches for details', () => {
    expectMalformed(withCellAt(5, 2, '9'), 'ddex:footer_count_mismatch:NumberOfRevenueDetailsRecords');
  });

  it('rejects footer count mismatches for total lines', () => {
    expectMalformed(withCellAt(5, 3, '9'), 'ddex:footer_count_mismatch:NumberOfLines');
  });
});

describe('DDEX RDR-R parser — value rejections', () => {
  it('rejects invalid currencies', () => {
    expectMalformed(withCellAt(1, 3, 'EURO'), 'ddex:invalid_currency:EURO:line_2');
  });

  it('rejects invalid amounts on the summary record', () => {
    expectMalformed(
      withCellAt(1, 4, '12,50'),
      'ddex:invalid_amount:RS01.01.NetRevenueInCurrencyOfAccounting:line_2',
    );
  });

  it('rejects negative amounts on detail records', () => {
    expectMalformed(withCellAt(3, 34, '-1'), 'ddex:negative_amount:1');
  });

  it('rejects invalid usage dates', () => {
    expectMalformed(withCellAt(3, 22, '12/01/2014'), 'ddex:invalid_date:RD01.01.UsageStartDate:line_4');
  });

  it('rejects invalid message timestamps', () => {
    expectMalformed(
      withCellAt(0, 4, '2014-12-31 10:05:00'),
      'ddex:invalid_timestamp:RHEA.01.MessageCreatedDateTime:2014-12-31 10:05:00',
    );
  });

  it('rejects invalid ISRCs', () => {
    expectMalformed(withCellAt(3, 4, 'USDMG18000Z'), 'ddex:invalid_isrc:1');
  });

  it('rejects detail records with no ISRC at all', () => {
    expectMalformed(withCellAt(3, 4, ''), 'ddex:no_canonical_identifier:1');
  });

  it('rejects duplicate detail record ids', () => {
    const duplicated = [...GOLDEN_RECORDS];
    duplicated.splice(4, 0, at(GOLDEN_RECORDS, 3));
    const footer = duplicated.pop()!.split('\t');
    footer[1] = '1';
    footer[2] = '3';
    footer[3] = String(duplicated.length + 1);
    expectMalformed([...duplicated, footer.join('\t')].join('\n') + '\n', 'ddex:duplicate_record_id:1');
  });
});
