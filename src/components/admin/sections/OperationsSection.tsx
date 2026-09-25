'use client';

/**
 * Operations — the console's back-office tab (spec art_Eis55ifL): the five
 * operational views in spec order —
 *
 *   1. Escrow & Settlements — vault buckets per payee, payout holds with
 *      their in-flight sum, BaaS transfers (rail/status/ETA), per-rights-
 *      holder escrow state (the stored record and the withdraw-route
 *      engine disclosed side by side, never merged), the tax-escrow
 *      ledger, dispute freezes, and the GL journal-kind movements (all
 *      eight canon kinds always present, zero rows honest).
 *   2. Runs & Pipeline Health — the split runs the royalty-ingest journals
 *      name, the statement-ingest provenance, and the match queue's health
 *      counts.
 *   3. Verification-exception queue — three honestly SEPARATE groups (the
 *      reconciliation engine's findings, the tax engine's locks, the match
 *      queue's quarantine): three computations over three stores, never
 *      merged into one score. Under the demo seed the reconciliation group
 *      is legitimately empty — designed behavior, not a defect.
 *   4. Payee/creator registry — one row per payee the money records name,
 *      the joins shown from the join results, each row linking to its
 *      per-payee audit statement.
 *   5. Operator audit log — the append-only record of who changed what,
 *      field-level from→to. `rows: []` with `persisted: true` reads
 *      "nothing logged yet"; `rows: []` with `persisted: false` reads
 *      "this backend keeps no audit table" — the two empty states render
 *      differently because they say different things.
 *
 * Every figure is the derivation module's (`operations.ts` — it owns the
 * math; this component only renders it). Units are stated once per group:
 * the escrow holders' and registry credited figures are MICRO units
 * (1e-8, the escrow module's own fixed point) through the exact bigint
 * formatter `formatMicroUnits`; every other money field is integer cents
 * through `formatCentsBigint`. A micro never passes through a cents
 * formatter — that would render it 1e-8× small. No `Number()` on money,
 * no float ever touches a balance.
 */

import type { OperationsAuditRow, OperationsFlows } from '@/lib/admin/operations';
import { formatCentsBigint, formatUnitsMinor } from '@/lib/money/format';
import { SectionEmpty, SectionEyebrow, SectionUnavailable, StatusPill } from '../shared';
import type { SectionData } from '../types';

/**
 * The escrow holders' micro-unit voice — bigint units (1e-8 scale, the
 * escrow module's own fixed point) through the ledger's exact display edge
 * (`formatUnitsMinor`, the /ledger page's own formatter, whose input is
 * the same fixed-point value in its string form). Exact at any magnitude
 * — the billion-dollar settlements never round, never lose a digit.
 */
export function formatMicroUnits(units: bigint, currency: string): string {
  return formatUnitsMinor(units.toString(), currency);
}

/**
 * One audit row's field-level changes rendered as `{field}: {from} → {to}`
 * lines. Values render honestly by kind: the true minus voice stays
 * untouched, an empty/absent value reads as an em dash, structured values
 * serialize — never a `[object Object]`.
 */
export function auditChangeLines(changes: OperationsAuditRow['changes']): readonly string[] {
  return Object.entries(changes).map(([field, change]) => {
    return `${field}: ${auditChangeValue(change.from)} → ${auditChangeValue(change.to)}`;
  });
}

function auditChangeValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** The registry row's per-payee audit statement route. */
export function registryStatementHref(payeeId: string): string {
  const params = new URLSearchParams({ payee: payeeId });
  return `/admin/audit-statement?${params.toString()}`;
}

/** Pill tone for a BaaS transfer status — jade settled, amber submitted, red failed/returned. */
function transferStatusTone(status: OperationsFlows['escrowSettlements']['transfers'][number]['status']) {
  switch (status) {
    case 'settled':
      return 'jade' as const;
    case 'submitted':
      return 'amber' as const;
    default:
      return 'red' as const;
  }
}

/** Pill tone for a split run's status — jade posted, amber reversed. */
function runStatusTone(status: OperationsFlows['runsPipeline']['runs'][number]['status']) {
  return status === 'posted' ? ('jade' as const) : ('amber' as const);
}

/** The empty-state card voice — the siblings' STATE_CARD treatment. */
const STATE_CARD =
  'rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5 text-sm leading-relaxed';

/** One gold-rule titled area — the console's shared block rhythm. */
function OperationsArea({
  testid,
  title,
  description,
  children,
}: {
  testid: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-10" data-testid={testid}>
      <div className="gold-rule w-64" />
      <div className="mt-8">
        <SectionEyebrow>{title}</SectionEyebrow>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-white/40">{description}</p>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

function DemoBadge() {
  return (
    <span
      data-testid="demo-data-badge"
      className="inline-flex shrink-0 items-center rounded-full border border-amber-300/40 bg-amber-300/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.25em] text-amber-300"
    >
      Demo data
    </span>
  );
}

/** The house data-table treatment, shared across the areas. */
const TABLE_CELL = 'px-4 py-3 text-right font-mono text-xs text-white/80';
const TABLE_CELL_LEFT = 'px-4 py-3 text-sm text-white';

// ───────────────────────────────────────────────────────────────────────────
// Area 1 — Escrow & Settlements
// ───────────────────────────────────────────────────────────────────────────

function EscrowSettlementsArea({ flows }: { flows: OperationsFlows }) {
  const escrow = flows.escrowSettlements;
  return (
    <OperationsArea
      testid="operations-escrow"
      title="Escrow & Settlements"
      description="The settlement rails of record — sovereign vault buckets, payout holds in flight, BaaS transfers, per-rights-holder escrow state through the withdraw-route engine, the tax-escrow ledger, dispute freezes, and the general ledger's movements by journal kind."
    >
      {/* Vault buckets per payee — available / pending / reserve + in-flight holds. */}
      <h3 className="text-sm font-medium text-white/70">Sovereign vault buckets</h3>
      {escrow.vaults.length === 0 ? (
        <div className="mt-2" data-testid="operations-vaults-empty">
          <SectionEmpty>No vaults of record yet — buckets appear when the engine opens a payee vault.</SectionEmpty>
        </div>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border border-white/10" data-testid="operations-vaults-table">
          <table className="status-table">
            <thead>
              <tr>
                <th className="px-4 py-3 text-left font-medium">Payee</th>
                <th className="px-4 py-3 text-right font-medium">Available</th>
                <th className="px-4 py-3 text-right font-medium">Pending</th>
                <th className="px-4 py-3 text-right font-medium">Reserve</th>
                <th className="px-4 py-3 text-right font-medium">In-flight holds</th>
                <th className="px-4 py-3 text-right font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {escrow.vaults.map((vault) => (
                <tr key={vault.payeeId}>
                  <td className={TABLE_CELL_LEFT} data-payee={vault.payeeId}>{vault.payeeName}</td>
                  <td className={`${TABLE_CELL} text-gold`}>{formatCentsBigint(vault.availableCents)}</td>
                  <td className={TABLE_CELL}>{formatCentsBigint(vault.pendingCents)}</td>
                  <td className={TABLE_CELL}>{formatCentsBigint(vault.reserveCents)}</td>
                  <td className={TABLE_CELL}>{formatCentsBigint(vault.inFlightHoldCents)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-white/40">{vault.updatedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Dispute freezes — the per-vault freeze of record. */}
      <h3 className="mt-8 text-sm font-medium text-white/70">Dispute freezes</h3>
      {escrow.vaults.every((vault) => vault.dispute === null) ? (
        <div className="mt-2" data-testid="operations-disputes-empty">
          <SectionEmpty>No dispute freezes of record — every vault stands unfrozen.</SectionEmpty>
        </div>
      ) : (
        <ul className="mt-2 rounded-lg border border-white/10" data-testid="operations-disputes-list">
          {escrow.vaults
            .filter((vault) => vault.dispute !== null)
            .map((vault) => (
              <li key={vault.payeeId} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <StatusPill label={vault.dispute!.locked ? 'Frozen' : 'Released'} tone={vault.dispute!.locked ? 'red' : 'jade'} />
                <span className="text-white">{vault.payeeName}</span>
                <span className="font-mono text-xs text-white/60">
                  frozen from available {formatCentsBigint(vault.dispute!.frozenFromAvailableCents)}
                  {' · '}pending {formatCentsBigint(vault.dispute!.frozenFromPendingCents)}
                </span>
                {vault.dispute!.lineItemId === null ? null : (
                  <span className="font-mono text-xs text-white/40">line item {vault.dispute!.lineItemId}</span>
                )}
              </li>
            ))}
        </ul>
      )}

      {/* BaaS transfers — the rail story of record. */}
      <h3 className="mt-8 text-sm font-medium text-white/70">BaaS transfers</h3>
      {escrow.transfers.length === 0 ? (
        <div className="mt-2" data-testid="operations-transfers-empty">
          <SectionEmpty>No BaaS transfers of record yet — rails appear when a payout moves.</SectionEmpty>
        </div>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border border-white/10" data-testid="operations-transfers-table">
          <table className="status-table">
            <thead>
              <tr>
                <th className="px-4 py-3 text-left font-medium">Transfer</th>
                <th className="px-4 py-3 text-left font-medium">Provider</th>
                <th className="px-4 py-3 text-left font-medium">Rail</th>
                <th className="px-4 py-3 text-left font-medium">Payee</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">ETA</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {escrow.transfers.map((transfer) => (
                <tr key={transfer.transferId}>
                  <td className="px-4 py-3 font-mono text-xs text-white/60">{transfer.transferId}</td>
                  <td className="px-4 py-3 text-sm text-white/80">{transfer.provider}</td>
                  <td className="px-4 py-3 font-mono text-xs text-white/60">{transfer.rail}</td>
                  <td className={TABLE_CELL_LEFT}>{transfer.payeeName}</td>
                  <td className={`${TABLE_CELL} text-gold`}>
                    {formatCentsBigint(transfer.amountCents)} {transfer.currency}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill label={transfer.status} tone={transferStatusTone(transfer.status)} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-white/40">
                    {transfer.estimatedSettlement ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-rights-holder escrow state — the stored record and the balance
          engine, side by side, never merged. */}
      <h3 className="mt-8 text-sm font-medium text-white/70">Escrow state per rights holder</h3>
      {escrow.escrowHolders.length === 0 ? (
        <div className="mt-2" data-testid="operations-escrow-holders-empty">
          <SectionEmpty>No settlements recorded yet — escrow state appears with the first disbursement.</SectionEmpty>
        </div>
      ) : (
        <div className="mt-2 grid gap-4 xl:grid-cols-2">
          <div className="overflow-x-auto rounded-lg border border-white/10" data-testid="operations-escrow-holders-stored">
            <p className="border-b border-white/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-white/40">
              Stored record — disbursements fold
            </p>
            <table className="status-table">
              <thead>
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Holder</th>
                  <th className="px-4 py-3 text-right font-medium">Gross earned</th>
                  <th className="px-4 py-3 text-right font-medium">Withheld</th>
                  <th className="px-4 py-3 text-right font-medium">Net</th>
                  <th className="px-4 py-3 text-right font-medium">Paid out</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {escrow.escrowHolders.map((holder) => {
                  const reference = holder.currencies[0] ?? 'USD';
                  return (
                    <tr key={holder.rightsHolderId}>
                      <td className={TABLE_CELL_LEFT} data-holder={holder.rightsHolderId}>{holder.name}</td>
                      <td className={TABLE_CELL}>{formatMicroUnits(holder.storedGrossUnits, reference)}</td>
                      <td className={TABLE_CELL}>{formatMicroUnits(holder.storedWithheldUnits, reference)}</td>
                      <td className={TABLE_CELL}>{formatMicroUnits(holder.storedNetUnits, reference)}</td>
                      <td className={TABLE_CELL}>{formatMicroUnits(holder.paidOutUnits, reference)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto rounded-lg border border-white/10" data-testid="operations-escrow-holders-engine">
            <p className="border-b border-white/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-white/40">
              Balance engine — escrowBalanceForHolder
            </p>
            <table className="status-table">
              <thead>
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Holder</th>
                  <th className="px-4 py-3 text-right font-medium">Gross</th>
                  <th className="px-4 py-3 text-right font-medium">Tax withheld</th>
                  <th className="px-4 py-3 text-right font-medium">Previous payout</th>
                  <th className="px-4 py-3 text-right font-medium">Available</th>
                  <th className="px-4 py-3 text-left font-medium">Tax profile</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {escrow.escrowHolders.map((holder) => {
                  const reference = holder.currencies[0] ?? 'USD';
                  return (
                    <tr key={holder.rightsHolderId}>
                      <td className={TABLE_CELL_LEFT} data-holder={holder.rightsHolderId}>{holder.name}</td>
                      <td className={TABLE_CELL}>{formatMicroUnits(holder.engineGrossUnits, reference)}</td>
                      <td className={TABLE_CELL}>{formatMicroUnits(holder.engineTaxWithheldUnits, reference)}</td>
                      <td className={TABLE_CELL}>{formatMicroUnits(holder.enginePreviousPayoutUnits, reference)}</td>
                      <td className={`${TABLE_CELL} text-gold`}>{formatMicroUnits(holder.engineAvailableUnits, reference)}</td>
                      <td className="px-4 py-3">
                        <StatusPill
                          label={holder.taxProfileSource === 'registry' ? 'registry' : 'unverified fallback'}
                          tone={holder.taxProfileSource === 'registry' ? 'jade' : 'amber'}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tax-escrow ledger — per creator × year, the Don engine's rows. */}
      <h3 className="mt-8 text-sm font-medium text-white/70">Tax-escrow ledger</h3>
      {escrow.taxEscrowRows.length === 0 ? (
        <div className="mt-2" data-testid="operations-tax-escrow-empty">
          <SectionEmpty>No tax-escrow accruals of record yet.</SectionEmpty>
        </div>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border border-white/10" data-testid="operations-tax-escrow-table">
          <table className="status-table">
            <thead>
              <tr>
                <th className="px-4 py-3 text-left font-medium">Payee</th>
                <th className="px-4 py-3 text-right font-medium">Year</th>
                <th className="px-4 py-3 text-right font-medium">Gross</th>
                <th className="px-4 py-3 text-right font-medium">Withheld</th>
                <th className="px-4 py-3 text-right font-medium">Net</th>
                <th className="px-4 py-3 text-left font-medium">TIN verified</th>
                <th className="px-4 py-3 text-left font-medium">W-9 on file</th>
                <th className="px-4 py-3 text-left font-medium">1099</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {escrow.taxEscrowRows.map((row, index) => (
                <tr key={`${row.payeeId}-${row.taxYear}-${index}`}>
                  <td className={TABLE_CELL_LEFT}>{row.payeeName ?? row.payeeId}</td>
                  <td className={TABLE_CELL}>{row.taxYear}</td>
                  <td className={TABLE_CELL}>{formatCentsBigint(row.grossCents)}</td>
                  <td className={TABLE_CELL}>{formatCentsBigint(row.withheldCents)}</td>
                  <td className={`${TABLE_CELL} text-gold`}>{formatCentsBigint(row.netCents)}</td>
                  <td className="px-4 py-3">
                    <StatusPill label={row.tinVerified ? 'Yes' : 'No'} tone={row.tinVerified ? 'jade' : 'amber'} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill label={row.w9OnFile ? 'Yes' : 'No'} tone={row.w9OnFile ? 'jade' : 'amber'} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-white/60">
                    {row.requires1099 ? (row.crossed1099Threshold ? 'threshold crossed' : 'required') : 'not required'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* GL journal-kind movements — all eight canon kinds always present. */}
      <h3 className="mt-8 text-sm font-medium text-white/70">GL journal movements</h3>
      <div className="mt-2 overflow-x-auto rounded-lg border border-white/10" data-testid="operations-journal-movements-table">
        <table className="status-table">
          <thead>
            <tr>
              <th className="px-4 py-3 text-left font-medium">Journal kind</th>
              <th className="px-4 py-3 text-right font-medium">Journals</th>
              <th className="px-4 py-3 text-right font-medium">Credits</th>
              <th className="px-4 py-3 text-right font-medium">Debits</th>
              <th className="px-4 py-3 text-right font-medium">Latest day</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {escrow.journalMovements.map((movement) => (
              <tr key={movement.kind}>
                <td className="px-4 py-3 font-mono text-xs text-white/80">{movement.kind}</td>
                <td className={TABLE_CELL}>{movement.journalCount}</td>
                <td className={TABLE_CELL}>{formatCentsBigint(movement.creditCents)}</td>
                <td className={TABLE_CELL}>{formatCentsBigint(movement.debitCents)}</td>
                <td className="px-4 py-3 font-mono text-xs text-white/40">{movement.latestDay ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </OperationsArea>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Area 2 — Runs & Pipeline Health
// ───────────────────────────────────────────────────────────────────────────

function RunsPipelineArea({ flows }: { flows: OperationsFlows }) {
  const pipeline = flows.runsPipeline;
  return (
    <OperationsArea
      testid="operations-runs"
      title="Runs & Pipeline Health"
      description="The royalty pipeline of record — the split runs the royalty-ingest journals name, statement-ingest provenance, and the match queue's health. A run whose record is gone contributes no row; nothing is invented."
    >
      <h3 className="text-sm font-medium text-white/70">Split runs</h3>
      {pipeline.runs.length === 0 ? (
        <div className="mt-2" data-testid="operations-runs-empty">
          <SectionEmpty>No split runs of record yet — runs appear when a royalty ingest journal lands.</SectionEmpty>
        </div>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border border-white/10" data-testid="operations-runs-table">
          <table className="status-table">
            <thead>
              <tr>
                <th className="px-4 py-3 text-left font-medium">Run</th>
                <th className="px-4 py-3 text-left font-medium">Source</th>
                <th className="px-4 py-3 text-left font-medium">Period</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Gross</th>
                <th className="px-4 py-3 text-right font-medium">Line items</th>
                <th className="px-4 py-3 text-right font-medium">Variance account</th>
                <th className="px-4 py-3 text-left font-medium">Reversal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {pipeline.runs.map((run) => (
                <tr key={run.runId}>
                  <td className="px-4 py-3 font-mono text-xs text-white/60">{run.runId}</td>
                  <td className="px-4 py-3 text-sm text-white/80">{run.source}</td>
                  <td className="px-4 py-3 font-mono text-xs text-white/60">{run.period ?? '—'}</td>
                  <td className="px-4 py-3">
                    <StatusPill label={run.status} tone={runStatusTone(run.status)} />
                  </td>
                  <td className={`${TABLE_CELL} text-gold`}>
                    {formatCentsBigint(run.grossCents)} {run.currency}
                  </td>
                  <td className={TABLE_CELL}>{run.lineItemCount}</td>
                  <td className={TABLE_CELL}>{formatCentsBigint(run.varianceAccountCents)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-white/40">
                    {run.reversal === null ? '—' : run.reversal.reversalId}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mt-8 text-sm font-medium text-white/70">Statement ingests</h3>
      {pipeline.ingests.length === 0 ? (
        <div className="mt-2" data-testid="operations-ingests-empty">
          <SectionEmpty>
            No statements ingested yet — provenance rows appear when a CWR, DDEX, or CSV statement file is ingested.
          </SectionEmpty>
        </div>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border border-white/10" data-testid="operations-ingests-table">
          <table className="status-table">
            <thead>
              <tr>
                <th className="px-4 py-3 text-left font-medium">File</th>
                <th className="px-4 py-3 text-left font-medium">Format</th>
                <th className="px-4 py-3 text-left font-medium">Source</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Events</th>
                <th className="px-4 py-3 text-left font-medium">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {pipeline.ingests.map((ingest) => (
                <tr key={ingest.ingestId}>
                  <td className="px-4 py-3 font-mono text-xs text-white/60">{ingest.fileName}</td>
                  <td className="px-4 py-3 font-mono text-xs text-white/80">{ingest.format}</td>
                  <td className="px-4 py-3 text-sm text-white/80">{ingest.source}</td>
                  <td className="px-4 py-3">
                    <StatusPill label={ingest.status} tone={ingest.status === 'parsed' ? 'jade' : 'red'} />
                  </td>
                  <td className={TABLE_CELL}>{ingest.eventCount ?? '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-white/40">{ingest.error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mt-8 text-sm font-medium text-white/70">Match queue health</h3>
      <div className="mt-2 flex flex-wrap gap-3" data-testid="operations-match-queue">
        <span className={`${STATE_CARD} flex-1 font-mono text-sm text-white/80`} data-testid="operations-match-queue-open">
          {pipeline.matchQueue.openCount} open
        </span>
        <span className={`${STATE_CARD} flex-1 font-mono text-sm text-white/80`} data-testid="operations-match-queue-matched">
          {pipeline.matchQueue.matchedCount} matched
        </span>
        <span className={`${STATE_CARD} flex-1 font-mono text-sm text-white/80`} data-testid="operations-match-queue-discarded">
          {pipeline.matchQueue.discardedCount} discarded
        </span>
      </div>
      {pipeline.matchQueue.openEntries.length === 0 ? (
        <div className="mt-2" data-testid="operations-match-queue-empty">
          <SectionEmpty>The quarantine is empty — no royalty events are waiting for an identifier match.</SectionEmpty>
        </div>
      ) : (
        <ul className="mt-2 rounded-lg border border-white/10" data-testid="operations-match-queue-entries">
          {pipeline.matchQueue.openEntries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <StatusPill label={entry.status} tone="amber" />
              <span className="font-mono text-xs text-white/60">{entry.eventId}</span>
              <span className="text-white/80">{entry.reason}</span>
              <span className="font-mono text-xs text-white/40">
                {entry.platform ?? '—'} · {entry.territory ?? '—'} · {entry.currency ?? '—'}
                {entry.grossMicros === null ? '' : ` · ${formatMicroUnits(entry.grossMicros, entry.currency ?? 'USD')}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </OperationsArea>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Area 3 — Verification-exception queue
// ───────────────────────────────────────────────────────────────────────────

function ExceptionQueueArea({ flows }: { flows: OperationsFlows }) {
  const queue = flows.exceptionQueue;
  return (
    <OperationsArea
      testid="operations-exceptions"
      title="Verification-exception queue"
      description="Three separate verifications, kept honestly separate — the reconciliation engine's findings, the tax engine's locks, and the match queue's quarantine. Three computations over three stores; never merged into one score."
    >
      {/* Group 1 — the reconciliation engine's own pass. */}
      <h3 className="text-sm font-medium text-white/70">Reconciliation findings</h3>
      <div className="mt-2 flex flex-wrap items-center gap-3" data-testid="operations-reconciliation">
        <StatusPill
          label={queue.reconciliation.status}
          tone={queue.reconciliation.status === 'RECONCILED' ? 'jade' : 'amber'}
        />
        <span className="font-mono text-xs text-white/60" data-testid="operations-reconciliation-counts">
          {queue.reconciliation.passCount} passed of {queue.reconciliation.totalRows} rows · {queue.reconciliation.driftCount} drift
        </span>
      </div>
      {queue.reconciliation.driftRows.length === 0 ? (
        <div className="mt-2" data-testid="operations-reconciliation-clean">
          <SectionEmpty>
            Every settlement row passed the reconciliation engine — no drift findings to queue. (Under the demo
            seed this group is empty by design: all engine-PASS USD settlements.)
          </SectionEmpty>
        </div>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border border-white/10" data-testid="operations-reconciliation-drift-table">
          <table className="status-table">
            <thead>
              <tr>
                <th className="px-4 py-3 text-left font-medium">Transaction</th>
                <th className="px-4 py-3 text-left font-medium">Currency</th>
                <th className="px-4 py-3 text-right font-medium">Expected</th>
                <th className="px-4 py-3 text-right font-medium">Distributed</th>
                <th className="px-4 py-3 text-right font-medium">Drift</th>
                <th className="px-4 py-3 text-left font-medium">Findings</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {queue.reconciliation.driftRows.map((row) => (
                <tr key={row.transactionId}>
                  <td className="px-4 py-3 font-mono text-xs text-white/60">{row.transactionId}</td>
                  <td className="px-4 py-3 font-mono text-xs text-white/80">{row.currency}</td>
                  <td className={TABLE_CELL}>{formatCentsBigint(row.expectedMinor)}</td>
                  <td className={TABLE_CELL}>{formatCentsBigint(row.distributedMinor)}</td>
                  <td className={`${TABLE_CELL} text-red-300`}>{formatCentsBigint(row.driftMinor)}</td>
                  <td className="px-4 py-3 text-xs text-white/60">{row.findings.join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Group 2 — the tax engine's locks, at the register's own payee grain. */}
      <h3 className="mt-8 text-sm font-medium text-white/70">Tax-compliance locks</h3>
      {queue.taxLocks.length === 0 ? (
        <div className="mt-2" data-testid="operations-tax-locks-empty">
          <SectionEmpty>No payouts are locked by the tax engine.</SectionEmpty>
        </div>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border border-white/10" data-testid="operations-tax-locks">
          <table className="status-table">
            <thead>
              <tr>
                <th className="px-4 py-3 text-left font-medium">Identity</th>
                <th className="px-4 py-3 text-left font-medium">Payee</th>
                <th className="px-4 py-3 text-left font-medium">Lock reason</th>
                <th className="px-4 py-3 text-right font-medium">Payouts</th>
                <th className="px-4 py-3 text-right font-medium">Gross</th>
                <th className="px-4 py-3 text-right font-medium">Withheld</th>
                <th className="px-4 py-3 text-right font-medium">State tax</th>
                <th className="px-4 py-3 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {queue.taxLocks.map((lock) => (
                <tr key={lock.identityKey}>
                  <td className="px-4 py-3 font-mono text-xs text-white/60">{lock.identityKey}</td>
                  <td className={TABLE_CELL_LEFT}>{lock.payeeName}</td>
                  <td className="px-4 py-3">
                    <StatusPill label={lock.lockReason ?? '—'} tone="red" />
                  </td>
                  <td className={TABLE_CELL}>{lock.payoutCount}</td>
                  <td className={TABLE_CELL}>{formatCentsBigint(lock.grossCents)}</td>
                  <td className={TABLE_CELL}>{formatCentsBigint(lock.withheldCents)}</td>
                  <td className={TABLE_CELL}>{formatCentsBigint(lock.stateTaxCents)}</td>
                  <td className={TABLE_CELL}>{formatCentsBigint(lock.netCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 font-mono text-xs text-white/40" data-testid="operations-nonusd-excluded">
        {queue.excludedNonUsdSettlements} settled row{queue.excludedNonUsdSettlements === 1 ? '' : 's'} outside the USD
        tax engine — disclosed, never silently dropped.
      </p>

      {/* Group 3 — the match queue's open quarantine. */}
      <h3 className="mt-8 text-sm font-medium text-white/70">Quarantined events</h3>
      {queue.quarantinedEvents.length === 0 ? (
        <div className="mt-2" data-testid="operations-quarantine-empty">
          <SectionEmpty>The quarantine is empty — no events await identifier matching.</SectionEmpty>
        </div>
      ) : (
        <ul className="mt-2 rounded-lg border border-white/10" data-testid="operations-quarantine-list">
          {queue.quarantinedEvents.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <StatusPill label={entry.status} tone="amber" />
              <span className="font-mono text-xs text-white/60">{entry.eventId}</span>
              <span className="text-white/80">{entry.reason}</span>
              <span className="font-mono text-xs text-white/40">{entry.createdAt}</span>
            </li>
          ))}
        </ul>
      )}
    </OperationsArea>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Area 4 — Payee/creator registry
// ───────────────────────────────────────────────────────────────────────────

function RegistryArea({ flows }: { flows: OperationsFlows }) {
  const registry = flows.registry;
  return (
    <OperationsArea
      testid="operations-registry"
      title="Payee & creator registry"
      description="One row per payee the money records name — the UCT identity, tax branch, and creator-profile joins shown from the join results (null means the join found nothing), with the credited money context and the per-payee audit statement link."
    >
      {registry.length === 0 ? (
        <div data-testid="operations-registry-empty">
          <SectionEmpty>No payees of record yet — the registry fills as settlements and vaults name payees.</SectionEmpty>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-white/10" data-testid="operations-registry-table">
          <table className="status-table">
            <thead>
              <tr>
                <th className="px-4 py-3 text-left font-medium">Payee</th>
                <th className="px-4 py-3 text-left font-medium">Identity key</th>
                <th className="px-4 py-3 text-left font-medium">UCT identity</th>
                <th className="px-4 py-3 text-left font-medium">Tax branch</th>
                <th className="px-4 py-3 text-right font-medium">Credited gross</th>
                <th className="px-4 py-3 text-right font-medium">Credited net</th>
                <th className="px-4 py-3 text-right font-medium">Runs</th>
                <th className="px-4 py-3 text-right font-medium">Statement</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {registry.map((row) => (
                <tr key={row.payeeId}>
                  <td className={TABLE_CELL_LEFT} data-payee={row.payeeId}>
                    {row.uctIdentity?.name ?? row.payeeId}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-white/60">{row.identityKey}</td>
                  <td className="px-4 py-3 font-mono text-xs text-white/60">
                    {row.uctIdentity === null
                      ? '—'
                      : `${row.uctIdentity.uctId}${row.uctIdentity.isni === '' ? '' : ` · ISNI ${row.uctIdentity.isni}`}${row.uctIdentity.ipi === null ? '' : ` · IPI ${row.uctIdentity.ipi}`}`}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-white/60">
                    {row.taxBranch === null ? '—' : `${row.taxBranch.countryCode} · ${row.taxBranch.tinStatus}`}
                  </td>
                  <td className={TABLE_CELL}>
                    {formatMicroUnits(row.creditedGrossUnits, row.settlementCurrencies[0] ?? 'USD')}
                  </td>
                  <td className={`${TABLE_CELL} text-gold`}>
                    {formatMicroUnits(row.creditedNetUnits, row.settlementCurrencies[0] ?? 'USD')}
                  </td>
                  <td className={TABLE_CELL}>{row.runCount}</td>
                  <td className="px-4 py-3 text-right">
                    <a
                      data-testid="operations-registry-statement-link"
                      data-payee={row.payeeId}
                      href={registryStatementHref(row.payeeId)}
                      className="font-mono text-xs text-gold-champagne underline decoration-gold-champagne/40 underline-offset-4 transition hover:decoration-gold-champagne"
                    >
                      Audit statement
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </OperationsArea>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Area 5 — Operator audit log
// ───────────────────────────────────────────────────────────────────────────

function AuditLogArea({ flows }: { flows: OperationsFlows }) {
  const audit = flows.auditLog;
  return (
    <OperationsArea
      testid="operations-audit"
      title="Operator audit log"
      description="The append-only record of operator actions — who, what, when, and the field-level before/after of every change. Attribution, never a second ledger: money truth stays in the general ledger."
    >
      {audit.rows.length === 0 ? (
        audit.persisted ? (
          <div data-testid="operations-audit-empty">
            <SectionEmpty>
              Nothing logged yet — operator actions appear here as the console records them.
            </SectionEmpty>
          </div>
        ) : (
          <div data-testid="operations-audit-unpersisted">
            <SectionEmpty>
              This store backend does not persist the audit log — local mirrors keep no admin_action_log table, so
              operator actions on this backend are not recorded here.
            </SectionEmpty>
          </div>
        )
      ) : (
        <div className="overflow-x-auto rounded-lg border border-white/10" data-testid="operations-audit-table">
          <table className="status-table">
            <thead>
              <tr>
                <th className="px-4 py-3 text-left font-medium">When</th>
                <th className="px-4 py-3 text-left font-medium">Actor</th>
                <th className="px-4 py-3 text-left font-medium">Action</th>
                <th className="px-4 py-3 text-left font-medium">Target</th>
                <th className="px-4 py-3 text-left font-medium">Changes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {audit.rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 font-mono text-xs text-white/40">{row.createdAt}</td>
                  <td className="px-4 py-3 font-mono text-xs text-white/80">{row.actor}</td>
                  <td className="px-4 py-3 font-mono text-xs text-white/80">{row.action}</td>
                  <td className="px-4 py-3 font-mono text-xs text-white/60">
                    {row.targetTable}
                    {row.targetRowId === null ? '' : ` · ${row.targetRowId}`}
                  </td>
                  <td className="px-4 py-3">
                    <ul aria-label="Field-level changes">
                      {auditChangeLines(row.changes).map((line) => (
                        <li key={line} className="font-mono text-xs text-white/70" data-testid="operations-audit-change">
                          {line}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </OperationsArea>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// The tab
// ───────────────────────────────────────────────────────────────────────────

/**
 * The Operations tab — the five back-office views over one safe payload.
 * `unavailable` is the honest store-failure state, distinct from every
 * empty list: a view that cannot be read says so; a view that reads empty
 * says that instead.
 */
export function OperationsSection({
  operations,
  demo,
}: {
  operations: SectionData<OperationsFlows>;
  demo: boolean;
}) {
  return (
    <div aria-label="Operations">
      <div className="flex items-center justify-between gap-3">
        <SectionEyebrow>Operations back office</SectionEyebrow>
        {demo ? <DemoBadge /> : null}
      </div>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/50">
        The operational layer — escrow and settlements, run and pipeline health, the verification-exception
        queue, the payee registry, and the operator audit log. Every figure is derived from the stores of
        record at render time; an empty list says so, and a store that cannot answer says that instead.
      </p>
      {operations.kind === 'unavailable' ? (
        <div className="mt-8" data-testid="operations-unavailable">
          <SectionUnavailable code={operations.code} message={operations.message} />
        </div>
      ) : (
        <div>
          <EscrowSettlementsArea flows={operations.value} />
          <RunsPipelineArea flows={operations.value} />
          <ExceptionQueueArea flows={operations.value} />
          <RegistryArea flows={operations.value} />
          <AuditLogArea flows={operations.value} />
        </div>
      )}
    </div>
  );
}
