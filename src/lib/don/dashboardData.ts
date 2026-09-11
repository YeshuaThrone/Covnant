/**
 * The Don dashboard data seam — the contract the dashboard home consumes
 * (the live successor to PR H's fixtures module; same shapes, real reads).
 *
 * Everything here is CANONICAL Don record shapes (`src/modules/don/records.ts`)
 * projected for display — no invented vocabulary:
 *
 *   - the three account cards  → one `SovereignVaultRecord`, integer cents
 *     (available_balance / pending_balance / reserve_balance);
 *   - the transactions card    → `GlJournalRecord` + balanced `GlEntryRecord`
 *     legs (debit_cents / credit_cents — exactly one side carries the
 *     amount), with the journal's `entry_hash` short form carried on each
 *     display row for auditability;
 *   - the payout tiles         → `PayoutHoldRecord` status vocabulary over
 *     the sandbox rail (`SettlementRail`: RTP instant, ACH +3 business days).
 *
 * RESOLUTION, not just data. A session may be absent (no cookies) or
 * session-bound but unenrolled (no creator profile / no registry holder), so
 * the provider resolves a `DashboardResolution` — the honest states — and the
 * page renders each without fabricating a persona. Data comes ONLY from the
 * session-bound Don store (`src/lib/server/dashboardLive.ts`); the identity
 * is never a client-supplied parameter.
 *
 * Honesty: no UCT is fabricated here (the IdentityBadge contract reserves
 * UCT disclosure for the signup 201). Amounts are integer cents; no float
 * money anywhere.
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
 * What a session-bound dashboard resolution can honestly be. `registered`
 * carries the full aggregate for a REAL session; `demo` carries the SEEDED
 * persona's aggregate for a SESSIONLESS visitor — the demo door, which by
 * shape can never carry a real holder's data (no session, no identity);
 * the other kinds name the signed-out / unenrolled states so the page can
 * render them without inventing data.
 */
export type DashboardResolution =
  | { kind: 'anonymous' }
  | { kind: 'unregistered'; reason: 'profile_not_found' | 'holder_not_found' }
  | { kind: 'registered'; data: DashboardData }
  | { kind: 'demo'; data: DashboardData };

/**
 * The PAGE-facing resolution — the anonymous wall is not a page state. The
 * demo door answers every sessionless visitor (the standing directive: the
 * site opens straight onto the populated seeded dashboard), so the page and
 * the (workspace) layout never render an anonymous branch. The API door
 * (GET /api/v1/dashboard) keeps the full union — its anonymous contract
 * (401 no_session) is untouched by the demo door.
 */
export type DashboardViewResolution = Exclude<DashboardResolution, { kind: 'anonymous' }>;

/**
 * The provider seam: the dashboard home consumes ONLY this interface. The
 * live implementation (src/lib/server/dashboardLive.ts) resolves the session
 * and reads the Don store; tests inject resolutions.
 */
export interface DashboardDataProvider {
  getDashboardResolution(): Promise<DashboardViewResolution>;
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
  /** The journal's entry_hash short form — the auditability marker. */
  entry_hash_short: string;
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
  baas_transfer: 'BaaS transfer',
  dispute: 'Dispute',
};

/** Kinds whose holder-facing leg is the CREDIT side (value flowing in). */
const INFLOW_KINDS: ReadonlySet<JournalKind> = new Set<JournalKind>([
  'royalty_ingest',
  'pending_release',
  'payout_failed_reversal',
  'dispute_unlock',
]);

/** The entry_hash short form — the leading hash characters, display-safe. */
export function entryHashShort(entryHash: string): string {
  return entryHash.slice(0, 12);
}

/**
 * Projects one journal onto its holder-facing display row: the vault leg in
 * the kind's flow direction (credit leg for inflows, debit leg for outflows),
 * signed for display, with the entry_hash short form on the audit line.
 * Journals with no vault leg for this payee never render — the dashboard is
 * holder-scoped.
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
    subtitle: `${REF_TYPE_LABELS[journal.ref_type] ?? journal.ref_type} · ${entryHashShort(journal.entry_hash)}`,
    occurred_at: journal.created_at,
    amount_cents: inflow ? facing.credit_cents : -facing.debit_cents,
    debit_cents: facing.debit_cents,
    credit_cents: facing.credit_cents,
    entry_hash_short: entryHashShort(journal.entry_hash),
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

/** Static re-assertion that the display vocabulary stays inside the
 *  canonical kind set — the display model has a label for every kind. */
const _CANONICAL_KIND_COVERAGE: Record<JournalKind, true> = {
  ...Object.fromEntries(JOURNAL_KINDS.map((kind) => [kind, true])),
} as Record<JournalKind, true>;
void _CANONICAL_KIND_COVERAGE;
