import Link from 'next/link';
import {
  templatesByVertical,
} from '@/lib/contracts/templates';
import {
  MASTER_CATEGORY_ORDER,
  MASTER_CATEGORY_LABELS,
  MASTER_CATEGORY_BLURBS,
} from '@/lib/master/taxonomy';
import { getSdk } from '@/lib/sdk';

export const dynamic = 'force-dynamic';

/**
 * /templates — the agreement-template library, grouped under the SIX MASTER
 * entertainment verticals (founder canon, CovnantMasterDataSDK): the master
 * taxonomy is the presentation vocabulary. Twenty deterministic agreements;
 * every card starts the generation flow from the asset of record: with a
 * `?cbt=` the cards deep-link straight into the hydrated editor, otherwise
 * the vault's asset picker selects the asset first. A vertical the catalog
 * does not yet cover says so honestly — never a blank block, never a fake
 * card.
 */
export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ cbt?: string }>;
}) {
  const { cbt } = await searchParams;

  // Deep-link support: an asset of record can hand the library a CBT code, in
  // which case every card auto-fills from it. Unknown codes degrade quietly.
  let assetTitle: string | undefined;
  if (cbt) {
    try {
      assetTitle = (await getSdk().getOrHydrateAsset(cbt)).title;
    } catch {
      assetTitle = undefined;
    }
  }

  const hrefFor = (templateId: string) =>
    cbt && assetTitle
      ? `/contracts/new?template=${templateId}&cbt=${encodeURIComponent(cbt)}`
      : `/contracts/new?template=${templateId}`;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-12">
      <header>
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">Templates</p>
        <h1 className="mt-3 text-3xl font-semibold text-white md:text-4xl">
          Agreement Template Library
        </h1>
        <p className="mt-4 max-w-2xl text-white/60">
          Twenty deterministic agreements grouped by the six master entertainment
          verticals. Each one auto-fills from the registered asset of record — legal
          names, exact percentage splits, and CBT/EIDR identifiers — with PRO/IPI
          numbers mapped only when they exist on holder profiles.
        </p>
      </header>

      {cbt && assetTitle && (
        <p
          className="mt-6 rounded-lg border border-gold/30 bg-gold/5 p-4 text-sm text-white/70"
          data-testid="templates-asset-banner"
        >
          Generating against the asset of record:{' '}
          <span className="text-[#FFD700]">{assetTitle}</span>{' '}
          <span className="font-mono text-xs text-white/40">({cbt})</span> — every template below
          auto-fills from its stored pools and identifiers.
        </p>
      )}

      <div className="mt-10 space-y-12">
        {MASTER_CATEGORY_ORDER.map((vertical) => {
          const templates = templatesByVertical(vertical);
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

              {templates.length === 0 ? (
                <p className="mt-5 text-sm text-white/50" data-testid="vertical-coverage-note">
                  The catalog does not yet carry an agreement mapped to this vertical — the
                  {' '}<Link href="/contracts" className="text-gold underline decoration-gold/40">contract vault</Link>{' '}
                  covers it through custom drafts in the meantime.
                </p>
              ) : (
                <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {templates.map((template) => (
                    <li key={template.id}>
                      <Link
                        href={hrefFor(template.id)}
                        className="glass-card flex h-full flex-col p-5 transition hover:border-gold/40"
                      >
                        <span className="font-medium text-white">{template.name}</span>
                        <span className="mt-1 flex-1 text-sm text-white/50">{template.summary}</span>
                        <span className="mt-3 font-mono text-xs text-white/40">
                          {template.clauseOrder.length} clauses · auto-fills from the asset of
                          record →
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
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
