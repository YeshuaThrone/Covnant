/**
 * Overview — the console's landing tab. Cross-section counts as stat
 * cards, then the embedded audit runner (PR F gated the underlying
 * runVaultAuditAction; the button now fails closed for an unauthenticated
 * caller instead of running for anonymous visitors).
 */

import { AuditRunner } from '@/components/vault/AuditRunner';
import { allowlistsSummary } from '@/lib/admin/overview';
import { formatChangeValue } from '@/lib/admin/console';
import type { AdminConsoleData, ContractRow } from '../types';
import { SectionEyebrow } from '../shared';

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="glass-card p-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-white">{value}</p>
      {hint && <p className="mt-1 font-mono text-[11px] text-white/35">{hint}</p>}
    </div>
  );
}

/** Status fold over the read-only contract rows. */
export function contractRowCounts(rows: ContractRow[]): { total: number; DRAFT: number; FINAL: number } {
  const counts = { total: rows.length, DRAFT: 0, FINAL: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

export function OverviewSection({ data }: { data: AdminConsoleData }) {
  const contractCounts =
    data.contracts.kind === 'ready' ? contractRowCounts(data.contracts.value) : null;
  const allowlistCounts = data.allowlists.kind === 'ready' ? allowlistsSummary(data.allowlists.value) : null;
  const creatorCount = data.creators.kind === 'ready' ? data.creators.value.length : null;

  return (
    <div aria-label="Overview">
      <SectionEyebrow>Platform state</SectionEyebrow>
      <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Creators" value={creatorCount === null ? '—' : String(creatorCount)} />
        <StatCard
          label="Rights holders"
          value={String(data.registry.rightsHolderCount)}
          hint={`${data.registry.assetCount} asset${data.registry.assetCount === 1 ? '' : 's'}`}
        />
        <StatCard label="Settlements" value={String(data.ledger.totals.count)} />
        <StatCard
          label="Gross settled"
          value={data.ledger.totals.gross.toFixed(2)}
          hint={`fees ${data.ledger.totals.fees.toFixed(2)} · dust ${formatChangeValue(data.ledger.totals.cornerDust)}`}
        />
        <StatCard
          label="Contracts"
          value={contractCounts === null ? '—' : String(contractCounts.total)}
          hint={
            contractCounts === null
              ? 'contract store unavailable'
              : `${contractCounts.DRAFT} draft · ${contractCounts.FINAL} final`
          }
        />
        <StatCard
          label="Allowlists"
          value={allowlistCounts === null ? '—' : String(allowlistCounts.total)}
          hint={
            allowlistCounts === null
              ? 'unavailable'
              : `${allowlistCounts.byStatus.ACTIVE} active · ${allowlistCounts.byStatus.REVOKED} revoked`
          }
        />
      </div>

      <div className="gold-rule mt-10 w-64" />
      <div className="mt-8 max-w-2xl">
        <AuditRunner />
      </div>
    </div>
  );
}
