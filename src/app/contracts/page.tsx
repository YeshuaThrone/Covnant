import Link from 'next/link';
import { TEMPLATES, type ContractIndustry } from '@/lib/contracts/templates';
import { listContracts } from '@/lib/contracts/store';
import { AuditRunner } from '@/components/vault/AuditRunner';

const TABS: { key: 'ALL' | ContractIndustry; label: string }[] = [
  { key: 'ALL', label: 'All templates' },
  { key: 'MUSIC', label: 'Music' },
  { key: 'FILM_MEDIA_MERCH', label: 'Film, Media & Merch' },
];

export default async function ContractsPage({
  searchParams,
}: {
  searchParams: Promise<{ industry?: string }>;
}) {
  const { industry } = await searchParams;
  const active = TABS.find((tab) => tab.key === industry)?.key ?? 'ALL';
  const templates =
    active === 'ALL'
      ? TEMPLATES
      : TEMPLATES.filter((template) => template.industry === active);
  const contracts = await listContracts();

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-12">
      <header>
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-[#00C8FF]">
          Contract Vault
        </p>
        <h1 className="mt-3 text-3xl font-semibold text-white md:text-4xl">
          Automated Contract Vault &amp; Smart Ledger Verification
        </h1>
        <p className="mt-4 max-w-2xl text-white/60">
          Fourteen industry-specific agreement templates, generated deterministically from the
          registered asset of record — names, roles, and exact pool percentages — with draft
          saving, immutable finalization, text export, and an embedded ledger audit.
        </p>
      </header>

      <div className="mt-10 grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-8">
          <section>
            <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Template industries">
              {TABS.map((tab) => (
                <Link
                  key={tab.key}
                  href={tab.key === 'ALL' ? '/contracts' : `/contracts?industry=${tab.key}`}
                  role="tab"
                  aria-selected={active === tab.key}
                  className={`rounded-full border px-4 py-1.5 text-sm transition ${
                    active === tab.key
                      ? 'border-[#00C8FF]/60 bg-[#00C8FF]/10 text-[#00C8FF]'
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
                    className="glass-card flex h-full flex-col p-5 transition hover:border-[#00C8FF]/40"
                  >
                    <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-[#D4AF37]">
                      {template.industry === 'MUSIC' ? 'Music' : 'Film, Media & Merch'}
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
                {contracts.map((contract) => (
                  <li key={contract.id}>
                    <Link
                      href={`/contracts/${contract.id}`}
                      className="glass-card flex items-center justify-between p-4 transition hover:border-[#00C8FF]/40"
                    >
                      <span>
                        <span className="block text-sm text-white">{contract.fields.asset.title}</span>
                        <span className="mt-0.5 block font-mono text-xs text-white/40">
                          {contract.id} · {contract.cbtCode} · {contract.templateId}
                        </span>
                      </span>
                      <span
                        className={`rounded-full border px-3 py-1 font-mono text-xs ${
                          contract.status === 'FINAL'
                            ? 'border-emerald-400/40 text-emerald-300'
                            : 'border-white/20 text-white/60'
                        }`}
                      >
                        {contract.status}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <AuditRunner />
      </div>
    </div>
  );
}
