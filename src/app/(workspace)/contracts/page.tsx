import Link from 'next/link';
import {
  CATEGORY_LABELS,
  TEMPLATES,
  templatesByVertical,
} from '@/lib/contracts/templates';
import { listContracts } from '@/lib/contracts/store';
import { presentationStatus, STATUS_CHIP_CLASSES } from '@/lib/contracts/presentation';
import { masterCategoryFromParam } from '@/lib/master/taxonomy';
import { resolveMasterLedger } from '@/lib/master/masterStore';
import { summarizeSovereignLedger } from '@/lib/master/sovereignLedger';
import { HeaderActions } from '@/components/workspace/HeaderActions';
import {
  MasterCategoryTabs,
  MasterStatCards,
  SovereignLedgerTable,
} from '@/components/master/MasterData';
import { AuditRunner } from '@/components/vault/AuditRunner';

export const dynamic = 'force-dynamic';

export default async function ContractsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const { category } = await searchParams;
  const active = masterCategoryFromParam(category);

  // The master data seam — demo library in preview (under the DEMO DATA
  // badge), real settled rows otherwise. Every dollar is engine-computed.
  const { demo, records } = await resolveMasterLedger();
  const scoped = active
    ? records.filter((record) => record.category === active)
    : records;
  const summary = summarizeSovereignLedger(scoped);

  // The template library for this vertical; verticals the catalog does not
  // cover yet say so honestly instead of rendering a blank block.
  const templates = active ? templatesByVertical(active) : TEMPLATES;

  const contracts = await listContracts();

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-12">
      <div className="flex items-center justify-between gap-2.5">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">
          Contract Vault
        </p>
        <HeaderActions demo={demo} />
      </div>
      <h1 className="mt-3 text-3xl font-semibold text-white md:text-4xl">
        Master Contract Data — Every Vertical, One Sovereign Ledger
      </h1>
      <p className="mt-4 max-w-2xl text-white/60">
        {TEMPLATES.length} deterministic agreement templates across the six master
        entertainment verticals — generated from the registered asset of record (names,
        roles, exact pool percentages, registry identifiers) with draft saving, signature
        tracking, immutable finalization, text export, and an embedded ledger audit. Click
        a vertical to swap the entire data surface below.
      </p>

      <div className="mt-8">
        <MasterCategoryTabs active={active} basePath="/contracts" />
      </div>

      <section aria-label="Master ledger for this vertical" className="mt-6 space-y-4">
        <h2 className="font-mono text-xs uppercase tracking-[0.3em] text-white/40">
          Sovereign ledger — {active ? 'selected vertical' : 'all verticals'}
        </h2>
        <MasterStatCards summary={summary} />
        <SovereignLedgerTable records={scoped} />
      </section>

      <section aria-label="Template library" className="mt-10">
        <h2 className="font-mono text-xs uppercase tracking-[0.3em] text-white/40">
          Agreement templates — {active ? 'this vertical' : 'all verticals'}
        </h2>
        {templates.length === 0 ? (
          <p className="mt-3 text-sm text-white/50">
            The {active ? 'template catalog does not yet cover this vertical with a mapped agreement' : 'library is empty'} —
            browse the <Link href="/templates" className="text-gold underline decoration-gold/40">full template library</Link>.
          </p>
        ) : (
          <ul className="mt-5 grid gap-4 sm:grid-cols-2">
            {templates.map((template) => (
              <li key={template.id}>
                <Link
                  href={`/contracts/new?template=${template.id}`}
                  className="glass-card flex h-full flex-col p-5 transition hover:border-gold/40"
                >
                  <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-[#D4AF37]">
                    {CATEGORY_LABELS[template.category]}
                  </span>
                  <span className="mt-2 font-medium text-white">{template.name}</span>
                  <span className="mt-1 flex-1 text-sm text-white/50">{template.summary}</span>
                  <span className="mt-3 font-mono text-xs text-white/40">
                    {template.clauseOrder.length} clauses →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-10 grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        <section aria-label="Saved agreements">
          <h2 className="font-mono text-xs uppercase tracking-[0.3em] text-white/40">
            Saved agreements
          </h2>
          {contracts.length === 0 ? (
            <p className="mt-3 text-sm text-white/50">
              No drafts yet. Pick a template above to generate your first agreement.
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {contracts.map((contract) => {
                // Presentation mapping only — the DRAFT/FINAL schema is untouched.
                const label = presentationStatus(contract.status, false);
                return (
                  <li key={contract.id}>
                    <Link
                      href={`/contracts/${contract.id}`}
                      className="glass-card flex items-center justify-between p-4 transition hover:border-gold/40"
                    >
                      <span>
                        <span className="block text-sm text-white">{contract.fields.asset.title}</span>
                        <span className="mt-0.5 block font-mono text-xs text-white/40">
                          {contract.id} · {contract.cbtCode} · {contract.templateId}
                        </span>
                      </span>
                      <span
                        className={`rounded-full border px-3 py-1 font-mono text-xs ${STATUS_CHIP_CLASSES[label]}`}
                      >
                        {label}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <AuditRunner />
      </div>
    </div>
  );
}
