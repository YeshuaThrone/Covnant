'use client';

import { useState, useTransition } from 'react';
import { runVaultAuditAction } from '@/lib/contracts/actions';
import type { SystemAuditReport } from '@/engine/covenant-master-sdk';

const STATUS_STYLES: Record<SystemAuditReport['status'], string> = {
  HEALTHY: 'border-emerald-400/40 text-emerald-300',
  ACTION_REQUIRED: 'border-amber-400/40 text-amber-300',
  AUDIT_FAILED: 'border-red-400/40 text-red-300',
};

export function AuditRunner() {
  const [report, setReport] = useState<SystemAuditReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () => {
    setError(null);
    startTransition(async () => {
      const result = await runVaultAuditAction();
      if (result.success) {
        setReport(result.report);
      } else {
        setError(result.error);
      }
    });
  };

  const bySeverity = (severity: string) =>
    (report?.anomaliesDetected ?? []).filter((a) => a.severity === severity);

  return (
    <section className="glass-card p-6" aria-label="Smart Ledger Verification">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">
        Smart Ledger Verification
      </p>
      <p className="mt-2 text-sm text-white/50">
        Runs the embedded auditor across every registered asset: split sums, ledger
        fee-overrun scan, and anomaly detection.
      </p>
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="mt-4 rounded-lg border border-gold/40 px-4 py-2 text-sm text-gold hover:bg-gold/10 disabled:opacity-50"
      >
        {pending ? 'Auditing…' : 'Run system audit'}
      </button>

      {error && (
        <p className="mt-4 rounded-lg border border-red-400/40 bg-red-400/10 p-3 text-sm text-red-300">
          {error}
        </p>
      )}

      {report && (
        <div className="mt-6 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded-full border px-3 py-1 font-mono text-xs ${STATUS_STYLES[report.status]}`}>
              {report.status}
            </span>
            <span className="text-xs text-white/50">
              {report.totalAssetsChecked} assets checked · {report.totalTransactionsAudited}{' '}
              transactions audited
            </span>
          </div>

          {report.anomaliesDetected.length === 0 ? (
            <p className="text-sm text-white/50">No anomalies detected.</p>
          ) : (
            <ul className="space-y-3">
              {(['CRITICAL', 'WARNING', 'INFO'] as const).map((severity) =>
                bySeverity(severity).map((anomaly, i) => (
                  <li
                    key={`${severity}-${i}`}
                    className="rounded-lg border border-white/10 bg-white/5 p-3"
                  >
                    <p className="font-mono text-xs text-white/70">
                      {severity} · {anomaly.code}
                    </p>
                    <p className="mt-1 text-sm text-white/70">{anomaly.message}</p>
                    <p className="mt-1 text-xs text-white/40">{anomaly.affectedTarget}</p>
                  </li>
                )),
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
