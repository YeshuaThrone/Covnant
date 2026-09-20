import Link from 'next/link';
import {
  masterTemplatesForCategory,
  resolveMasterTemplates,
} from '@/lib/master/masterStore';
import {
  MASTER_CATEGORY_ORDER,
  MASTER_CATEGORY_LABELS,
  MASTER_CATEGORY_BLURBS,
  masterCategoryFromParam,
} from '@/lib/master/taxonomy';
import { HeaderActions } from '@/components/workspace/HeaderActions';
import { MasterCategoryTabs } from '@/components/master/MasterData';
import { FactoryTemplateGrid } from '@/components/master/MasterTemplates';

export const dynamic = 'force-dynamic';

/**
 * /templates — the COVNANT SOVEREIGN CONTRACT FACTORY (founder canon,
 * CovnantTemplatesSDK), on the existing page shell: the six master
 * entertainment verticals tab the library, and every tab shows a fully
 * populated template library — every form of entertainment, none left out.
 * Each card renders its ContractTemplateRecord from the master template
 * store: jurisdiction, key clauses, the 50/35/15 allocation structure, and
 * the factory's execution history. Drafts and finalization live in the
 * Contract Vault.
 */
export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const { category } = await searchParams;
  const active = masterCategoryFromParam(category);

  // The master data seam — the seeded factory library in demo/preview (under
  // the DEMO DATA badge), the canon library with live-store execution counts
  // otherwise. Store-computed, always.
  const { demo, records } = await resolveMasterTemplates();
  const verticals = active ? [active] : [...MASTER_CATEGORY_ORDER];

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-12">
      <header>
        <div className="flex items-center justify-between gap-2.5">
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">Templates</p>
          <HeaderActions demo={demo} />
        </div>
        <h1 className="mt-3 text-3xl font-semibold text-white md:text-4xl">
          Agreement Template Library
        </h1>
        <p className="mt-4 max-w-2xl text-white/60">
          {records.length} sovereign contract templates across the six master
          entertainment verticals — every form of entertainment, each carrying its
          governing jurisdiction, engineered key clauses, the 50/35/15 allocation
          structure, and the factory&apos;s execution history. Click a vertical to swap
          the library below.
        </p>
      </header>

      <div className="mt-10">
        <MasterCategoryTabs active={active} basePath="/templates" />
      </div>

      <div className="mt-6 space-y-12">
        {verticals.map((vertical) => {
          const templates = masterTemplatesForCategory(records, vertical);
          return (
            <section key={vertical} aria-label={MASTER_CATEGORY_LABELS[vertical]} data-testid="template-vertical-section">
              <div className="flex items-baseline justify-between gap-4">
                <h2 className="text-xl font-semibold text-white">{MASTER_CATEGORY_LABELS[vertical]}</h2>
                <span className="font-mono text-xs text-white/40">
                  {templates.length} template{templates.length === 1 ? '' : 's'}
                </span>
              </div>
              <p className="mt-1 text-sm text-white/50">{MASTER_CATEGORY_BLURBS[vertical]}</p>
              <div className="gold-rule mt-4" />

              <FactoryTemplateGrid records={templates} />
            </section>
          );
        })}
      </div>

      <p className="mt-12 text-sm text-white/50">
        Working drafts, finalization, and export live in{' '}
        <Link href="/contracts" className="text-gold hover:underline">
          the Contract Vault
        </Link>
        .
      </p>
    </div>
  );
}
