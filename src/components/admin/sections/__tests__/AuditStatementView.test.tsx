/**
 * @vitest-environment jsdom
 *
 * AuditStatementView — the Export Audit Package's statement view suite
 * (spec art_qNu4T32F, module 4), mirroring the CreatorAnalyticsSection
 * suite's fixture patterns (renderToStaticMarkup over real payload
 * shapes). Pinned here:
 *
 * 1. The identity block — the label ?? payeeId rule, the honest dashes
 *    for an absent UCT/ISNI, the window of record, the generation
 *    timestamp, and the demo-data disclosure badge.
 * 2. The works & identifiers table — the per-class scheme of record with
 *    the CVT fallback LABELED AS SUCH, and the honest empty state.
 * 3. The itemized settlements — exact bigint cents through
 *    formatCentsBigint, dashes for absent fields, the honest zero
 *    statement's empty state.
 * 4. The totals of record — itemized beside credited, the variance
 *    disclosure ONLY when they diverge (reconciled statements carry no
 *    variance line — a disclosed divergence is the honest state, a
 *    hidden one is not).
 * 5. The print path — the print control present on screen and the print
 *    stylesheet's print-key present in the rendered block
 *    (`data-print-statement`), the zero-dependency PDF path.
 *
 * Rendering only; nothing invented.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AuditStatementFlows, StatementWorkIdentifier } from '@/lib/admin/auditStatement';
import { AuditStatementView } from '../AuditStatementView';

function identifiers(...rows: StatementWorkIdentifier[]): StatementWorkIdentifier[] {
  return rows;
}

function flows(overrides: Partial<AuditStatementFlows> = {}): AuditStatementFlows {
  return {
    payeeId: 'rh_one',
    label: 'Thrones Label DON',
    windowDays: null,
    uctNumber: 'UCT-COV-0001-8',
    isni: '0000 0001 2345 6789',
    lines: [],
    itemizedTotalCents: 0n,
    creditedCents: 0n,
    works: [],
    ...overrides,
  };
}

function render(f: AuditStatementFlows, demo = true): string {
  return renderToStaticMarkup(<AuditStatementView flows={f} demo={demo} generatedAt="2026-09-25T12:00:00.000Z" />);
}

describe('AuditStatementView — the identity block', () => {
  it('renders the store-carried name, the ids, the window, and the generation timestamp', () => {
    const html = render(flows());
    expect(html).toMatch(/data-testid="audit-statement-payee"[^>]*>Thrones Label DON</);
    expect(html).toMatch(/data-testid="audit-statement-payee-id"[^>]*>rh_one</);
    expect(html).toMatch(/data-testid="audit-statement-window"[^>]*>All time</);
    expect(html).toMatch(/data-testid="audit-statement-uct"[^>]*>UCT-COV-0001-8</);
    expect(html).toMatch(/data-testid="audit-statement-isni"[^>]*>0000 0001 2345 6789</);
    expect(html).toMatch(/data-testid="audit-statement-generated"[^>]*>2026-09-25T12:00:00\.000Z</);
  });

  it('falls back to the payeeId when the store never names the payee — never an invented name', () => {
    const html = render(flows({ label: null }));
    expect(html).toMatch(/data-testid="audit-statement-payee"[^>]*>rh_one</);
  });

  it('renders the honest dash for an absent UCT or ISNI — never a placeholder value', () => {
    const html = render(flows({ uctNumber: null, isni: null }));
    expect(html).toMatch(/data-testid="audit-statement-uct"[^>]*>—</);
    expect(html).toMatch(/data-testid="audit-statement-isni"[^>]*>—</);
  });

  it('renders each bounded window in operator language', () => {
    expect(render(flows({ windowDays: 7 }))).toMatch(/data-testid="audit-statement-window"[^>]*>Last 7 days</);
    expect(render(flows({ windowDays: 30 }))).toMatch(/data-testid="audit-statement-window"[^>]*>Last 30 days</);
    expect(render(flows({ windowDays: 90 }))).toMatch(/data-testid="audit-statement-window"[^>]*>Last 90 days</);
    expect(render(flows({ windowDays: null }))).toMatch(/data-testid="audit-statement-window"[^>]*>All time</);
  });
});

describe('AuditStatementView — the disclosure and demo badges', () => {
  it('carries the demo-data disclosure badge when the demo door is open', () => {
    const html = render(flows(), true);
    expect(html).toContain('data-testid="audit-statement-demo-badge"');
    expect(html).toContain('Demo data');
    expect(html).toContain('Demo-data disclosure');
    expect(html).toContain('not production settlement data');
  });

  it('carries the production provenance line when the demo door is closed', () => {
    const html = render(flows(), false);
    expect(html).not.toContain('data-testid="audit-statement-demo-badge"');
    expect(html).toContain('ledger of record');
  });
});

describe('AuditStatementView — works and identifiers', () => {
  it('renders each work row with its identifier of record', () => {
    const html = render(
      flows({
        works: [
          {
            workRef: 'CBT-MUS-1',
            title: 'Midnight Clear',
            identifiers: identifiers({ scheme: 'ISRC', code: 'US-S1Z-26-00001', codeOfRecord: false }),
          },
        ],
      }),
    );
    expect(html).toContain('data-testid="audit-statement-work-row"');
    expect(html).toContain('Midnight Clear');
    expect(html).toContain('data-scheme="ISRC"');
    expect(html).toContain('US-S1Z-26-00001');
    expect(html).toContain('data-code-of-record="false"');
  });

  it('labels the CVT fallback as the code of record — never a claimed industry standard', () => {
    const html = render(
      flows({
        works: [
          {
            workRef: 'TPL-POD-001',
            title: null,
            identifiers: identifiers({ scheme: 'CVT', code: 'TPL-POD-001', codeOfRecord: true }),
          },
        ],
      }),
    );
    expect(html).toContain('data-scheme="CVT"');
    expect(html).toContain('Code of Record (CVT)');
    expect(html).toContain('data-code-of-record="true"');
    // A null title renders the dash — the record of truth carries none.
    expect(html).toContain('—');
  });

  it('renders the honest empty state when the window carries no works', () => {
    const html = render(flows());
    expect(html).toContain('data-testid="audit-statement-works-empty"');
    expect(html).toContain('No works in this window');
  });
});

describe('AuditStatementView — itemized settlements and totals', () => {
  it('itemizes the lines with exact bigint cents and dashes for absent fields', () => {
    const html = render(
      flows({
        lines: [
          {
            day: '2026-09-22',
            entityId: 'TPL-MUS-001',
            workRef: 'CBT-MUS-1',
            workTitle: 'Midnight Clear',
            source: 'Spotify',
            creatorCents: 123_456_789n,
          },
          {
            day: '2026-09-21',
            entityId: null,
            workRef: null,
            workTitle: null,
            source: null,
            creatorCents: 1n,
          },
        ],
        itemizedTotalCents: 123_456_790n,
        creditedCents: 123_456_790n,
      }),
    );
    expect(html).toContain('$1,234,567.89'); // formatCentsBigint, exact
    expect(html).toContain('$0.01');
    expect(html).toContain('data-testid="audit-statement-line-row"');
    // Absent fields render dashes, never invented labels.
    expect(html).toContain('—');
    // A reconciled statement carries NO variance line.
    expect(html).not.toContain('data-testid="audit-statement-variance"');
  });

  it('discloses the variance when the itemized total and the credited basis diverge', () => {
    const html = render(
      flows({
        itemizedTotalCents: 180_00n,
        creditedCents: 300_00n,
      }),
    );
    expect(html).toContain('data-testid="audit-statement-variance"');
    expect(html).toContain('do not reconcile');
  });

  it('renders the honest zero statement — an empty page never invents a line', () => {
    const html = render(flows());
    expect(html).toContain('data-testid="audit-statement-lines-empty"');
    expect(html).toContain('honest zero statement');
    expect(html).toMatch(/data-testid="audit-statement-total"[^>]*>\$0\.00</);
    expect(html).toMatch(/data-testid="audit-statement-credited"[^>]*>\$0\.00</);
  });
});

describe('AuditStatementView — the print path', () => {
  it('carries the print key, the print control, and the no-print suppression — zero dependencies', () => {
    const html = render(flows());
    // The print stylesheet keys on this attribute (globals.css @media print).
    expect(html).toContain('data-print-statement');
    // The control exists on screen and is suppressed from the printout.
    expect(html).toContain('data-testid="audit-statement-print"');
    expect(html).toContain('data-no-print');
    // The PDF path is the browser's print dialog — no PDF library ships.
    expect(html).not.toContain('iframe');
  });
});
