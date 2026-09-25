/**
 * OperationsSection — the back-office tab's render suite (spec
 * art_Eis55ifL). Pins the five areas' populated shapes, every honest-empty
 * variant (including the designed-empty reconciliation group under the
 * demo seed, the designed-empty ingest and quarantine lists, and the two
 * DISTINCT audit empty states — persisted true vs false), the fail-closed
 * unavailable state, and the units law: escrow-holder and registry money
 * renders through the exact micro-unit formatter (1e-8, bigint), every
 * cents figure through formatCentsBigint — a micro never passes through a
 * cents formatter (that would render it 1e-8× small).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { JOURNAL_KINDS } from '@/modules/don/constants';
import type {
  OperationsFlows,
  OperationsJournalKindRow,
  OperationsMatchQueueEntry,
} from '@/lib/admin/operations';
import {
  OperationsSection,
  auditChangeLines,
  formatMicroUnits,
  registryStatementHref,
} from '../OperationsSection';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — the derivation module's real payload shapes, with figures
// standing in for what the stores hand the page. Cents figures are integer
// bigints; the escrow/registry figures are micro units (1e-8).
// ─────────────────────────────────────────────────────────────────────────────

const QUARANTINE_ENTRY: OperationsMatchQueueEntry = {
  id: 'mq_001',
  eventId: 'evt_404',
  status: 'open',
  reason: 'no_identifier_match',
  source: 'webhook',
  platform: 'Spotify',
  territory: 'US',
  currency: 'USD',
  grossMicros: 12_345_678n,
  createdAt: '2026-09-24T10:00:00.000Z',
};

const JOURNAL_MOVEMENTS: readonly OperationsJournalKindRow[] = [
  ...JOURNAL_KINDS.map(
    (kind): OperationsJournalKindRow =>
      kind === 'royalty_ingest'
        ? { kind, journalCount: 119, creditCents: 844_510_373_336n, debitCents: 0n, latestDay: '2026-09-25' }
        : { kind, journalCount: 0, creditCents: 0n, debitCents: 0n, latestDay: null },
  ),
  // An observed non-canon kind appends after the canon eight — verbatim label.
  { kind: 'settlement_adjustment', journalCount: 1, creditCents: 500n, debitCents: 500n, latestDay: '2026-09-24' },
];

const FLOWS: OperationsFlows = {
  escrowSettlements: {
    vaults: [
      {
        payeeId: 'rh_yeshua_throne_don',
        payeeName: 'Yeshua Throne',
        availableCents: 330_000_000n,
        pendingCents: 65_000_000n,
        reserveCents: 100_000_000_000n,
        inFlightHoldCents: 65_000_000n,
        dispute: {
          locked: true,
          lineItemId: 'li_dispute_01',
          frozenFromAvailableCents: 10_000_000n,
          frozenFromPendingCents: 5_000_000n,
          updatedAt: '2026-09-20T12:00:00.000Z',
        },
        updatedAt: '2026-09-21T12:00:00.000Z',
      },
      {
        payeeId: 'rh_thrones_label_don',
        payeeName: 'Thrones Rights Group',
        availableCents: 0n,
        pendingCents: 427_843_706_668n,
        reserveCents: 0n,
        inFlightHoldCents: 0n,
        dispute: null,
        updatedAt: '2026-09-21T12:00:00.000Z',
      },
    ],
    transfers: [
      {
        transferId: 'tr_001',
        provider: 'column',
        rail: 'rtp',
        payeeId: 'rh_yeshua_throne_don',
        payeeName: 'Yeshua Throne',
        amountCents: 12_500_000n,
        currency: 'USD',
        status: 'submitted',
        estimatedSettlement: '2026-09-26T00:00:00.000Z',
        ledgerTransactionId: 'lt_001',
        createdAt: '2026-09-25T09:00:00.000Z',
      },
      {
        transferId: 'tr_002',
        provider: 'unit',
        rail: 'ach',
        payeeId: 'rh_thrones_label_don',
        payeeName: 'Thrones Rights Group',
        amountCents: 2_400_000n,
        currency: 'USD',
        status: 'settled',
        estimatedSettlement: null,
        ledgerTransactionId: null,
        createdAt: '2026-09-24T09:00:00.000Z',
      },
    ],
    escrowHolders: [
      {
        rightsHolderId: 'rh_yeshua_throne_don',
        name: 'Yeshua Throne',
        currencies: ['USD'],
        storedGrossUnits: 100_000_000_000n,
        storedWithheldUnits: 24_000_000_000n,
        storedNetUnits: 76_000_000_000n,
        paidOutUnits: 10_000_000_000n,
        engineGrossUnits: 100_000_000_000n,
        engineTaxWithheldUnits: 24_000_000_000n,
        enginePreviousPayoutUnits: 10_000_000_000n,
        engineAvailableUnits: 66_000_000_000n,
        taxProfileSource: 'registry',
      },
      {
        rightsHolderId: 'rh_unlisted_don',
        name: 'Unlisted Holder',
        currencies: ['USD'],
        storedGrossUnits: 1n,
        storedWithheldUnits: 0n,
        storedNetUnits: 1n,
        paidOutUnits: 0n,
        engineGrossUnits: 1n,
        engineTaxWithheldUnits: 0n,
        enginePreviousPayoutUnits: 0n,
        engineAvailableUnits: 1n,
        taxProfileSource: 'unverified-fallback',
      },
    ],
    taxEscrowRows: [
      {
        payeeId: 'rh_yeshua_throne_don',
        payeeName: 'Yeshua Throne',
        taxYear: 2026,
        grossCents: 100_000_000_000n,
        withheldCents: 24_000_000_000n,
        netCents: 76_000_000_000n,
        tinVerified: false,
        w9OnFile: false,
        requires1099: true,
        crossed1099Threshold: true,
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ],
    journalMovements: JOURNAL_MOVEMENTS,
  },
  runsPipeline: {
    runs: [
      {
        runId: 'run_001',
        source: 'cwr-import',
        period: '2026-08',
        currency: 'USD',
        grossCents: 12_500_000n,
        lineItemCount: 42,
        varianceAccountCents: 0n,
        status: 'posted',
        createdAt: '2026-09-01T00:00:00.000Z',
        reversal: null,
      },
      {
        runId: 'run_002',
        source: 'csv-import',
        period: '2026-07',
        currency: 'USD',
        grossCents: 8_000_000n,
        lineItemCount: 17,
        varianceAccountCents: -150n,
        status: 'reversed',
        createdAt: '2026-08-01T00:00:00.000Z',
        reversal: { reversalId: 'rev_002', journalId: 'j_rev_002', createdAt: '2026-08-15T00:00:00.000Z' },
      },
    ],
    ingests: [],
    matchQueue: { openCount: 0, matchedCount: 0, discardedCount: 0, openEntries: [] },
  },
  exceptionQueue: {
    reconciliation: { totalRows: 8, passCount: 8, driftCount: 0, status: 'RECONCILED', driftRows: [] },
    taxLocks: [
      {
        identityKey: 'identity-operations',
        payeeName: 'Operations Payee',
        lockReason: 'INVALID_OR_MISSING_TIN_BACKUP_WITHHOLDING',
        payoutCount: 4,
        grossCents: 400_000_000n,
        withheldCents: 96_000_000n,
        stateTaxCents: 0n,
        netCents: 304_000_000n,
      },
      {
        identityKey: 'identity-vault-runners',
        payeeName: 'Vault Runners',
        lockReason: 'UNVERIFIED_FOREIGN_PAYEE_MANDATORY_30_PERCENT_LOCK',
        payoutCount: 6,
        grossCents: 600_000_000n,
        withheldCents: 180_000_000n,
        stateTaxCents: 0n,
        netCents: 420_000_000n,
      },
    ],
    excludedNonUsdSettlements: 1,
    quarantinedEvents: [],
  },
  registry: [
    {
      payeeId: 'rh_yeshua_throne_don',
      identityKey: 'identity-yeshua-throne',
      uctIdentity: { uctId: 'UCT-0001', name: 'Yeshua Throne', isni: '0000 0001 2345 6789', ipi: '00123456789' },
      taxBranch: { countryCode: 'US', tinStatus: 'UNSUBMITTED', formType: '1099_MISC', usResident: true, treatyClaimActive: false },
      storeUct: { uctNumber: 'UCT-0001', isni: '0000 0001 2345 6789' },
      creatorProfileId: null,
      creditedGrossUnits: 100_000_000_000n,
      creditedWithheldUnits: 24_000_000_000n,
      creditedNetUnits: 76_000_000_000n,
      settlementCurrencies: ['USD'],
      vault: { availableCents: 330_000_000n, pendingCents: 65_000_000n, reserveCents: 100_000_000_000n },
      runCount: 5,
    },
    {
      payeeId: 'rh_unjoined_don',
      identityKey: 'identity-unjoined',
      uctIdentity: null,
      taxBranch: null,
      storeUct: null,
      creatorProfileId: null,
      creditedGrossUnits: 0n,
      creditedWithheldUnits: 0n,
      creditedNetUnits: 0n,
      settlementCurrencies: [],
      vault: null,
      runCount: 0,
    },
  ],
  auditLog: {
    persisted: true,
    rows: [
      {
        id: 'aa_001',
        actor: 'admin',
        action: 'creator.compliance.update',
        targetTable: 'creator_profiles',
        targetRowId: 'creator_seeded_a',
        changes: { kyc_status: { from: 'PENDING_INITIALIZATION', to: 'VERIFIED' } },
        createdAt: '2026-09-25T08:00:00.000Z',
      },
    ],
  },
};

function ready(flows: OperationsFlows = FLOWS): { operations: { kind: 'ready'; value: OperationsFlows }; demo: boolean } {
  return { operations: { kind: 'ready', value: flows }, demo: true };
}

function render(operations: OperationsFlows): string {
  return renderToStaticMarkup(<OperationsSection {...ready(operations)} />);
}

/** Every list emptied — the all-empty baseline each honest-empty test starts from. */
function allEmpty(flows: OperationsFlows): OperationsFlows {
  return {
    ...flows,
    escrowSettlements: {
      ...flows.escrowSettlements,
      vaults: [],
      transfers: [],
      escrowHolders: [],
      taxEscrowRows: [],
    },
    runsPipeline: {
      runs: [],
      ingests: [],
      matchQueue: { openCount: 0, matchedCount: 0, discardedCount: 0, openEntries: [] },
    },
    exceptionQueue: { ...flows.exceptionQueue, taxLocks: [], quarantinedEvents: [], excludedNonUsdSettlements: 0 },
    registry: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The formatter laws
// ─────────────────────────────────────────────────────────────────────────────

describe('formatMicroUnits — the escrow micro-unit voice', () => {
  it('renders 1e-8 units exactly — never through a cents formatter', () => {
    // One micro = one hundred-millionth of a unit; a cents formatter would show $0.00.
    expect(formatMicroUnits(1n, 'USD')).toBe('0.00000001 USD');
    expect(formatMicroUnits(100_000_000_000n, 'USD')).toBe('1,000.00000000 USD');
    expect(formatMicroUnits(0n, 'USD')).toBe('0.00000000 USD');
  });

  it('groups thousands and carries the true minus', () => {
    expect(formatMicroUnits(833_333_333_336n, 'USD')).toBe('8,333.33333336 USD');
    expect(formatMicroUnits(-5n, 'USD')).toBe('−0.00000005 USD');
  });
});

describe('auditChangeLines — the field-level diff voice', () => {
  it('renders each field as from → to, honest per value kind', () => {
    expect(
      auditChangeLines({
        kyc_status: { from: 'PENDING_INITIALIZATION', to: 'VERIFIED' },
        reserveCents: { from: 0, to: 100_000_000 },
        locked: { from: false, to: true },
        note: { from: null, to: 'first freeze' },
        cleared: { from: '', to: 'yes' },
        meta: { from: { a: 1 }, to: { a: 2 } },
      }),
    ).toEqual([
      'kyc_status: PENDING_INITIALIZATION → VERIFIED',
      'reserveCents: 0 → 100000000',
      'locked: false → true',
      'note: — → first freeze',
      'cleared: — → yes',
      'meta: {"a":1} → {"a":2}',
    ]);
  });
});

describe('registryStatementHref — the per-payee statement route', () => {
  it('carries the payee of record as the route param', () => {
    expect(registryStatementHref('rh_yeshua_throne_don')).toBe('/admin/audit-statement?payee=rh_yeshua_throne_don');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The populated tab — five areas, spec order
// ─────────────────────────────────────────────────────────────────────────────

describe('OperationsSection — the populated tab', () => {
  const html = render(FLOWS);

  it('renders the console shell with the demo badge disclosed', () => {
    expect(html).toContain('aria-label="Operations"');
    expect(html).toContain('Operations back office');
    expect(html).toContain('data-testid="demo-data-badge"');
  });

  it('renders the five areas in spec order', () => {
    const order = ['operations-escrow', 'operations-runs', 'operations-exceptions', 'operations-registry', 'operations-audit'];
    const positions = order.map((testid) => html.indexOf(`data-testid="${testid}"`));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('renders the vault buckets with exact cents figures and the in-flight holds', () => {
    expect(html).toContain('data-testid="operations-vaults-table"');
    expect(html).toContain('data-payee="rh_yeshua_throne_don"');
    expect(html).toContain('$3,300,000.00'); // available
    expect(html).toContain('$650,000.00'); // pending + in-flight holds
    expect(html).toContain('$1,000,000,000.00'); // reserve — the billion-dollar pin
    expect(html).toContain('$4,278,437,066.68'); // label pending
  });

  it('renders the dispute freeze of record', () => {
    expect(html).toContain('data-testid="operations-disputes-list"');
    expect(html).toContain('Frozen');
    expect(html).toContain('li_dispute_01');
    expect(html).toContain('$100,000.00'); // frozen from available
    expect(html).toContain('$50,000.00'); // frozen from pending
  });

  it('renders the BaaS transfers with rail, provider, status, and ETA', () => {
    expect(html).toContain('data-testid="operations-transfers-table"');
    expect(html).toContain('tr_001');
    expect(html).toContain('column');
    expect(html).toContain('rtp');
    expect(html).toContain('unit');
    expect(html).toContain('ach');
    expect(html).toContain('$125,000.00');
    expect(html).toContain('2026-09-26T00:00:00.000Z'); // the ETA of record
  });

  it('renders the escrow holders in two disclosed layers — stored record and balance engine', () => {
    expect(html).toContain('data-testid="operations-escrow-holders-stored"');
    expect(html).toContain('data-testid="operations-escrow-holders-engine"');
    // Stored layer pins — exact micro units through the 1e-8 formatter.
    expect(html).toContain('1,000.00000000 USD');
    expect(html).toContain('760.00000000 USD');
    expect(html).toContain('100.00000000 USD');
    // Engine layer pins.
    expect(html).toContain('660.00000000 USD');
    // The exactness probe — one micro renders as 0.00000001, never $0.00.
    expect(html).toContain('0.00000001 USD');
    // The tax-profile source of record is disclosed, per holder.
    expect(html).toContain('unverified fallback');
  });

  it('renders the tax-escrow ledger with the 1099 threshold state', () => {
    expect(html).toContain('data-testid="operations-tax-escrow-table"');
    expect(html).toContain('2026');
    expect(html).toContain('$1,000,000,000.00'); // gross
    expect(html).toContain('$240,000,000.00'); // withheld
    expect(html).toContain('$760,000,000.00'); // net
    expect(html).toContain('threshold crossed');
  });

  it('renders all eight canon journal kinds plus the non-canon append, zero rows honest', () => {
    expect(html).toContain('data-testid="operations-journal-movements-table"');
    expect(html).toContain('royalty_ingest');
    expect(html).toContain('$8,445,103,733.36');
    // A zero-journal canon kind renders as a real zero row with no latest day.
    expect(html).toContain('pending_release');
    expect(html).toContain('—');
    // The non-canon kind appends, labeled verbatim.
    expect(html).toContain('settlement_adjustment');
    // All eight canon kinds present in the markup.
    for (const kind of JOURNAL_KINDS) expect(html).toContain(kind);
  });
});

describe('OperationsSection — runs & pipeline health, populated', () => {
  it('renders the split runs with status, variance, and reversal of record', () => {
    const html = render({
      ...FLOWS,
      runsPipeline: {
        ...FLOWS.runsPipeline,
        ingests: [
          {
            ingestId: 'ing_001',
            format: 'cwr',
            source: 'statement',
            fileName: 'Q3-2026.CWR',
            status: 'parsed',
            eventCount: 1204,
            error: null,
            createdAt: '2026-09-23T00:00:00.000Z',
          },
          {
            ingestId: 'ing_002',
            format: 'csv_statement',
            source: 'manual',
            fileName: 'bad-upload.csv',
            status: 'failed',
            eventCount: null,
            error: 'unrecognized header row',
            createdAt: '2026-09-24T00:00:00.000Z',
          },
        ],
        matchQueue: {
          openCount: 1,
          matchedCount: 3,
          discardedCount: 2,
          openEntries: [QUARANTINE_ENTRY],
        },
      },
    });

    expect(html).toContain('data-testid="operations-runs-table"');
    expect(html).toContain('run_001');
    expect(html).toContain('posted');
    expect(html).toContain('reversed');
    expect(html).toContain('$125,000.00');
    expect(html).toContain('rev_002');
    expect(html).toContain('−$1.50'); // the negative variance, the true minus

    // The populated ingest provenance — parsed and failed both render.
    expect(html).toContain('data-testid="operations-ingests-table"');
    expect(html).toContain('Q3-2026.CWR');
    expect(html).toContain('1204');
    expect(html).toContain('unrecognized header row');

    // The match queue health counts + the open quarantine with its micros.
    expect(html).toContain('data-testid="operations-match-queue"');
    expect(html).toContain('1 open');
    expect(html).toContain('3 matched');
    expect(html).toContain('2 discarded');
    expect(html).toContain('data-testid="operations-match-queue-entries"');
    expect(html).toContain('evt_404');
    expect(html).toContain('no_identifier_match');
    expect(html).toContain('0.12345678 USD');
  });
});

describe('OperationsSection — the verification-exception queue', () => {
  it('renders the three groups separately — reconciliation, tax locks, quarantine', () => {
    const html = render(FLOWS);

    // Group 1 — the reconciliation engine's counts of record.
    expect(html).toContain('data-testid="operations-reconciliation"');
    expect(html).toContain('RECONCILED');
    expect(html).toContain('8 passed of 8 rows · 0 drift');
    // The designed-empty drift group under the demo seed.
    expect(html).toContain('data-testid="operations-reconciliation-clean"');
    expect(html).not.toContain('data-testid="operations-reconciliation-drift-table"');

    // Group 2 — the tax locks at the register's own grain, both lock reasons.
    expect(html).toContain('data-testid="operations-tax-locks"');
    expect(html).toContain('identity-operations');
    expect(html).toContain('INVALID_OR_MISSING_TIN_BACKUP_WITHHOLDING');
    expect(html).toContain('identity-vault-runners');
    expect(html).toContain('UNVERIFIED_FOREIGN_PAYEE_MANDATORY_30_PERCENT_LOCK');
    expect(html).toContain('$4,000,000.00');
    // The excluded non-USD disclosure — singular voice for one row.
    expect(html).toContain('data-testid="operations-nonusd-excluded"');
    expect(html).toContain('1 settled row outside the USD');
    expect(html).not.toContain('1 settled rows');

    // Group 3 — the quarantine, honestly empty in this fixture.
    expect(html).toContain('data-testid="operations-quarantine-empty"');
  });

  it('renders the drift rows verbatim when the reconciliation engine finds drift', () => {
    const html = render({
      ...FLOWS,
      exceptionQueue: {
        ...FLOWS.exceptionQueue,
        reconciliation: {
          totalRows: 8,
          passCount: 7,
          driftCount: 1,
          status: 'ATTENTION',
          driftRows: [
            {
              transactionId: 'DIR-DEMO-0004',
              currency: 'USD',
              expectedMinor: 1_000_000n,
              distributedMinor: 999_999n,
              driftMinor: 1n,
              netDriftCount: 1,
              currencyMismatchCount: 0,
              findings: ['net drift of 1 minor unit', 'currency mismatch unresolved'],
            },
          ],
        },
      },
    });

    expect(html).toContain('ATTENTION');
    expect(html).toContain('7 passed of 8 rows · 1 drift');
    expect(html).toContain('data-testid="operations-reconciliation-drift-table"');
    expect(html).toContain('DIR-DEMO-0004');
    expect(html).toContain('$0.01'); // the drift of record
    expect(html).toContain('net drift of 1 minor unit · currency mismatch unresolved');
    expect(html).not.toContain('data-testid="operations-reconciliation-clean"');
  });

  it('renders quarantined events in the queue group when the quarantine holds events', () => {
    const html = render({
      ...FLOWS,
      exceptionQueue: {
        ...FLOWS.exceptionQueue,
        quarantinedEvents: [QUARANTINE_ENTRY],
      },
    });
    expect(html).toContain('data-testid="operations-quarantine-list"');
    expect(html).toContain('evt_404');
    expect(html).not.toContain('data-testid="operations-quarantine-empty"');
  });
});

describe('OperationsSection — the payee/creator registry', () => {
  it('renders the joins from the join results and links the audit statement', () => {
    const html = render(FLOWS);

    expect(html).toContain('data-testid="operations-registry-table"');
    expect(html).toContain('data-payee="rh_yeshua_throne_don"');
    // The UCT identity join of record.
    expect(html).toContain('UCT-0001');
    expect(html).toContain('ISNI 0000 0001 2345 6789');
    expect(html).toContain('IPI 00123456789');
    // The tax branch join of record.
    expect(html).toContain('US · UNSUBMITTED');
    // The credited money context — micro units, exact.
    expect(html).toContain('1,000.00000000 USD');
    // The per-payee statement link.
    expect(html).toContain('href="/admin/audit-statement?payee=rh_yeshua_throne_don"');
  });

  it('renders unresolved joins as the honest em dash — no invented identity', () => {
    const html = render(FLOWS);
    expect(html).toContain('data-payee="rh_unjoined_don"');
    // The unjoined row's joins all render as em dashes; the payee id stands in for the name.
    expect(html).toContain('0.00000000 USD');
    expect(html).not.toContain('IPI 00000000');
  });
});

describe('OperationsSection — the operator audit log', () => {
  it('renders the append-only rows with actor, action, target, and field-level diffs', () => {
    const html = render(FLOWS);

    expect(html).toContain('data-testid="operations-audit-table"');
    expect(html).toContain('creator.compliance.update');
    expect(html).toContain('creator_profiles · creator_seeded_a');
    expect(html).toContain('kyc_status: PENDING_INITIALIZATION → VERIFIED');
  });

  it('renders rows=[] with persisted=true as nothing-logged-yet', () => {
    const html = render({
      ...FLOWS,
      auditLog: { persisted: true, rows: [] },
    });
    expect(html).toContain('data-testid="operations-audit-empty"');
    expect(html).toContain('Nothing logged yet');
    expect(html).not.toContain('data-testid="operations-audit-unpersisted"');
    expect(html).not.toContain('does not persist');
  });

  it('renders rows=[] with persisted=false as the backend-does-not-persist state — a different message', () => {
    const html = render({
      ...FLOWS,
      auditLog: { persisted: false, rows: [] },
    });
    expect(html).toContain('data-testid="operations-audit-unpersisted"');
    expect(html).toContain('does not persist the audit log');
    expect(html).not.toContain('data-testid="operations-audit-empty"');
    expect(html).not.toContain('Nothing logged yet');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The honest-empty variants — every list, never zeros
// ─────────────────────────────────────────────────────────────────────────────

describe('OperationsSection — the honest-empty states', () => {
  it('renders every escrow & settlements empty state', () => {
    const html = render({
      ...FLOWS,
      escrowSettlements: {
        ...FLOWS.escrowSettlements,
        vaults: [],
        transfers: [],
        escrowHolders: [],
        taxEscrowRows: [],
      },
    });
    expect(html).toContain('data-testid="operations-vaults-empty"');
    expect(html).toContain('data-testid="operations-disputes-empty"');
    expect(html).toContain('data-testid="operations-transfers-empty"');
    expect(html).toContain('data-testid="operations-escrow-holders-empty"');
    expect(html).toContain('data-testid="operations-tax-escrow-empty"');
    expect(html).not.toContain('data-testid="operations-vaults-table"');
    // The journal movements table still renders — the canon kinds are real zero rows.
    expect(html).toContain('data-testid="operations-journal-movements-table"');
  });

  it('renders the pipeline empty states — runs, ingests (designed), quarantine', () => {
    const html = render({
      ...FLOWS,
      runsPipeline: {
        runs: [],
        ingests: [],
        matchQueue: { openCount: 0, matchedCount: 0, discardedCount: 0, openEntries: [] },
      },
    });
    expect(html).toContain('data-testid="operations-runs-empty"');
    expect(html).toContain('data-testid="operations-ingests-empty"');
    expect(html).toContain('No statements ingested');
    expect(html).toContain('data-testid="operations-match-queue-empty"');
    expect(html).not.toContain('data-testid="operations-runs-table"');
  });

  it('renders the queue and registry empty states', () => {
    const html = render(allEmpty(FLOWS));
    expect(html).toContain('data-testid="operations-tax-locks-empty"');
    expect(html).toContain('data-testid="operations-quarantine-empty"');
    expect(html).toContain('data-testid="operations-registry-empty"');
    expect(html).not.toContain('data-testid="operations-registry-table"');
  });

  it('discloses zero excluded non-USD settlements honestly', () => {
    const html = render(allEmpty(FLOWS));
    expect(html).toContain('0 settled rows outside the USD');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The fail-closed unavailable state — distinct from every empty list
// ─────────────────────────────────────────────────────────────────────────────

describe('OperationsSection — the unavailable state', () => {
  it('renders the honest section-unavailable copy and none of the areas', () => {
    const html = renderToStaticMarkup(
      <OperationsSection
        operations={{ kind: 'unavailable', code: 'operations_store_failed', message: 'Operations store read failed.' }}
        demo={true}
      />,
    );
    expect(html).toContain('data-testid="operations-unavailable"');
    expect(html).toContain('Operations store read failed.');
    expect(html).toContain('operations_store_failed');
    // No area renders — an unreadable store never renders as empty lists.
    expect(html).not.toContain('data-testid="operations-escrow"');
    expect(html).not.toContain('data-testid="operations-runs"');
    expect(html).not.toContain('data-testid="operations-exceptions"');
    expect(html).not.toContain('data-testid="operations-registry"');
    expect(html).not.toContain('data-testid="operations-audit"');
  });

  it('omits the demo badge when the demo door is closed', () => {
    const html = renderToStaticMarkup(<OperationsSection {...ready()} demo={false} />);
    expect(html).not.toContain('data-testid="demo-data-badge"');
  });
});
