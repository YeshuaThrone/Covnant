import Link from 'next/link';
import {
  CATEGORY_LABELS,
  TEMPLATES,
  templatesByCategory,
  type ContractCategory,
} from '@/lib/contracts/templates';
import { listContracts } from '@/lib/contracts/store';
import { presentationStatus, STATUS_CHIP_CLASSES } from '@/lib/contracts/presentation';
import { AuditRunner } from '@/components/vault/AuditRunner';

const TABS: { key: 'ALL' | ContractCategory; label: string }[] = [
  { key: 'ALL', label: 'All categories' },
  { key: 'MUSIC', label: CATEGORY_LABELS.MUSIC },
  { key: 'FILM_TV', label: CATEGORY_LABELS.FILM_TV },
  { key: 'GAMING', label: CATEGORY_LABELS.GAMING },
  { key: 'CREATORS', label: CATEGORY_LABELS.CREATORS },
  { key: 'FASHION', label: CATEGORY_LABELS.FASHION },
];

export default async function ContractsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const { category } = await searchParams;
  const active = TABS.find((tab) => tab.key === category)?.key ?? 'ALL';
  const templates =
    active === 'ALL' ? TEMPLATES : templatesByCategory(active);
  const contracts = await listContracts();

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-12">
      <header>
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">
          Contract Vault
        </p>
        <h1 className="mt-3 text-3xl font-semibold text-white md:text-4xl">
          Automated Contract Vault &amp; Smart Ledger Verification
        </h1>
        <p className="mt-4 max-w-2xl text-white/60">
          Sixteen industry-specific agreement templates across Music, Film/TV, Gaming, and
          Podcasts/Creators — generated deterministically from the registered asset of record
          (names, roles, exact pool percentages, registry identifiers) with draft saving,
          signature tracking, immutable finalization, text export, and an embedded ledger audit.
        </p>
      </header>

      <div className="mt-10 grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-8">
          <section>
            <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Template categories">
              {TABS.map((tab) => (
                <Link
                  key={tab.key}
                  href={tab.key === 'ALL' ? '/contracts' : `/contracts?category=${tab.key}`}
                  role="tab"
                  aria-selected={active === tab.key}
                  className={`rounded-full border px-4 py-1.5 text-sm transition ${
                    active === tab.key
                      ? 'border-gold/60 bg-gold/10 text-gold'
                      : 'border-white/10 text-white/60 hover:border-white/25 hover:text-white'
                  }`}
                >
                  {tab.label}
                </Link>
              ))}
            </div>

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
          </section>

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
        </div>

        <AuditRunner />
      </div>
    </div>
  );
}
