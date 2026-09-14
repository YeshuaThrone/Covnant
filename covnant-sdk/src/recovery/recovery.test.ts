/**
 * Recovery v1 tests — candidate derivation from seeded quarantine and
 * ledger states, claim-case projection, and the locked no-auto-repair rule.
 *
 * The quarantine path is exercised through the matcher's REAL write path
 * (quarantineProvenance over a canonical event), so the recovery module is
 * proven against the rows the matcher actually writes — not a hand-rolled
 * lookalike. Edge cases seed rows directly.
 */

import { describe, expect, it } from 'vitest';

import { InMemoryStore } from '@/lib/server/inMemoryStore';

import { parseCanonicalRoyaltyEvent } from '../contracts/royalty-event';
import { quarantineProvenance } from '../match/match';
import type { MatchQueueRecord } from '@/modules/sdk/records';
import {
  RECOVERY_SKIP_REASONS,
  claimCaseId,
  deriveClaimCases,
  deriveRecoveryCandidates,
  discoverRecoveryCandidates,
  listClaimCases,
  type RecoveryCandidate,
  type RecoveryDiscovery,
  type RecoveryLedgerRow,
} from './recovery';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const CREATED_AT = '2026-09-14T10:00:00.000Z';

/** An open queue row as the matcher writes it — the full-provenance path. */
async function seededOpenRow(overrides: Partial<MatchQueueRecord> = {}): Promise<MatchQueueRecord> {
  const store = new InMemoryStore();
  const row = await store.insertMatchQueueEntry(quarantineProvenance(canonicalEvent()));
  return { ...row, ...overrides };
}

function queueRow(overrides: Partial<MatchQueueRecord> = {}): MatchQueueRecord {
  return {
    id: 'mq_001',
    event_id: 'evt_001',
    status: 'open',
    reason: 'no_identifier_match',
    rights_pipeline: 'master_digital_performance',
    source: 'webhook',
    platform: null,
    territory: 'US',
    period: '2026-08',
    currency: 'USD',
    gross_micros: '12345',
    identifiers_json: JSON.stringify({ ISRC: 'USX7U2600001' }),
    raw_payload: '{"body":"verbatim-source-payload","lines":7}',
    matched_cbt_code: null,
    resolved_at: null,
    created_at: CREATED_AT,
    ...overrides,
  };
}

/** An unclaimed ledger credit — the lineage lane recorded an unmatched resolution. */
function ledgerRow(overrides: Partial<RecoveryLedgerRow> = {}): RecoveryLedgerRow {
  return {
    reference_id: 'inbound_ach_transfer:inc_1001',
    amount_cents: '12345',
    transaction_type: 'ROYALTY_INBOUND_ACH',
    currency: 'USD',
    metadata: {
      lineage: {
        references: [{ kind: 'ISRC', value: 'USX7U2600001', raw: 'ISRC: USX7U2600001' }],
        resolution: 'unmatched',
        parsedAt: '2026-09-14T09:30:00.000Z',
      },
    },
    created_at: CREATED_AT,
    ...overrides,
  };
}

/** The single candidate of a discovery — throws instead of asserting non-undefined. */
function sole(candidates: readonly RecoveryCandidate[]): RecoveryCandidate {
  const first = candidates[0];
  if (candidates.length !== 1 || first === undefined) {
    throw new Error(`expected exactly 1 candidate, got ${candidates.length}`);
  }
  return first;
}

// ---------------------------------------------------------------------------
// Quarantined-event derivation
// ---------------------------------------------------------------------------

describe('deriveRecoveryCandidates — quarantined events', () => {
  it('derives a full-provenance candidate from an open row the matcher wrote', async () => {
    const row = await seededOpenRow();

    const discovery = deriveRecoveryCandidates({ quarantinedRows: [row], ledgerRows: [] });

    expect(discovery.skipped).toEqual([]);
    expect(discovery.candidates).toHaveLength(1);
    const candidate = discovery.candidates[0];
    expect(candidate).toMatchObject({
      source: 'quarantined_event',
      queueId: row.id,
      eventId: 'evt_001',
      rightsPipeline: 'master_digital_performance',
      ingressSource: 'webhook',
      platform: null,
      territory: 'US',
      period: '2026-08',
      currency: 'USD',
      grossMicros: '12345',
      identifiers: { ISRC: 'USX7U2600001' },
      rawPayload: '{"body":"verbatim-source-payload","lines":7}',
      quarantinedAt: row.created_at,
    });
  });

  it('preserves the raw payload byte-verbatim, whatever it holds', () => {
    const raw = 'RIFF||né davvero|7|二';

    const discovery = deriveRecoveryCandidates({
      quarantinedRows: [queueRow({ raw_payload: raw })],
      ledgerRows: [],
    });

    const candidate = sole(discovery.candidates);
    expect(candidate.source === 'quarantined_event' && candidate.rawPayload === raw).toBe(true);
  });

  it('ignores matched and discarded rows — resolved history, not skips', () => {
    const discovery = deriveRecoveryCandidates({
      quarantinedRows: [
        queueRow({ id: 'mq_m', status: 'matched', matched_cbt_code: 'CBT-TRK-1234567890AB' }),
        queueRow({ id: 'mq_d', status: 'discarded' }),
      ],
      ledgerRows: [],
    });

    expect(discovery.candidates).toEqual([]);
    expect(discovery.skipped).toEqual([]);
  });

  it('skips and surfaces a row whose identifiers_json is corrupt', () => {
    for (const identifiers_json of [null, '', 'not json', '[1,2]', '{"ISRC":""}']) {
      const discovery = deriveRecoveryCandidates({
        quarantinedRows: [queueRow({ id: 'mq_x', identifiers_json: identifiers_json as string | null })],
        ledgerRows: [],
      });

      expect(discovery.candidates).toEqual([]);
      expect(discovery.skipped).toEqual([
        {
          source: 'quarantined_event',
          recordId: 'mq_x',
          reason: RECOVERY_SKIP_REASONS.corruptIdentifiersJson,
          detail: expect.any(String),
        },
      ]);
    }
  });

  it('skips and surfaces a row whose gross_micros is not non-negative integer text', () => {
    for (const gross of ['-5', '12.5', 'abc']) {
      const discovery = deriveRecoveryCandidates({
        quarantinedRows: [queueRow({ gross_micros: gross })],
        ledgerRows: [],
      });
      expect(discovery.candidates).toEqual([]);
      expect(discovery.skipped[0]?.reason).toBe(RECOVERY_SKIP_REASONS.corruptGrossMicros);
    }
  });

  it('lists a legacy row with no recorded gross — amount unknown, provenance intact', () => {
    const discovery = deriveRecoveryCandidates({
      quarantinedRows: [queueRow({ gross_micros: null })],
      ledgerRows: [],
    });

    expect(discovery.skipped).toEqual([]);
    const candidate = sole(discovery.candidates);
    expect(candidate.source === 'quarantined_event' && candidate.grossMicros === null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unclaimed-ledger-credit derivation
// ---------------------------------------------------------------------------

describe('deriveRecoveryCandidates — unclaimed ledger credits', () => {
  it('derives a candidate from a credit whose lineage resolved unmatched', () => {
    const discovery = deriveRecoveryCandidates({ quarantinedRows: [], ledgerRows: [ledgerRow()] });

    expect(discovery.skipped).toEqual([]);
    expect(discovery.candidates).toEqual([
      {
        source: 'unclaimed_ledger_credit',
        referenceId: 'inbound_ach_transfer:inc_1001',
        transactionType: 'ROYALTY_INBOUND_ACH',
        amountCents: '12345',
        currency: 'USD',
        references: [{ kind: 'ISRC', value: 'USX7U2600001', raw: 'ISRC: USX7U2600001' }],
        lineageParsedAt: '2026-09-14T09:30:00.000Z',
        recordedAt: CREATED_AT,
      },
    ]);
  });

  it('carries the amount as verbatim text — fractional ledger precision included', () => {
    const discovery = deriveRecoveryCandidates({
      quarantinedRows: [],
      ledgerRows: [ledgerRow({ amount_cents: '12345.67000000' })],
    });

    const candidate = sole(discovery.candidates);
    expect(candidate.source === 'unclaimed_ledger_credit' && candidate.amountCents === '12345.67000000').toBe(true);
  });

  it('treats exact-resolution and lineage-less credits as correct absences', () => {
    const discovery = deriveRecoveryCandidates({
      quarantinedRows: [],
      ledgerRows: [
        ledgerRow({
          reference_id: 'ref_exact',
          metadata: {
            lineage: {
              references: [{ kind: 'ISRC', value: 'USX7U2600001', raw: 'ISRC: USX7U2600001' }],
              resolution: 'exact',
              assetCode: 'CBT-TRK-1234567890AB',
              parsedAt: CREATED_AT,
            },
          },
        }),
        ledgerRow({ reference_id: 'ref_no_meta', metadata: null }),
        ledgerRow({ reference_id: 'ref_no_lineage', metadata: { other: 'key' } }),
      ],
    });

    expect(discovery.candidates).toEqual([]);
    expect(discovery.skipped).toEqual([]);
  });

  it('skips and surfaces non-credit rows — returns and zero amounts', () => {
    for (const amount of ['-12345', '0', '0.00000000']) {
      const discovery = deriveRecoveryCandidates({
        quarantinedRows: [],
        ledgerRows: [ledgerRow({ amount_cents: amount })],
      });
      expect(discovery.candidates).toEqual([]);
      expect(discovery.skipped[0]?.reason).toBe(RECOVERY_SKIP_REASONS.nonCreditRow);
      expect(discovery.skipped[0]?.recordId).toBe('inbound_ach_transfer:inc_1001');
    }
  });

  it('skips and surfaces unparsable amounts', () => {
    const discovery = deriveRecoveryCandidates({
      quarantinedRows: [],
      ledgerRows: [ledgerRow({ amount_cents: '12.3.4' })],
    });

    expect(discovery.candidates).toEqual([]);
    expect(discovery.skipped[0]?.reason).toBe(RECOVERY_SKIP_REASONS.unparsableAmountCents);
  });

  it('skips and surfaces corrupt lineage — a lane that exists but will not read', () => {
    for (const metadata of [
      [1, 2, 3],
      { lineage: { references: [], resolution: 'probable_match' } },
      { lineage: { references: 'everything', resolution: 'unmatched' } },
      { lineage: { references: [{ kind: 'ISRC' }], resolution: 'unmatched' } },
    ]) {
      const discovery = deriveRecoveryCandidates({
        quarantinedRows: [],
        ledgerRows: [ledgerRow({ metadata: metadata as unknown })],
      });
      expect(discovery.candidates).toEqual([]);
      expect(discovery.skipped[0]?.reason).toBe(RECOVERY_SKIP_REASONS.corruptLineageMetadata);
      expect(discovery.skipped[0]?.detail).toEqual(expect.any(String));
    }
  });

  it('skips a row whose reference_id is empty — it cannot anchor a case id', () => {
    const discovery = deriveRecoveryCandidates({
      quarantinedRows: [],
      ledgerRows: [ledgerRow({ reference_id: '   ' })],
    });

    expect(discovery.candidates).toEqual([]);
    expect(discovery.skipped[0]).toEqual({
      source: 'unclaimed_ledger_credit',
      recordId: '<unknown>',
      reason: RECOVERY_SKIP_REASONS.corruptReferenceId,
      detail: null,
    });
  });

  it('accepts an unmatched credit with zero references — the money is real regardless', () => {
    const discovery = deriveRecoveryCandidates({
      quarantinedRows: [],
      ledgerRows: [
        ledgerRow({ metadata: { lineage: { references: [], resolution: 'unmatched', parsedAt: CREATED_AT } } }),
      ],
    });

    expect(discovery.skipped).toEqual([]);
    const candidate = sole(discovery.candidates);
    expect(candidate.source === 'unclaimed_ledger_credit' && candidate.references).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Determinism and the claim-case listing
// ---------------------------------------------------------------------------

describe('deriveRecoveryCandidates — determinism', () => {
  it('derives the same discovery from the same sources, every time', async () => {
    const sources = {
      quarantinedRows: [queueRow(), await seededOpenRow({ id: 'mq_002', event_id: 'evt_002' })],
      ledgerRows: [ledgerRow(), ledgerRow({ reference_id: 'inbound_wire_transfer:inc_1002' })],
    };

    const first: RecoveryDiscovery = deriveRecoveryCandidates(sources);
    const second: RecoveryDiscovery = deriveRecoveryCandidates(sources);

    expect(second).toEqual(first);
    expect(first.candidates).toHaveLength(4);
  });
});

describe('deriveClaimCases', () => {
  it('projects candidates 1:1 with deterministic case ids and a summary', async () => {
    const row = await seededOpenRow();
    const discovery = deriveRecoveryCandidates({
      quarantinedRows: [row],
      ledgerRows: [ledgerRow(), ledgerRow({ reference_id: 'ref_skipped', amount_cents: '-1' })],
    });

    const listing = deriveClaimCases(discovery);

    expect(listing.cases).toHaveLength(2);
    expect(listing.cases[0]).toEqual({
      caseId: `recovery:quarantined_event:${row.id}`,
      status: 'recoverable',
      source: 'quarantined_event',
      discoveredAt: row.created_at,
      candidate: discovery.candidates[0],
    });
    expect(listing.cases[1]?.caseId).toBe('recovery:unclaimed_ledger_credit:inbound_ach_transfer:inc_1001');
    expect(listing.summary).toEqual({
      totalCases: 2,
      quarantinedEvents: 1,
      unclaimedLedgerCredits: 1,
      skipped: 1,
    });
  });

  it('mints the same case id for the same candidate — stable across passes', async () => {
    const row = await seededOpenRow();
    const again = await seededOpenRow();

    // Two separate quarantine rows hold distinct ids; the same row always
    // yields the same case id.
    expect(claimCaseId(sole(deriveRecoveryCandidates({ quarantinedRows: [row], ledgerRows: [] }).candidates)))
      .toBe(claimCaseId(sole(deriveRecoveryCandidates({ quarantinedRows: [row], ledgerRows: [] }).candidates)));
    expect(claimCaseId(sole(deriveRecoveryCandidates({ quarantinedRows: [again], ledgerRows: [] }).candidates)))
      .not.toBe(claimCaseId(sole(deriveRecoveryCandidates({ quarantinedRows: [row], ledgerRows: [] }).candidates)));
  });

  it('lists an empty discovery honestly — zero cases, zero summary, no error', () => {
    const listing = deriveClaimCases({ candidates: [], skipped: [] });

    expect(listing.cases).toEqual([]);
    expect(listing.summary).toEqual({
      totalCases: 0,
      quarantinedEvents: 0,
      unclaimedLedgerCredits: 0,
      skipped: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// IO seam — the in-memory store end to end
// ---------------------------------------------------------------------------

describe('discoverRecoveryCandidates and listClaimCases — store seam', () => {
  it('discovers from the live open queue and an injected ledger reader', async () => {
    const store = new InMemoryStore();
    const row = await store.insertMatchQueueEntry(quarantineProvenance(canonicalEvent()));
    const reader = async (): Promise<readonly RecoveryLedgerRow[]> => [ledgerRow()];

    const listing = await listClaimCases(store, reader);

    expect(listing.summary).toEqual({
      totalCases: 2,
      quarantinedEvents: 1,
      unclaimedLedgerCredits: 1,
      skipped: 0,
    });
    expect(listing.cases[0]?.caseId).toBe(`recovery:quarantined_event:${row.id}`);
  });

  it('is read-only — a second listing is identical and the queue is untouched', async () => {
    const store = new InMemoryStore();
    await store.insertMatchQueueEntry(quarantineProvenance(canonicalEvent()));
    const reader = async (): Promise<readonly RecoveryLedgerRow[]> => [ledgerRow()];

    const first = await listClaimCases(store, reader);
    const second = await listClaimCases(store, reader);

    expect(second).toEqual(first);
    expect(await store.listMatchQueueEntries('open', 200)).toHaveLength(1);
  });

  it('derives discovery directly over the store seam', async () => {
    const store = new InMemoryStore();
    await store.insertMatchQueueEntry(quarantineProvenance(canonicalEvent()));

    const discovery = await discoverRecoveryCandidates(store, async () => []);

    expect(discovery.candidates).toHaveLength(1);
    expect(discovery.skipped).toEqual([]);
  });
});
