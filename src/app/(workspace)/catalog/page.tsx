import { StubView } from '@/components/shell/StubView';

/**
 * /catalog — the Covenant Block catalog. Later PRs build the full catalog
 * view; today the registered-asset list lives in the Asset Studio.
 */
export default function CatalogPage() {
  return (
    <StubView
      kicker="Catalog"
      title="Covenant Block Catalog"
      body="Every registered Covenant Block asset, browsable by medium and identifier. The registered-asset list is live in the Asset Studio today; the full catalog view arrives in an upcoming release."
      links={[
        { href: '/assets', label: 'Browse registered assets' },
        { href: '/assets/new', label: 'Register an asset' },
      ]}
    />
  );
}
