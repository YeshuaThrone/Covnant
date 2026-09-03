'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { markContractFinalAction, saveContractAction } from '@/lib/contracts/actions';
import { VerificationBadge } from '@/components/brand/VerificationBadge';
import { renderClauses } from '@/lib/contracts/generator';
import { getTemplate } from '@/lib/contracts/templates';
import type { AgreementContext } from '@/lib/contracts/generator';

const FIELD_ITEMS = [
  { key: 'effectiveDate', label: 'Effective Date', placeholder: 'e.g. January 15, 2026' },
  { key: 'territory', label: 'Territory', placeholder: 'Worldwide' },
  { key: 'term', label: 'Term', placeholder: 'Twelve (12) months from the Effective Date' },
  { key: 'fee', label: 'Fee / Consideration', placeholder: 'As separately agreed in writing' },
  { key: 'governingLaw', label: 'Governing Law', placeholder: 'the State of Delaware, United States' },
] as const;

type FieldKey = (typeof FIELD_ITEMS)[number]['key'];

export interface ContractEditorProps {
  templateId: string;
  industry: 'MUSIC' | 'FILM_MEDIA_MERCH';
  cbtCode: string;
  assetTitle: string;
  initialContext: AgreementContext;
  contractId?: string;
  initialStatus?: 'DRAFT' | 'FINAL';
}

export function ContractEditor({
  templateId,
  industry,
  cbtCode,
  assetTitle,
  initialContext,
  contractId,
  initialStatus = 'DRAFT',
}: ContractEditorProps) {
  const router = useRouter();
  const template = getTemplate(templateId)!;
  const [fields, setFields] = useState(initialContext.fields);
  const [status, setStatus] = useState<'DRAFT' | 'FINAL'>(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

  const isFinal = status === 'FINAL';

  // The preview re-renders deterministically from the same pure renderer the
  // server persists with — the preview and the stored document can never drift.
  const document = useMemo(
    () => renderClauses(template, { ...initialContext, fields }),
    [template, initialContext, fields],
  );

  const setField = (key: FieldKey, value: string) =>
    setFields((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setError(null);
    setSaving(true);
    const result = await saveContractAction({ cbtCode, templateId, industry, context: { ...initialContext, fields }, id: contractId });
    setSaving(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setSaved(true);
    if (result.id !== contractId) router.push(`/contracts/${result.id}`);
    else router.refresh();
  };

  const finalize = async () => {
    if (!contractId) return;
    setError(null);
    setFinalizing(true);
    const result = await markContractFinalAction(contractId);
    setFinalizing(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setStatus('FINAL');
    router.refresh();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
      <div className="space-y-6">
        <section className="glass-card p-6">
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">
            {template.industry === 'MUSIC' ? 'Music' : 'Film, Media & Merch'} · Template
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-white">{template.name}</h1>
          <p className="mt-1 text-sm text-white/50">
            Asset: {assetTitle} · <span className="font-mono">{cbtCode}</span>
          </p>
          <p className="mt-2 text-sm text-white/50">{template.summary}</p>
          <p className="mt-4 font-mono text-xs text-white/40">
            Clauses: {template.clauseOrder.length} · Pools hydrated from the asset of record
          </p>
        </section>

        <section className="glass-card p-6" aria-label="Agreement fields">
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">
            Agreement fields
          </p>
          <div className="mt-4 space-y-4">
            {FIELD_ITEMS.map((item) => (
              <label key={item.key} className="block">
                <span className="mb-1 block text-sm text-white/70">{item.label}</span>
                <input
                  value={fields[item.key]}
                  onChange={(e) => setField(item.key, e.target.value)}
                  placeholder={item.placeholder}
                  disabled={isFinal}
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-gold/60 focus:outline-none disabled:opacity-50"
                />
              </label>
            ))}
          </div>
        </section>

        {!isFinal && (
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-lg border border-gold/40 bg-gold/10 px-4 py-2 text-sm text-gold hover:bg-gold/20 disabled:opacity-50"
            >
              {saving ? 'Saving…' : saved ? 'Save again' : 'Save draft'}
            </button>
            {contractId && (
              <button
                type="button"
                onClick={finalize}
                disabled={finalizing}
                className="rounded-lg border border-gold/50 bg-gold/10 px-4 py-2 text-sm text-gold hover:bg-gold/20 disabled:opacity-50"
              >
                {finalizing ? 'Finalizing…' : 'Mark final'}
              </button>
            )}
          </div>
        )}

        {isFinal && contractId && (
          <div className="flex flex-wrap items-center gap-3">
            <VerificationBadge variant="immutable-ledger-active" label="FINAL — immutable" />
            <a
              href={`/contracts/${contractId}/export`}
              className="rounded-lg border border-gold/40 px-4 py-2 text-sm text-gold hover:bg-gold/10"
            >
              Export agreement (.txt)
            </a>
          </div>
        )}

        {error && (
          <p className="rounded-lg border border-red-400/40 bg-red-400/10 p-3 text-sm text-red-300">
            {error}
          </p>
        )}
      </div>

      <section className="glass-card p-6" aria-label="Agreement preview">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">
          Live preview
        </p>
        <pre className="mt-4 max-h-[70vh] overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-white/70">
          {document}
        </pre>
      </section>
    </div>
  );
}
