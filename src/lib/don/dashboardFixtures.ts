/**
 * The Don dashboard fixtures — the data seam for the dashboard home (PR H).
 *
 * The dashboard renders through the `DashboardDataProvider` interface; today
 * the implementation is fixtures, and the follow-up PR swaps in the live
 * resolver without touching a single component. Every mock value is shaped
 * EXACTLY as the canonical Don records (`src/modules/don/records.ts`) so the
 * swap is a type-check, not a rewrite:
 *
 *   - the three account cards  → one `SovereignVaultRecord`, integer cents
 *     (available_balance / pending_balance / reserve_balance);
 *   - the transactions card    → `GlJournalRecord` + balanced `GlEntryRecord`
 *     legs (debit_cents / credit_cents — exactly one side carries the
 *     amount), built with the same `vaultDebit` / `fboCredit` helpers the
 *     engine posts with, using canonical GL accounts and journal kinds;
 *   - the payout tiles         → `PayoutHoldRecord` status vocabulary over
 *     the sandbox rail (`SettlementRail`: RTP instant, ACH +3 business days).
 *
 * Honesty: fixtures are mock DATA, not mock identity documents — no UCT is
 * fabricated (the IdentityBadge contract reserves UCT disclosure for the
 * signup 201). Amounts are integer cents; no float money anywhere.
 */

import type { BaasProvider, SettlementRail } from '@/lib/don/types';
import {
  JOURNAL_KINDS,
  type JournalKind,
} from '@/modules/don/constants';
import type {
  GlEntryRecord,
  GlJournalRecord,
  PayoutHoldRecord,
  SovereignVaultRecord,
} from '@/modules/don/records';
import {
  fboCredit,
  fboDebit,
  validateJournal,
  vaultCredit,
  vaultDebit,
  type GlLegInput,
} from '@/modules/ledger/journal';

// ── Data contract ────────────────────────────────────────────────────────────

/** The dashboard identity — greeting voice only, never an identity document. */
export type DashboardUser = {
  stage_name: string;
  initials: string;
};

/** Readiness rows use the canonical vocabularies, not invented ones. */
export type DashboardReadiness = {
  kyc_status: string;
  /** CreatorTaxProfile vocabulary — 0/1 columns. */
  tin_verified: number;
  w9_on_file: number;
  bank_account_linked: boolean;
  provisioning_status: 'PROVISIONED' | 'PENDING';
};

/** One journal with its posted legs — the display unit of the GL ledger. */
export type DashboardLedgerEntry = {
  journal: GlJournalRecord;
  entries: GlEntryRecord[];
};

/** A payout in flight on the sandbox rail, attributed to its rail. */
export type DashboardPayout = {
  hold: PayoutHoldRecord;
  rail: SettlementRail;
  provider: BaasProvider;
};

export type DashboardData = {
  user: DashboardUser;
  vault: SovereignVaultRecord;
  ledger: DashboardLedgerEntry[];
  payouts: DashboardPayout[];
  readiness: DashboardReadiness;
};

/**
 * The provider seam: the dashboard home consumes ONLY this interface. The
 * fixtures implementation ships today; the live swap implements the same
 * contract against the Don engine and replaces the export in one place.
 */
export interface DashboardDataProvider {
  getDashboardData(): Promise<DashboardData>;
}

// ── Display model (pure — unit-tested invariants) ───────────────────────────

/** The transactions card's rows — the holder-facing leg of each journal. */
export type DisplayTransaction = {
  id: string;
  title: string;
  subtitle: string;
  occurred_at: string;
  /** Signed net effect on the holder's vault leg — display cents. */
  amount_cents: number;
  /** The raw leg pair (exactly one side non-zero), for the audit line. */
  debit_cents: number;
  credit_cents: number;
};

/** Canonical kind → the bank-voice title. Total over JOURNAL_KINDS. */
const JOURNAL_KIND_LABELS: Record<JournalKind, string> = {
  royalty_ingest: 'Royalty settlement',
  pending_release: 'Pending released to available',
  payout_hold: 'Payout in flight',
  payout_settled: 'Payout settled',
  payout_failed_reversal: 'Payout returned',
  dispute_lock: 'Dispute hold placed',
  dispute_unlock: 'Dispute hold lifted',
  royalty_reversal: 'Royalty reversed',
};

const REF_TYPE_LABELS: Record<string, string> = {
  dsp_report: 'DSP report',
  split_run: 'Split run',
  payout_transfer: 'BaaS transfer',
  dispute: 'Dispute',
};

/** Kinds whose holder-facing leg is the CREDIT side (value flowing in). */
const INFLOW_KINDS: ReadonlySet<JournalKind> = new Set<JournalKind>([
  'royalty_ingest',
  'pending_release',
  'payout_failed_reversal',
  'dispute_unlock',
]);

/**
 * Projects one journal onto its holder-facing display row: the vault leg in
 * the kind's flow direction (credit leg for inflows, debit leg for outflows),
 * signed for display. Journals with no vault leg for this payee never render
 * — the dashboard is holder-scoped.
 */
export function displayTransaction(
  payeeId: string,
  { journal, entries }: DashboardLedgerEntry,
): DisplayTransaction | null {
  const vaultPrefix = `vault:${payeeId}:`;
  const facing = entries.find((entry) => {
    const isVault = entry.account.startsWith(vaultPrefix);
    return INFLOW_KINDS.has(journal.kind as JournalKind)
      ? isVault && entry.credit_cents > 0
      : isVault && entry.debit_cents > 0;
  });
  if (!facing) return null;

  const inflow = INFLOW_KINDS.has(journal.kind as JournalKind);
  return {
    id: journal.id,
    title: JOURNAL_KIND_LABELS[journal.kind as JournalKind],
    subtitle: REF_TYPE_LABELS[journal.ref_type] ?? journal.ref_type,
    occurred_at: journal.created_at,
    amount_cents: inflow ? facing.credit_cents : -facing.debit_cents,
    debit_cents: facing.debit_cents,
    credit_cents: facing.credit_cents,
  };
}

/** The transactions card's rows — newest first, holder-scoped. */
export function displayTransactions(ledger: DashboardLedgerEntry[], payeeId: string): DisplayTransaction[] {
  return ledger
    .map((entry) => displayTransaction(payeeId, entry))
    .filter((row): row is DisplayTransaction => row !== null)
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0));
}

/** The payout tiles — sandbox-rail ETAs over canonical hold records. */
export type PayoutTile = {
  rail: SettlementRail;
  provider: BaasProvider;
  rail_label: string;
  eta_label: string;
  amount_cents: number;
  status: PayoutHoldRecord['status'];
};

/** ACH settles in 3 business days on the sandbox rail (sandboxRail.ts). */
export const ACH_ETA_LABEL = '+3 business days';
export const RTP_ETA_LABEL = 'Instant';

export function payoutTiles(payouts: DashboardPayout[]): PayoutTile[] {
  return payouts.map(({ hold, rail, provider }) => ({
    rail,
    provider,
    rail_label: rail.toUpperCase(),
    eta_label: rail === 'rtp' ? RTP_ETA_LABEL : ACH_ETA_LABEL,
    amount_cents: hold.amount_cents,
    status: hold.status,
  }));
}

// ── Fixture construction ─────────────────────────────────────────────────────

const PAYEE_ID = 'rh_nova_reign_don';
const PAYEE_NAME = 'Nova Reign';

/** A journal + legs from raw inputs, validated at construction: a fixture
 *  that violates GL integrity would poison every downstream test. */
function fixtureJournal(
  id: string,
  kind: JournalKind,
  refType: string,
  refId: string,
  createdAt: string,
  legs: GlLegInput[],
): DashboardLedgerEntry {
  const validity = validateJournal(legs);
  if (!validity.ok) {
    throw new Error(`fixture journal ${id} violates GL integrity: ${JSON.stringify(validity)}`);
  }
  const journal: GlJournalRecord = {
    id,
    kind,
    ref_type: refType,
    ref_id: refId,
    created_at: createdAt,
    sequence: 0,
    prev_hash: GL_GENESIS,
    entry_hash: `don-fixture/${id}`,
    state: 'posted',
  };
  const entries: GlEntryRecord[] = legs.map((leg, index) => ({
    id: `${id}-leg-${index + 1}`,
    journal_id: id,
    account: leg.account,
    debit_cents: leg.debit_cents,
    credit_cents: leg.credit_cents,
    created_at: createdAt,
  }));
  return { journal, entries };
}

const GL_GENESIS = 'don-fixture/gl/genesis';

/** Fresh objects per call — a consumer mutating fixture data cannot corrupt
 *  another consumer's view. */
function buildFixtureLedger(): DashboardLedgerEntry[] {
  return [
    fixtureJournal('fx_j_001', 'royalty_ingest', 'dsp_report', 'dsp_spotify_2026_09', '2026-09-06T14:00:00.000Z', [
      fboDebit(12_990),
      vaultCredit(PAYEE_ID, 'pending', 12_990),
    ]),
    fixtureJournal('fx_j_002', 'pending_release', 'split_run', 'split_run_2026_09_07', '2026-09-07T09:00:00.000Z', [
      vaultDebit(PAYEE_ID, 'pending', 150_000),
      vaultCredit(PAYEE_ID, 'available', 150_000),
    ]),
    fixtureJournal('fx_j_003', 'royalty_ingest', 'dsp_report', 'dsp_bandcamp_2026_09', '2026-09-07T16:30:00.000Z', [
      fboDebit(4_750),
      vaultCredit(PAYEE_ID, 'pending', 4_750),
    ]),
    fixtureJournal('fx_j_004', 'payout_hold', 'payout_transfer', 'baas_rtp_0007', '2026-09-08T14:00:00.000Z', [
      vaultDebit(PAYEE_ID, 'available', 25_000),
      vaultCredit(PAYEE_ID, 'pending', 25_000),
    ]),
    fixtureJournal('fx_j_005', 'payout_settled', 'payout_transfer', 'baas_rtp_0007', '2026-09-08T14:00:02.000Z', [
      vaultDebit(PAYEE_ID, 'pending', 25_000),
      fboCredit(25_000),
    ]),
    fixtureJournal('fx_j_006', 'royalty_ingest', 'dsp_report', 'dsp_youtube_2026_08', '2026-08-29T12:00:00.000Z', [
      fboDebit(88_405),
      vaultCredit(PAYEE_ID, 'pending', 88_405),
    ]),
    fixtureJournal('fx_j_007', 'royalty_ingest', 'dsp_report', 'dsp_amazon_2026_08', '2026-08-21T12:00:00.000Z', [
      fboDebit(21_340),
      vaultCredit(PAYEE_ID, 'pending', 21_340),
    ]),
  ];
}

function buildFixtureData(): DashboardData {
  const ledger = buildFixtureLedger();
  return {
    user: { stage_name: PAYEE_NAME, initials: 'NR' },
    vault: {
      payee_id: PAYEE_ID,
      payee_name: PAYEE_NAME,
      available_balance: 247_830,
      pending_balance: 91_205,
      reserve_balance: 45_000,
      updated_at: '2026-09-09T18:00:00.000Z',
    },
    ledger,
    payouts: [
      {
        hold: {
          transfer_id: 'baas_rtp_0007',
          payee_id: PAYEE_ID,
          amount_cents: 25_000,
          status: 'in_flight',
          created_at: '2026-09-08T14:00:00.000Z',
        },
        rail: 'rtp',
        provider: 'column',
      },
      {
        hold: {
          transfer_id: 'baas_ach_0012',
          payee_id: PAYEE_ID,
          amount_cents: 120_000,
          status: 'in_flight',
          created_at: '2026-09-08T09:00:00.000Z',
        },
        rail: 'ach',
        provider: 'unit',
      },
    ],
    readiness: {
      kyc_status: 'APPROVED',
      tin_verified: 1,
      w9_on_file: 1,
      bank_account_linked: true,
      provisioning_status: 'PROVISIONED',
    },
  };
}

/** The dashboard's provider — fixtures until the live swap. */
export const fixturesDashboardDataProvider: DashboardDataProvider = {
  getDashboardData: () => Promise.resolve(buildFixtureData()),
};

/** Static re-assertion that the fixture kinds stay inside the canonical set. */
const _CANONICAL_KIND_COVERAGE: Record<JournalKind, true> = {
  ...Object.fromEntries(JOURNAL_KINDS.map((kind) => [kind, true])),
} as Record<JournalKind, true>;
void _CANONICAL_KIND_COVERAGE;
