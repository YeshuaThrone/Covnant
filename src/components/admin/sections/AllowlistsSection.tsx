'use client';

/**
 * Allowlists — the platform_allowlists table (domain data: social channels
 * cleared per CBT code) with the ACTIVE ↔ REVOKED flip. The flip is a real
 * mutation on PR F's POST /api/admin/allowlists/[id] route: confirm before
 * write, exactly one action-log entry per flip, the logged action (id +
 * before/after) surfaces in the response banner. Creation is deferred —
 * v1 flips only, so there is deliberately no create control here.
 */

import { useState } from 'react';
import { formatActionChanges, formatChangeValue } from '@/lib/admin/console';
import type { AdminAllowlistRow } from '@/lib/admin/allowlists';
import type { SectionData } from '../types';
import { SectionEmpty, SectionEyebrow, SectionUnavailable, StatusPill, type PillTone } from '../shared';

const STATUS_TONE: Record<AdminAllowlistRow['status'], PillTone> = {
  ACTIVE: 'jade',
  REVOKED: 'red',
};

export function AllowlistsSection({
  allowlists,
  onAllowlistUpdated,
}: {
  allowlists: SectionData<AdminAllowlistRow[]>;
  onAllowlistUpdated: (row: AdminAllowlistRow) => void;
}) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [logged, setLogged] = useState<{ id: string; label: string; lines: string[] } | null>(null);

  const flip = async (row: AdminAllowlistRow) => {
    setPendingId(row.id);
    setFailure(null);
    try {
      const response = await fetch(`/api/admin/allowlists/${row.id}`, { method: 'POST', cache: 'no-store' });
      const body = (await response.json().catch(() => null)) as
        | {
            ok: boolean;
            allowlist?: AdminAllowlistRow;
            action?: { id: string; action: string; changes: Record<string, { from: unknown; to: unknown }> };
            error?: string;
          }
        | null;
      if (response.ok && body?.ok && body.allowlist) {
        onAllowlistUpdated(body.allowlist);
        setLogged(
          body.action
            ? {
                id: body.action.id,
                label: `${body.action.action} — ${body.allowlist.platform} ${formatChangeValue(body.action.changes.status?.from)} → ${formatChangeValue(body.action.changes.status?.to)}`,
                lines: formatActionChanges(body.action.changes),
              }
            : { id: '', label: 'Flip recorded.', lines: [] },
        );
        setConfirmingId(null);
      } else {
        setFailure(body?.error ?? 'The status flip could not be applied. Try again.');
        setConfirmingId(null);
      }
    } catch {
      setFailure('The status flip could not be applied. Try again.');
      setConfirmingId(null);
    } finally {
      setPendingId(null);
    }
  };

  if (allowlists.kind === 'unavailable') {
    return (
      <div aria-label="Allowlists">
        <SectionEyebrow>Platform allowlists</SectionEyebrow>
        <div className="mt-4">
          <SectionUnavailable code={allowlists.code} message={allowlists.message} />
        </div>
      </div>
    );
  }

  const rows = allowlists.value;

  return (
    <div aria-label="Allowlists">
      <SectionEyebrow>Platform allowlists</SectionEyebrow>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        Cleared platform channels per CBT code — this table is the domain
        data&apos;s first human interface. Flipping ACTIVE ↔ REVOKED is a
        logged, confirmed write; creation of new entries is deferred.
      </p>

      {rows.length === 0 ? (
        <div className="mt-6">
          <SectionEmpty>
            No allowlist rows yet — entries appear once platforms are cleared
            per CBT code.
          </SectionEmpty>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-white/10">
          <table className="status-table">
            <thead>
              <tr>
                <th className="px-4 py-3 font-medium">Platform</th>
                <th className="px-4 py-3 font-medium">Channel</th>
                <th className="px-4 py-3 font-medium">CBT code</th>
                <th className="px-4 py-3 font-medium">Creator share</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {rows.map((row) => {
                const next = row.status === 'ACTIVE' ? 'REVOKED' : 'ACTIVE';
                return (
                  <tr key={row.id}>
                    <td className="px-4 py-3 text-white">{row.platform}</td>
                    <td className="px-4 py-3 font-mono text-xs text-white/60">{row.target_account_id}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gold-champagne/90">{row.cbt_code}</td>
                    <td className="px-4 py-3 text-white/60">{row.creator_incentive_share_pct}%</td>
                    <td className="px-4 py-3">
                      <StatusPill label={row.status} tone={STATUS_TONE[row.status]} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      {confirmingId === row.id ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="text-xs text-white/60">Flip to {next}?</span>
                          <button
                            type="button"
                            onClick={() => flip(row)}
                            disabled={pendingId === row.id}
                            className="rounded-lg border border-gold/60 bg-gold/10 px-3 py-1.5 text-sm text-gold-champagne transition-colors hover:bg-gold/20 disabled:cursor-wait disabled:opacity-50"
                          >
                            {pendingId === row.id ? 'Writing…' : 'Confirm flip'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmingId(null)}
                            disabled={pendingId === row.id}
                            className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/60 transition hover:text-white"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setFailure(null);
                            setLogged(null);
                            setConfirmingId(row.id);
                          }}
                          className="rounded-lg border border-gold/40 px-3 py-1.5 text-sm text-gold transition-colors hover:bg-gold/10"
                        >
                          {row.status === 'ACTIVE' ? 'Revoke' : 'Reactivate'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {logged && (
        <div className="mt-6 rounded-lg border border-emerald-400/40 bg-emerald-400/[0.07] p-4" role="status" aria-label="Logged action">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-emerald-300">
            Logged: {logged.label}
          </p>
          <ul className="mt-2 space-y-1 font-mono text-xs text-white/80">
            {logged.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {logged.id && <p className="mt-2 font-mono text-[11px] text-white/35">action {logged.id}</p>}
        </div>
      )}

      {failure && (
        <p role="alert" className="mt-4 rounded-lg border border-red-400/40 bg-red-400/10 p-3 text-sm text-red-300">
          {failure}
        </p>
      )}
    </div>
  );
}
