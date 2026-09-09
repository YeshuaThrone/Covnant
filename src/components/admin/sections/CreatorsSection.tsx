'use client';

/**
 * Creators — the creator_profiles table with compliance states, and the
 * platform's first in-product mutation: the row-level compliance editor.
 *
 * Discipline (mirrors PR F's server contract — the PATCH is validated
 * again server-side, this UI never trusts itself):
 *   - the only editable controls are enum-validated selects bounded by
 *     the enforced 0004 domains (KYC_STATUSES, TAX_FORM_TYPES) plus a
 *     true/false tax_verified;
 *   - every read-only field is VISIBLY labeled read-only, with the bank
 *     flag carrying the why (linkage flows through Increase/Plaid);
 *   - writes are confirm-before-write: the confirm step shows the exact
 *     field-level before/after the action log will record;
 *   - a successful PATCH updates the row from the response and surfaces
 *     the logged action (id + diff) — the operator always sees what was
 *     recorded;
 *   - PENDING_INITIALIZATION renders as its own honest state, never
 *     collapsed into PENDING.
 */

import { useMemo, useState } from 'react';
import {
  complianceDraftChanges,
  draftFromProfile,
  formatActionChanges,
  formatChangeValue,
  type ComplianceDraft,
} from '@/lib/admin/console';
import { KYC_STATUSES, TAX_FORM_TYPES, type AdminCreatorProfile, type KycStatus, type TaxFormType } from '@/lib/admin/types';
import type { SectionData } from '../types';
import { ReadOnlyChip, SectionEmpty, SectionEyebrow, SectionUnavailable, StatusPill, type PillTone } from '../shared';

const KYC_TONE: Record<KycStatus, PillTone> = {
  PENDING_INITIALIZATION: 'neutral',
  PENDING: 'amber',
  VERIFIED: 'jade',
  REJECTED: 'red',
};

function BooleanPill({ label, value }: { label: string; value: boolean | null }) {
  if (value === null) return <span className="font-mono text-xs text-white/35">—</span>;
  return <StatusPill label={`${label}: ${value ? 'true' : 'false'}`} tone={value ? 'jade' : 'neutral'} />;
}

interface LoggedAction {
  action: string;
  id: string;
  lines: string[];
}

/**
 * The confirm diff is the action log's own changes shape — the operator
 * confirms exactly what the log will record.
 */
function confirmDiff(profile: AdminCreatorProfile, patch: ReturnType<typeof complianceDraftChanges>) {
  const shaped: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, to] of Object.entries(patch)) {
    shaped[field] = {
      from: profile[field as keyof AdminCreatorProfile],
      to,
    };
  }
  return formatActionChanges(shaped);
}

const SELECT_CLASS =
  'mt-1 w-full rounded-lg border border-gold/25 bg-obsidian-950/60 px-3 py-2 text-sm text-white outline-none transition focus:border-gold/60';

function EditableSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/50">
        {label}
      </label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className={SELECT_CLASS}>
        {value === '' && (
          <option value="" disabled>
            — unset —
          </option>
        )}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/50">
        {label}
        <ReadOnlyChip />
      </p>
      <p className="mt-1 text-sm text-white/80">{value}</p>
    </div>
  );
}

function CreatorEditor({
  profile,
  onClose,
  onSaved,
}: {
  profile: AdminCreatorProfile;
  onClose: () => void;
  onSaved: (profile: AdminCreatorProfile) => void;
}) {
  const [draft, setDraft] = useState<ComplianceDraft>(() => draftFromProfile(profile));
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [logged, setLogged] = useState<LoggedAction | null>(null);

  // Bounded selects only emit domain values (or null = unset), so this
  // diff never throws in practice — it throws loudly if that invariant
  // is ever broken rather than silently hiding a write.
  const patch = useMemo(() => complianceDraftChanges(profile, draft), [profile, draft]);
  const diffLines = useMemo(() => confirmDiff(profile, patch), [profile, patch]);
  const hasChanges = Object.keys(patch).length > 0;

  const save = async () => {
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch(`/api/admin/creators/${profile.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
        cache: 'no-store',
      });
      const body = (await response.json().catch(() => null)) as
        | {
            ok: boolean;
            profile?: AdminCreatorProfile;
            action?: { id: string; action: string; changes: Record<string, { from: unknown; to: unknown }> } | null;
            error?: string;
          }
        | null;
      if (response.ok && body?.ok && body.profile) {
        onSaved(body.profile);
        setLogged(
          body.action
            ? { action: body.action.action, id: body.action.id, lines: formatActionChanges(body.action.changes) }
            : null,
        );
        setConfirming(false);
      } else {
        // The route's sanitized message is safe to surface (jsonError contract).
        setFailure(body?.error ?? 'The compliance update could not be applied. Try again.');
        setConfirming(false);
      }
    } catch {
      setFailure('The compliance update could not be applied. Try again.');
      setConfirming(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="glass-card mt-4 p-6" role="region" aria-label={`Compliance editor — ${profile.stage_name}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold-champagne">Compliance editor</p>
          <p className="mt-1 text-sm text-white/70">
            {profile.stage_name} · <span className="font-mono text-xs text-white/40">{profile.id}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close editor"
          className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/60 transition hover:text-white"
        >
          Close
        </button>
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-2">
        <EditableSelect
          id={`kyc-status-${profile.id}`}
          label="KYC status — admin-editable"
          value={draft.kyc_status ?? ''}
          options={KYC_STATUSES}
          onChange={(value) => setDraft((current) => ({ ...current, kyc_status: (value === '' ? null : value) as KycStatus | null }))}
        />
        <EditableSelect
          id={`tax-form-${profile.id}`}
          label="Tax form type — admin-editable"
          value={draft.tax_form_type ?? ''}
          options={TAX_FORM_TYPES}
          onChange={(value) => setDraft((current) => ({ ...current, tax_form_type: (value === '' ? null : value) as TaxFormType | null }))}
        />
        <EditableSelect
          id={`tax-verified-${profile.id}`}
          label="Tax verified — admin-editable"
          value={draft.tax_verified === null ? '' : draft.tax_verified ? 'true' : 'false'}
          options={['true', 'false']}
          onChange={(value) =>
            setDraft((current) => ({ ...current, tax_verified: value === '' ? null : value === 'true' }))
          }
        />
      </div>

      <h4 className="mt-6 font-mono text-[11px] uppercase tracking-[0.2em] text-white/50">
        Read-only record
      </h4>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <ReadOnlyField label="Email" value={profile.email} />
        <ReadOnlyField label="Stage name" value={profile.stage_name} />
        <ReadOnlyField label="Legal name" value={profile.legal_name} />
        <ReadOnlyField label="Phone" value={profile.phone ?? '—'} />
        <ReadOnlyField label="Core industry" value={profile.core_industry} />
        <ReadOnlyField label="Title" value={profile.title ?? '—'} />
        <ReadOnlyField
          label="Bank account linked"
          value={
            <span className="inline-flex items-center gap-2">
              {formatChangeValue(profile.bank_account_linked)}
              <span className="text-xs text-white/40">linkage flows through Increase/Plaid</span>
            </span>
          }
        />
        <ReadOnlyField label="UDR terms accepted" value={profile.udr_terms_accepted_at} />
        <ReadOnlyField label="Registered" value={profile.created_at} />
      </div>

      {/* The confirm diff — exactly what the action log will record. */}
      {hasChanges && !logged && (
        <div className="mt-6 rounded-lg border border-gold/30 bg-gold/[0.06] p-4" aria-label="Pending changes">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-gold-champagne">
            This write will record
          </p>
          <ul className="mt-2 space-y-1 font-mono text-xs text-white/80">
            {diffLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {logged && (
        <div className="mt-6 rounded-lg border border-emerald-400/40 bg-emerald-400/[0.07] p-4" role="status" aria-label="Logged action">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-emerald-300">
            Logged: {logged.action}
          </p>
          <ul className="mt-2 space-y-1 font-mono text-xs text-white/80">
            {logged.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="mt-2 font-mono text-[11px] text-white/35">action {logged.id}</p>
        </div>
      )}

      {failure && (
        <p role="alert" className="mt-4 rounded-lg border border-red-400/40 bg-red-400/10 p-3 text-sm text-red-300">
          {failure}
        </p>
      )}

      {!logged && (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={!hasChanges || pending}
              className="rounded-lg border border-gold/40 px-4 py-2 text-sm text-gold transition-colors hover:bg-gold/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save changes
            </button>
          ) : (
            <>
              <span className="text-sm text-white/60">Confirm write — one action-log entry will be recorded.</span>
              <button
                type="button"
                onClick={save}
                disabled={pending}
                className="rounded-lg border border-gold/60 bg-gold/10 px-4 py-2 text-sm text-gold-champagne transition-colors hover:bg-gold/20 disabled:cursor-wait disabled:opacity-50"
              >
                {pending ? 'Writing…' : 'Confirm write'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={pending}
                className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/60 transition hover:text-white"
              >
                Cancel
              </button>
            </>
          )}
          {!hasChanges && !confirming && <span className="text-sm text-white/40">No changes to write.</span>}
        </div>
      )}

      {logged && (
        <div className="mt-6">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gold/40 px-4 py-2 text-sm text-gold transition-colors hover:bg-gold/10"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}

export function CreatorsSection({
  creators,
  onProfileUpdated,
}: {
  creators: SectionData<AdminCreatorProfile[]>;
  onProfileUpdated: (profile: AdminCreatorProfile) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);

  if (creators.kind === 'unavailable') {
    return (
      <div aria-label="Creators">
        <SectionEyebrow>Creator profiles</SectionEyebrow>
        <div className="mt-4">
          <SectionUnavailable code={creators.code} message={creators.message} />
        </div>
      </div>
    );
  }

  const profiles = creators.value;
  const editing = profiles.find((profile) => profile.id === editingId) ?? null;

  return (
    <div aria-label="Creators">
      <SectionEyebrow>Creator profiles</SectionEyebrow>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        Every creator profile with its compliance state. Compliance fields are
        admin-editable with a logged, confirmed write; everything else is
        read-only.
      </p>

      {profiles.length === 0 ? (
        <div className="mt-6">
          <SectionEmpty>
            No creators registered yet — profiles appear after the first creator
            signs up.
          </SectionEmpty>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-white/10">
          <table className="status-table">
            <thead>
              <tr>
                <th className="px-4 py-3 font-medium">Creator</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">KYC status</th>
                <th className="px-4 py-3 font-medium">Tax form</th>
                <th className="px-4 py-3 font-medium">Tax verified</th>
                <th className="px-4 py-3 font-medium">Bank linked</th>
                <th className="px-4 py-3 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {profiles.map((profile) => (
                <tr key={profile.id}>
                  <td className="px-4 py-3 text-white">
                    {profile.stage_name}
                    <span className="block text-xs text-white/40">{profile.legal_name}</span>
                  </td>
                  <td className="px-4 py-3 text-white/60">{profile.email}</td>
                  <td className="px-4 py-3">
                    {profile.kyc_status === null ? (
                      <span className="font-mono text-xs text-white/35">—</span>
                    ) : (
                      <StatusPill label={profile.kyc_status} tone={KYC_TONE[profile.kyc_status]} />
                    )}
                  </td>
                  <td className="px-4 py-3 text-white/60">{profile.tax_form_type ?? '—'}</td>
                  <td className="px-4 py-3">
                    <BooleanPill label="verified" value={profile.tax_verified} />
                  </td>
                  <td className="px-4 py-3">
                    <BooleanPill label="linked" value={profile.bank_account_linked} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setEditingId(editingId === profile.id ? null : profile.id)}
                      aria-expanded={editingId === profile.id}
                      className="rounded-lg border border-gold/40 px-3 py-1.5 text-sm text-gold transition-colors hover:bg-gold/10"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <CreatorEditor
          key={editing.id}
          profile={editing}
          onClose={() => setEditingId(null)}
          onSaved={onProfileUpdated}
        />
      )}
    </div>
  );
}
