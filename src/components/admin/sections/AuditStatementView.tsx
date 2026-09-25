/**
 * The Export Audit Package's statement view (spec art_qNu4T32F, module 4) —
 * the per-payee, window-aware print-ready statement. Purely presentational:
 * every figure, label, identifier, and disclosure arrives in the
 * `AuditStatementFlows` payload or the page's props; nothing here computes,
 * fetches, or invents. The dark-gold screen styling yields to the print
 * stylesheet (globals.css `@media print` keyed on `data-print-statement`) —
 * the browser's print dialog IS the PDF path; there is no PDF dependency.
 *
 * Honesty law on this page: absent facts render dashes; a payee the store
 * never names renders the payeeId; a work without an industry identifier
 * renders its code of record labeled `Code of Record (CVT)`; and a
 * divergence between the itemized total and the leaderboard-basis window
 * credits is DISCLOSED in plain text — never smoothed over.
 */

import type { AuditStatementFlows, StatementWorkIdentifier } from '@/lib/admin/auditStatement';
import { formatCentsBigint } from '@/lib/money/format';
import { PrintButton } from './PrintButton';

/** The statement's window voices — keyed on the payload's own `windowDays` value. */
function windowLabel(windowDays: AuditStatementFlows['windowDays']): string {
  switch (windowDays) {
    case 7:
      return 'Last 7 days';
    case 30:
      return 'Last 30 days';
    case 90:
      return 'Last 90 days';
    case null:
      return 'All time';
    default:
      return 'Unknown window';
  }
}

/** One identifier of record — the industry scheme, or the labeled code-of-record fallback. */
function IdentifierCell({ identifiers }: { identifiers: readonly StatementWorkIdentifier[] }) {
  return (
    <span className="flex flex-col gap-0.5">
      {identifiers.map((identifier) => (
        <span
          key={`${identifier.scheme}-${identifier.code}`}
          data-testid="audit-statement-identifier"
          data-scheme={identifier.scheme}
          data-code-of-record={identifier.codeOfRecord ? 'true' : 'false'}
          className="font-mono text-xs text-slate-200"
        >
          <span className="text-white/40">{identifier.scheme}</span> {identifier.code}
          {identifier.codeOfRecord ? (
            <span className="ml-2 text-gold-champagne/80">Code of Record (CVT)</span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/** An identity field — the fact of record, or the honest dash. */
function IdentityField({ label, value, testid }: { label: string; value: string; testid: string }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">{label}</p>
      <p data-testid={testid} className="mt-1 font-mono text-sm text-slate-100">
        {value}
      </p>
    </div>
  );
}

/**
 * The audit statement — one payee, one window, print-ready. The print
 * path is the PDF path: the button opens the browser's own dialog, and
 * the print stylesheet isolates this block.
 */
export function AuditStatementView({
  flows,
  demo,
  generatedAt,
}: {
  flows: AuditStatementFlows;
  demo: boolean;
  generatedAt: string;
}) {
  const label = flows.label ?? flows.payeeId; // the store-carried name, else the payee id — never invented
  const totalsReconcile = flows.itemizedTotalCents === flows.creditedCents;
  return (
    <div data-print-statement aria-label="Audit statement" className="mx-auto max-w-4xl px-6 py-10">
      {/* Header of record — the statement's identity and provenance. */}
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">
          Covnant · Operator Console · Audit Statement
        </p>
        {demo ? (
          <p
            data-testid="audit-statement-demo-badge"
            className="rounded-full border border-gold-champagne/40 bg-gold-champagne/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne"
          >
            Demo data
          </p>
        ) : null}
      </div>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-50">Settlement audit statement</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/50">
        The itemized record of one payee&apos;s cleared settlements for the stated window — every figure below derives
        from the GL journals, split runs, line items, and ledger transactions through the real store paths. A dash
        means the record of truth carries no value for that field; nothing on this statement is inferred.
      </p>

      <div className="mt-6 grid grid-cols-2 gap-4 rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5 md:grid-cols-3">
        <IdentityField label="Payee of record" value={label} testid="audit-statement-payee" />
        <IdentityField label="Payee ID" value={flows.payeeId} testid="audit-statement-payee-id" />
        <IdentityField
          label="Window"
          value={windowLabel(flows.windowDays)}
          testid="audit-statement-window"
        />
        <IdentityField label="UCT number" value={flows.uctNumber ?? '—'} testid="audit-statement-uct" />
        <IdentityField label="ISNI" value={flows.isni ?? '—'} testid="audit-statement-isni" />
        <IdentityField label="Generated" value={generatedAt} testid="audit-statement-generated" />
      </div>

      {/* Works & identifiers — the per-work mapping, every entertainment form. */}
      <div className="mt-8" data-testid="audit-statement-works">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">
          Works &amp; identifiers
        </h2>
        {flows.works.length === 0 ? (
          <p data-testid="audit-statement-works-empty" className="mt-3 font-mono text-sm text-white/40">
            No works in this window — the itemized lines below carry no work identity.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
            <table className="w-full min-w-[560px] border-collapse text-left" aria-label="Works and identifiers">
              <thead>
                <tr className="border-b border-slate-600/50">
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Work ref</th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Title of record</th>
                  <th scope="col" className="py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Identifier of record</th>
                </tr>
              </thead>
              <tbody>
                {flows.works.map((work) => (
                  <tr key={work.workRef} data-testid="audit-statement-work-row" className="border-b border-slate-600/30">
                    <td className="py-2 pr-3 font-mono text-xs text-slate-200">{work.workRef}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-slate-200">{work.title ?? '—'}</td>
                    <td className="py-2">
                      <IdentifierCell identifiers={work.identifiers} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Itemized lines — the same real game-log rows the tab renders, plus the work identity. */}
      <div className="mt-8" data-testid="audit-statement-lines">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">
          Itemized settlements
        </h2>
        {flows.lines.length === 0 ? (
          <p data-testid="audit-statement-lines-empty" className="mt-3 font-mono text-sm text-white/40">
            No itemized settlements in this window — an honest zero statement, not an empty page.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5">
            <table className="w-full min-w-[640px] border-collapse text-left" aria-label="Itemized settlements">
              <thead>
                <tr className="border-b border-slate-600/50">
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Day</th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Entity</th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Work</th>
                  <th scope="col" className="py-2 pr-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Source</th>
                  <th scope="col" className="py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Creator paid</th>
                </tr>
              </thead>
              <tbody>
                {flows.lines.map((line, index) => (
                  <tr
                    key={`${line.day}-${line.workRef ?? 'none'}-${index}`}
                    data-testid="audit-statement-line-row"
                    className="border-b border-slate-600/30"
                  >
                    <td className="py-2 pr-3 font-mono text-xs text-slate-200">{line.day}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-slate-200">{line.entityId ?? '—'}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-slate-200">
                      {line.workTitle ?? line.workRef ?? '—'}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-slate-200">{line.source ?? '—'}</td>
                    <td className="py-2 font-mono text-xs text-gold-champagne">{formatCentsBigint(line.creatorCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Totals of record — the itemized sum beside the leaderboard basis, divergence disclosed. */}
      <div className="mt-8 rounded-2xl border border-gold-champagne/30 bg-gold-champagne/[0.06] p-5" data-testid="audit-statement-totals">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne/80">Itemized total</p>
          <p data-testid="audit-statement-total" className="font-mono text-xl text-gold-champagne">
            {formatCentsBigint(flows.itemizedTotalCents)}
          </p>
        </div>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">Credited in window (leaderboard basis)</p>
          <p data-testid="audit-statement-credited" className="font-mono text-sm text-slate-100">
            {formatCentsBigint(flows.creditedCents)}
          </p>
        </div>
        {totalsReconcile ? null : (
          <p data-testid="audit-statement-variance" className="mt-3 font-mono text-xs text-white/50">
            The itemized total and the leaderboard-basis credits do not reconcile — attribution the two measures
            disagree on is disclosed here, not smoothed over.
          </p>
        )}
      </div>

      <p className="mt-6 font-mono text-[11px] text-white/40" data-testid="audit-statement-disclosure">
        {demo
          ? 'Demo-data disclosure: this statement renders the seeded demonstration ledger behind the disclosed demo door — it is not production settlement data.'
          : 'Generated from the cleared settlement ledger of record. Figures are exact integer cents at generation time.'}{' '}
        Generated {generatedAt}.
      </p>

      {/* The print control — the PDF path itself. Hidden from the printout. */}
      <div className="mt-6" data-no-print>
        <PrintButton />
      </div>
    </div>
  );
}
