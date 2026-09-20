/**
 * /contracts/new — THE UNIVERSAL EXECUTION LANE surface (founder GO,
 * 2026-09-20: 'I like this, there is just way more then 6 verticals. Do
 * this but anything with 6 verticals expand this is for EVERY vertical of
 * entertainment. GO').
 *
 * A THIN RENDERER over the ONE payload seam — `resolveExecutionLane` in
 * src/lib/master/executionLane.ts builds everything and this page renders
 * it: the template card with its execution badge, the asset of record
 * panel, fully-identified UCT identity blocks (ISNI/IPI never 'To be
 * completed'), reconciled 50/35/15 pool panels, agreement fields, the
 * signature table, display-only auditor-reconciled payout flows, the
 * structured guard report, and the live contract preview with its
 * 'Covnant Block: <CBT> · Display: <CVT>' lineage line.
 *
 * Fail closed: an unknown template key or CBT is a 404 (no invented
 * records). The DEMO DATA disclosure renders whenever the lane serves the
 * seeded master store. No client components — the payload is server-built,
 * display-only, and every money value flows through the engine's money
 * formatters.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { resolveExecutionLane, resolveLaneTemplate, type ExecutionLanePayload } from '@/lib/master/executionLane';
import { listDemoLaneAssets } from '@/lib/master/masterStore';
import { formatCents } from '@/lib/money/format';

export const dynamic = 'force-dynamic';

// ─────────────────────────────────────────────────────────────────────────────
// RENDER PRIMITIVES — small pure helpers, dark obsidian + gold shell style.
// ─────────────────────────────────────────────────────────────────────────────

function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'gold' | 'blocked' | 'ok' }) {
  const tones = {
    neutral: 'border-white/15 bg-white/5 text-white/70',
    gold: 'border-gold/40 bg-gold/10 text-gold',
    blocked: 'border-red-500/40 bg-red-500/10 text-red-300',
    ok: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
  } as const;
  return <span className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] tracking-wide ${tones[tone]}`}>{children}</span>;
}

function Panel({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="glass-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-wide text-white/60 uppercase">{title}</h2>
        {aside}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function FieldRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-white/5 py-2 last:border-b-0">
      <span className="text-xs tracking-wide text-white/40 uppercase">{label}</span>
      <span className="text-right text-sm text-white">{value}</span>
    </div>
  );
}

function BpsValue({ bps }: { bps: number }) {
  return (
    <span className="font-mono text-xs text-white/70">
      {bps.toLocaleString('en-US')} bps · {(bps / 100).toFixed(2)}%
    </span>
  );
}

function NavRow() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Link href="/contracts" className="text-sm text-white/50 transition hover:text-white">
        ← Contract Vault
      </Link>
      <Link href="/templates" className="text-sm text-white/50 transition hover:text-white">
        Template library →
      </Link>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PICKER — no cbt yet: choose the asset of record from the lane's demo
// registry. Every listed entry hydrates (the store's integrity gate keeps
// the registry non-empty), so the picker never renders an empty state.
// ─────────────────────────────────────────────────────────────────────────────

function AssetPicker({ templateKey, templateName }: { templateKey: string; templateName: string }) {
  const assets = listDemoLaneAssets();
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-12">
      <NavRow />
      <h1 className="mt-4 text-2xl font-semibold text-white">{templateName}</h1>
      <p className="mt-2 text-sm text-white/50">
        Choose the registered asset of record. The agreement hydrates from its stored pools, parties, and identifiers —
        no manual entry, nothing invented.
      </p>
      <ul className="mt-6 space-y-3">
        {assets.map((asset) => (
          <li key={asset.cbt}>
            <Link
              href={`/contracts/new?template=${encodeURIComponent(templateKey)}&cbt=${encodeURIComponent(asset.cbt)}`}
              className="glass-card flex items-center justify-between p-4 transition hover:border-gold/40"
            >
              <span className="text-sm text-white">{asset.title}</span>
              <span className="font-mono text-xs text-white/40">{asset.cbt}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The vertical tabs — the lane's per-sector rendering surface (founder rule:
 * EVERY vertical of entertainment). Server-rendered links over the demo
 * asset registry; the active sector's pill renders gold. Switching a tab
 * rehydrates the whole payload through the same seam — no client state.
 */
function VerticalTabs({ activeCbt, templateKey }: { activeCbt: string; templateKey: string }) {
  const assets = listDemoLaneAssets();
  return (
    <nav aria-label="Entertainment verticals" className="flex flex-wrap items-center gap-2">
      {assets.map((asset) => {
        const active = asset.cbt === activeCbt;
        return (
          <Link
            key={asset.cbt}
            href={`/contracts/new?template=${encodeURIComponent(templateKey)}&cbt=${encodeURIComponent(asset.cbt)}`}
            aria-current={active ? 'true' : undefined}
            className={`rounded-full border px-3 py-1.5 font-mono text-[11px] tracking-wide transition ${
              active
                ? 'border-gold/50 bg-gold/10 text-gold'
                : 'border-white/15 bg-white/5 text-white/60 hover:border-gold/30 hover:text-white'
            }`}
          >
            {asset.title}
          </Link>
        );
      })}
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// THE RENDERER — one section per payload block.
// ─────────────────────────────────────────────────────────────────────────────

function TemplateSection({ lane }: { lane: ExecutionLanePayload }) {
  const template = lane.template;
  return (
    <Panel
      title="Template of record"
      aside={
        <span className="flex items-center gap-2">
          <Badge tone="gold">{template.library === 'atomic' ? 'Atomic Registry' : 'Contract Factory'}</Badge>
          <Badge>{template.executionStatus}</Badge>
          <Badge>{template.timesExecuted.toLocaleString('en-US')} executions</Badge>
        </span>
      }
    >
      <p className="text-lg font-semibold text-white">{template.templateName}</p>
      <p className="mt-1 text-sm text-white/50">
        {template.domainLabel} · <span className="font-mono text-xs">{template.templateId}</span>
      </p>
      {template.aliasResolved && (
        <p className="mt-1 font-mono text-xs text-white/40">resolved from key {template.requestedKey}</p>
      )}
      <ul className="mt-4 space-y-1.5">
        {template.keyClauses.map((clause) => (
          <li key={clause} className="text-sm text-white/70">
            {clause}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function AssetSection({ lane }: { lane: ExecutionLanePayload }) {
  const asset = lane.asset;
  return (
    <Panel
      title="Asset of record"
      aside={<Badge tone="gold">bound · no manual entry, nothing invented</Badge>}
    >
      <p className="text-lg font-semibold text-white">{asset.title}</p>
      <p className="mt-1 text-sm text-white/50">
        {asset.kind} · {asset.sectorLabel}
      </p>
      <p className="mt-1 font-mono text-xs text-white/40">{asset.cbt}</p>
      <div className="mt-4">
        {asset.workIdentifiers.map((identifier) => (
          <FieldRow key={identifier.label} label={identifier.label} value={<span className="font-mono">{identifier.value}</span>} />
        ))}
      </div>
    </Panel>
  );
}

function IdentitySection({ lane }: { lane: ExecutionLanePayload }) {
  return (
    <Panel title="Parties of record" aside={<Badge>UCT identities auto-filled</Badge>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {lane.parties.map((party) => (
          <div key={party.identityKey} className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-sm font-semibold text-white">{party.name}</p>
            <p className="mt-0.5 font-mono text-xs text-gold">{party.uctId}</p>
            <div className="mt-3 space-y-1">
              <p className="text-xs text-white/50">ISNI · <span className="font-mono text-white/80">{party.isni}</span></p>
              {party.ipi !== null && (
                <p className="text-xs text-white/50">IPI · <span className="font-mono text-white/80">{party.ipi}</span></p>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-white/50">{party.role}</span>
              <BpsValue bps={party.totalShareBps} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {party.pools.map((pool) => (
                <Badge key={pool}>{pool}</Badge>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function PoolsSection({ lane }: { lane: ExecutionLanePayload }) {
  const pools = lane.pools;
  return (
    <Panel
      title="Participant pools"
      aside={
        <span className="flex items-center gap-2">
          <Badge tone="gold">50 / 35 / 15 canon</Badge>
          <Badge tone="ok">reconciled · 10,000 of 10,000 bps</Badge>
        </span>
      }
    >
      <div className="grid gap-4 lg:grid-cols-3">
        {pools.pools.map((pool) => (
          <div key={pool.pool} className="rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-white">{pool.label}</p>
              <Badge tone="gold">{Math.round(pool.weightBps / 100)}%</Badge>
            </div>
            <ul className="mt-3 space-y-2">
              {pool.parties.map((party) => (
                <li key={`${party.identityKey}:${party.pool}`} className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-xs text-white/70">{party.name}</span>
                  <BpsValue bps={party.poolShareBps} />
                </li>
              ))}
            </ul>
            <p className="mt-3 border-t border-white/10 pt-2 text-right">
              <BpsValue bps={pool.totalBps} />
            </p>
          </div>
        ))}
      </div>
      {pools.dustBps > 0 && (
        <p className="mt-3 font-mono text-xs text-white/40">
          {pools.dustBps} bps of integer rounding dust swept to the operations yield
        </p>
      )}
    </Panel>
  );
}

function AgreementSection({ lane }: { lane: ExecutionLanePayload }) {
  const agreement = lane.agreement;
  return (
    <Panel title="Agreement fields">
      <FieldRow label="Effective date" value={agreement.effectiveDate} />
      <FieldRow label="Territory" value={agreement.territory} />
      <FieldRow label="Term" value={agreement.term} />
      <FieldRow label="Governing law" value={agreement.governingLaw} />
      <FieldRow label="Fee of record" value={formatCents(agreement.feeCents)} />
      {lane.template.governingJurisdiction !== null && (
        <FieldRow label="Jurisdiction of record" value={lane.template.governingJurisdiction} />
      )}
    </Panel>
  );
}

function SignatureSection({ lane }: { lane: ExecutionLanePayload }) {
  return (
    <Panel title="Signature table">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-white/10 text-xs tracking-wide text-white/40 uppercase">
              <th className="py-2 pr-4 font-normal">Party</th>
              <th className="py-2 pr-4 font-normal">UCT ID</th>
              <th className="py-2 pr-4 font-normal">Role</th>
              <th className="py-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {lane.signatures.map((signature) => (
              <tr key={signature.uctId} className="border-b border-white/5 last:border-b-0">
                <td className="py-2.5 pr-4 text-white">{signature.name}</td>
                <td className="py-2.5 pr-4 font-mono text-xs text-white/60">{signature.uctId}</td>
                <td className="py-2.5 pr-4 text-white/60">{signature.role}</td>
                <td className="py-2.5">
                  <Badge tone={signature.status === 'EXECUTED' ? 'ok' : 'neutral'}>
                    {signature.status === 'EXECUTED' ? 'Executed' : 'Awaiting signature'}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function PayoutFlowsSection({ lane }: { lane: ExecutionLanePayload }) {
  const auditor = lane.auditor;
  return (
    <Panel title="Payout flows" aside={<Badge>display-only · auditor-reconciled</Badge>}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-white/10 text-xs tracking-wide text-white/40 uppercase">
              <th className="py-2 pr-4 font-normal">Pool</th>
              <th className="py-2 pr-4 font-normal">Party</th>
              <th className="py-2 pr-4 font-normal">Share</th>
              <th className="py-2 text-right font-normal">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lane.payoutFlows.map((flow) => (
              <tr key={`${flow.name}:${flow.pool}`} className="border-b border-white/5 last:border-b-0">
                <td className="py-2.5 pr-4 text-white/60">{flow.poolLabel}</td>
                <td className="py-2.5 pr-4 text-white">{flow.name}</td>
                <td className="py-2.5 pr-4">
                  <BpsValue bps={flow.shareBps} />
                </td>
                <td className="py-2.5 text-right font-mono text-xs text-white">{formatCents(flow.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 rounded-lg border border-white/10 bg-white/5 p-3 font-mono text-xs text-white/60">
        Embedded auditor — gross {formatCents(auditor.grossCents)} · allocated {formatCents(auditor.allocatedCents)} ·
        company dust {formatCents(auditor.companyDustCents)} ·{' '}
        {auditor.balanced ? 'balanced to the cent' : 'UNBALANCED — the lane refuses to serve this payload'}
      </p>
    </Panel>
  );
}

function GuardSection({ lane }: { lane: ExecutionLanePayload }) {
  return (
    <Panel title="Guard report" aside={<Badge tone="gold">fail closed</Badge>}>
      <ul className="space-y-2">
        {lane.guardReport.map((verdict) => (
          <li key={verdict.guardId} className="rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-xs text-white/70">{verdict.guardId}</span>
              <span className="flex items-center gap-2">
                <Badge>{verdict.kind}</Badge>
                <Badge tone={verdict.allowed ? 'ok' : 'blocked'}>{verdict.allowed ? 'ALLOWED' : 'BLOCKED'}</Badge>
              </span>
            </div>
            <p className="mt-2 font-mono text-xs text-white/50">{verdict.sectorPair}</p>
            <p className="mt-1 text-sm text-white/70">{verdict.reason}</p>
          </li>
        ))}
      </ul>
      {lane.crossDomainBlocked && (
        <p className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
          Cross-domain binding blocked — execution is not available for this pair. The allowlist is founder-owned.
        </p>
      )}
    </Panel>
  );
}

function TelemetrySection({ lane }: { lane: ExecutionLanePayload }) {
  return (
    <Panel title="Entity telemetry" aside={<Badge>{lane.telemetry.kind === 'entity' ? lane.telemetry.classTag : 'sector canon'}</Badge>}>
      {lane.telemetry.kind === 'entity' ? (
        <div>
          {lane.telemetry.fields.map((field) => (
            <FieldRow key={field.label} label={field.label} value={field.value} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-white/70">{lane.telemetry.telemetryMetric}</p>
      )}
    </Panel>
  );
}

/** The live contract preview text — assembled server-side from the payload. */
function contractPreviewText(lane: ExecutionLanePayload): string {
  const lines = [
    `Covnant Block: ${lane.lineage.cbt} · Display: ${lane.lineage.cvt}`,
    '',
    `Template of record — ${lane.template.templateName} (${lane.template.templateId}, ${lane.template.library} library)`,
    `Asset of record — ${lane.asset.title} · ${lane.asset.kind} (${lane.asset.sectorLabel})`,
    '',
    'Parties of record',
    ...lane.parties.map((party) => `  ${party.uctId} — ${party.name} · ISNI ${party.isni}${party.ipi ? ` · IPI ${party.ipi}` : ''} · ${party.role}`),
    '',
    'Pools of record (canon 50 / 35 / 15)',
    ...lane.pools.pools.map((pool) => `  ${pool.label} — ${pool.totalBps.toLocaleString('en-US')} bps`),
    ...lane.parties.map((party) => `  ${party.name} — ${party.totalShareBps.toLocaleString('en-US')} bps of 10,000`),
    '',
    `Agreement — effective ${lane.agreement.effectiveDate} · territory ${lane.agreement.territory} · term ${lane.agreement.term} · governing law ${lane.agreement.governingLaw}`,
    `Fee of record — ${formatCents(lane.agreement.feeCents)}`,
    '',
    'Signatures',
    ...lane.signatures.map((signature) => `  ${signature.name} (${signature.uctId}) — ${signature.status}`),
    '',
    `Embedded auditor — gross ${formatCents(lane.auditor.grossCents)} · allocated ${formatCents(lane.auditor.allocatedCents)} · company dust ${formatCents(lane.auditor.companyDustCents)} · balanced: ${lane.auditor.balanced ? 'yes' : 'no'}`,
    `Lineage — ${lane.lineage.derivation}`,
  ];
  if (lane.execution !== null) {
    lines.push('', `Execution stamp — ${lane.execution.executionId} · ledger ${lane.execution.ledgerId} · stamped ${lane.execution.stampedAt}`);
  }
  return lines.join('\n');
}

function ContractPreviewSection({ lane }: { lane: ExecutionLanePayload }) {
  return (
    <Panel title="Live contract preview" aside={<Badge tone="gold">Covnant Block</Badge>}>
      <pre className="overflow-x-auto rounded-xl border border-white/10 bg-black/40 p-4 font-mono text-xs leading-relaxed text-white/80 whitespace-pre-wrap">
        {contractPreviewText(lane)}
      </pre>
    </Panel>
  );
}

function DemoDisclosure() {
  return (
    <p className="rounded-lg border border-gold/30 bg-gold/5 px-4 py-2 text-xs text-gold/90">
      DEMO DATA — seeded master-store record. Identifiers, identities, pools, and amounts are demo data; no live rights
      are transacted on this surface.
    </p>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PAGE — resolve the lane, render the payload, fail closed on unknowns.
// ─────────────────────────────────────────────────────────────────────────────

export default async function NewContractPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string; cbt?: string }>;
}) {
  const { template: templateKey, cbt } = await searchParams;
  if (!templateKey) redirect('/contracts');

  // Fail-closed parity with the vault flow: an unknown template key has no
  // record to pick an asset for — back to the vault, never an invented page.
  const template = resolveLaneTemplate(templateKey);
  if (!template) redirect('/contracts');
  const templateName = template.library === 'atomic' ? template.atomicRecord.templateName : template.factoryRecord.templateName;

  if (!cbt) {
    return <AssetPicker templateKey={templateKey} templateName={templateName} />;
  }

  const resolution = resolveExecutionLane({ templateKey, cbt });
  if (!resolution.ok) notFound();
  const { lane, demo } = resolution;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 px-6 py-12">
      <NavRow />
      <VerticalTabs activeCbt={lane.asset.cbt} templateKey={templateKey} />
      <div>
        <h1 className="mt-2 text-2xl font-semibold text-white">Execution lane</h1>
        <p className="mt-1 text-sm text-white/50">
          Every vertical of entertainment — one payload, reconciled pools, fail-closed guards.
        </p>
      </div>
      {demo && <DemoDisclosure />}
      <TemplateSection lane={lane} />
      <AssetSection lane={lane} />
      <IdentitySection lane={lane} />
      <PoolsSection lane={lane} />
      <AgreementSection lane={lane} />
      <SignatureSection lane={lane} />
      <PayoutFlowsSection lane={lane} />
      <GuardSection lane={lane} />
      <TelemetrySection lane={lane} />
      <ContractPreviewSection lane={lane} />
    </div>
  );
}
