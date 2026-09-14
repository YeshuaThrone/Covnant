import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { StatementFile } from '../../nodes/collection-node';
import { SdkMalformedInputError } from '../../nodes/errors';
import { parseCwrStatement } from './cwr-parser';

/** Indexed access with an explicit test failure instead of an undefined. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an item at index ${index}`);
  }
  return item;
}

/**
 * Golden fixture: the published DMP demo registration file rebuilt along the
 * CISAC 2.1 layout table verified this session (title (19,60), language
 * (79,2), submitter (81,14), ISWC (95,11); REC ISRC at (251,12)) — the
 * generator script and the parser docblock record the sourcing. The CWR
 * parser is deliberately narrow: one homogeneous NWR/REV group of work
 * registrations, no money, no share math.
 */

const GOLDEN = readFileSync(new URL('./fixtures/golden-registration.cw21', import.meta.url), 'utf8');

const GOLDEN_LINES = GOLDEN.split('\r\n').filter((line) => line.length > 0);

function cwrFile(content: string): StatementFile {
  return { format: 'cwr', name: 'demo-registration.cw21', content };
}

/** Replaces the first golden line with the given record prefix, or deletes it when null. */
function withRecord(type: string, replacement: string | null): string {
  const lines = [...GOLDEN_LINES];
  const index = lines.findIndex((line) => line.startsWith(type));
  expect(index, `fixture line ${type}`).toBeGreaterThanOrEqual(0);
  if (replacement === null) lines.splice(index, 1);
  else lines[index] = replacement;
  return lines.join('\r\n') + '\r\n';
}

/** The golden file with one record's line swapped for a replacement (or removed). */
function withLines(
  edits: Readonly<Record<string, string | null>>,
): string {
  const lines = [...GOLDEN_LINES];
  for (const [type, replacement] of Object.entries(edits)) {
    const index = lines.findIndex((line) => line.startsWith(type));
    expect(index, `fixture line ${type}`).toBeGreaterThanOrEqual(0);
    if (replacement === null) lines.splice(index, 1);
    else lines[index] = replacement;
  }
  return lines.join('\r\n') + '\r\n';
}

function expectMalformed(content: string, reason: string): void {
  try {
    parseCwrStatement(cwrFile(content));
  } catch (error) {
    expect(error).toBeInstanceOf(SdkMalformedInputError);
    expect((error as SdkMalformedInputError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected rejection ${reason}`);
}

describe('CWR 2.1 parser — golden fixture', () => {
  it('maps both work transactions onto canonical events', () => {
    const events = parseCwrStatement(cwrFile(GOLDEN));
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.eventId)).toEqual([
      '000000199-NWR-00000001-DMP000002',
      '000000199-REV-00000002-DMP000002',
    ]);
  });

  it('carries the work ISWC in canonical dashed form and the REC ISRC', () => {
    const nwr = at(parseCwrStatement(cwrFile(GOLDEN)), 0);
    expect(nwr.identifiers.ISWC).toBe('T-034524681-9');
    expect(nwr.identifiers.ISRC).toBe('USDMG1800001');
    expect(Object.keys(nwr.identifiers).sort()).toEqual(['ISRC', 'ISWC']);
  });

  it('is a registration, not a royalty: zero gross, no-currency tag, no period', () => {
    const nwr = at(parseCwrStatement(cwrFile(GOLDEN)), 0);
    expect(nwr.grossMicros).toBe(0n);
    expect(nwr.currency).toBe('XXX');
    expect(nwr.period).toBeNull();
    expect(nwr.rightsPipeline).toBe('composition_mechanical');
    expect(nwr.source).toBe('statement');
    expect(nwr.statementFormat).toBe('cwr');
  });

  it('preserves the transaction lines verbatim as the raw payload', () => {
    const cwrEvents = parseCwrStatement(cwrFile(GOLDEN));
    const nwr = at(cwrEvents, 0);
    const rev = at(cwrEvents, 1);
    expect(typeof nwr.raw).toBe('string');
    const nwrRaw = nwr.raw as string;
    expect(typeof rev.raw).toBe('string');
    const revRaw = rev.raw as string;
    expect(nwrRaw).toContain('NWR0000000100000000SECOND BEST');
    expect(nwrRaw).toContain('REC0000000100000000');
    expect(nwrRaw).toContain('USDMG1800001');
    expect(nwrRaw.startsWith('NWR')).toBe(true);
    expect(revRaw.startsWith('REV')).toBe(true);
    expect(revRaw).not.toContain('NWR0000000100000000');
  });
});

describe('CWR 2.1 parser — structural rejections', () => {
  it('rejects a first record that is not HDR', () => {
    expectMalformed(withRecord('HDR', 'GRHNWR0000102.100000000000'), 'cwr:invalid_header_record');
  });

  it('rejects an empty file', () => {
    expectMalformed('', 'cwr:empty_statement_file');
  });

  it('rejects a missing TRL last record', () => {
    const withoutTrailer = GOLDEN_LINES.filter((line) => !line.startsWith('TRL')).join('\r\n') + '\r\n';
    expectMalformed(withoutTrailer, 'cwr:missing_trailer_record');
  });

  it('rejects unknown record types', () => {
    expectMalformed(withRecord('ALT', 'XYZ0000000100000000099Mystery'), 'cwr:unknown_record_type:XYZ');
  });

  it('rejects empty record lines mid-file', () => {
    expectMalformed(
      GOLDEN.replace('\r\nNWR0000000100000000', '\r\n\r\nNWR0000000100000000'),
      'cwr:empty_record_line:3',
    );
  });

  it('rejects group record-count mismatches', () => {
    expectMalformed(withRecord('GRT', 'GRT000010000000200000011'), 'cwr:group_count_mismatch:record_count');
  });

  it('rejects group transaction-count mismatches', () => {
    expectMalformed(withRecord('GRT', 'GRT0000100000000100000012'), 'cwr:group_count_mismatch:transaction_count');
  });

  it('rejects trailer transaction-count mismatches', () => {
    expectMalformed(withRecord('TRL', 'TRL0000100000000100000014'), 'cwr:trailer_count_mismatch:transaction_count');
  });

  it('rejects multiple groups', () => {
    expectMalformed(withRecord('GRT', 'GRHNWR0000102.100000000000'), 'cwr:multiple_groups_unsupported');
  });

  it('rejects unsupported group transaction types such as ACK files', () => {
    expectMalformed(withRecord('GRH', 'GRHACK0000101.100000000000'), 'cwr:unsupported_group_type:ACK');
  });

  it('rejects unsupported CWR versions', () => {
    expectMalformed(withRecord('GRH', 'GRHNWR0000103.100000000000'), 'cwr:unsupported_cwr_version:03.10');
  });

  it('rejects short work-record lines', () => {
    expectMalformed(withRecord('NWR', 'NWR0000000100000000SECOND BEST'), 'cwr:short_line:NWR');
  });

  it('rejects detail records appearing before any work record', () => {
    expectMalformed(
      withRecord(
        'NWR',
        'SPU000000010000000001DMP      DMP DEMO PUBLISHING                    E 00000000000000000199052025000440500004405000 N',
      ),
      'cwr:detail_record_without_work:SPU',
    );
  });
});

describe('CWR 2.1 parser — header rejections', () => {
  it('rejects invalid sender types', () => {
    expectMalformed(withRecord('HDR', 'HDRXX000000199DMP DEMO PUBLISHING'), 'cwr:invalid_sender_type:XX');
  });

  it('rejects non-numeric sender ids', () => {
    expectMalformed(withRecord('HDR', 'HDRPB00000019ADMP DEMO PUBLISHING'), 'cwr:invalid_sender_id:00000019A');
  });

  it('rejects unsupported EDI versions', () => {
    const header = GOLDEN_LINES[0]!
    const tampered = header.slice(0, 59) + '02.10' + header.slice(64);
    expectMalformed(withRecord('HDR', tampered), 'cwr:invalid_edi_version:02.10');
  });
});

describe('CWR 2.1 parser — identifier rejections', () => {
  it('rejects malformed ISWC values', () => {
    const nwr = GOLDEN_LINES[2]!
    const tampered = nwr.slice(0, 95) + 'X034524681' + nwr.slice(106);
    expectMalformed(withRecord('NWR', tampered), 'cwr:invalid_iswc:NWR-00000001-DMP000002');
  });

  it('rejects malformed REC ISRC values', () => {
    const rec = GOLDEN_LINES.find((line) => line.startsWith('REC'));
    expect(rec).toBeDefined();
    const tampered = rec!.slice(0, 251) + 'USDMG180000Z' + rec!.slice(263);
    expectMalformed(withRecord('REC', tampered), 'cwr:invalid_isrc:NWR-00000001-DMP000002');
  });

  it('rejects registrations with no canonical identifier at all', () => {
    // Blank ISWC (95,11) and the REC ISRC cell (251,12): the matcher could
    // never key on it. Blank cells rather than dropping lines so the
    // group/trailer counts stay consistent and the identifier rejection is
    // what fires.
    const nwr = GOLDEN_LINES[2]!
    const blankedIswc = nwr.slice(0, 95) + '           ' + nwr.slice(106);
    const rec = GOLDEN_LINES.find((line) => line.startsWith('REC'));
    expect(rec).toBeDefined();
    const blankedIsrc = rec!.slice(0, 251) + '            ' + rec!.slice(263);
    expectMalformed(
      withLines({ NWR: blankedIswc, REC: blankedIsrc }),
      'cwr:no_canonical_identifier:NWR-00000001-DMP000002',
    );
  });

  it('rejects work records with a missing submitter work number', () => {
    const nwr = GOLDEN_LINES[2]!
    const blanked = nwr.slice(0, 81) + '              ' + nwr.slice(95);
    expectMalformed(withRecord('NWR', blanked), 'cwr:missing_field:submitter_work_n');
  });
});
