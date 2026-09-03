import { StubView } from '@/components/shell/StubView';

/**
 * /templates — the categorized agreement-template library. The live,
 * generation-capable vault is /contracts; later PRs build the categorized
 * browsing experience on top of it.
 */
export default function TemplatesPage() {
  return (
    <StubView
      kicker="Templates"
      title="Agreement Template Library"
      body="Fourteen deterministic agreements across Music and Film, Media & Merch — generated from the asset of record. The full categorized library arrives in an upcoming release; the working vault is live today."
      links={[
        { href: '/contracts', label: 'Open the live template vault' },
      ]}
    />
  );
}
