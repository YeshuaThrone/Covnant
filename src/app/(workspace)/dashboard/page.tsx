import { GoldNotificationBanner } from '@/components/brand/GoldNotificationBanner';
import { VerificationBadge } from '@/components/brand/VerificationBadge';
import { StubView } from '@/components/shell/StubView';

/**
 * /dashboard — workspace landing inside the shell. Later PRs replace this
 * stub with the live overview; the notification banner and verification
 * badge set are the shared primitives this surface is specified to carry.
 */
export default function DashboardPage() {
  return (
    <StubView
      kicker="Workspace"
      title="Dashboard"
      body="Your workspace overview. The Obsidian shell is live — registration, the contract vault, and the ownership ledger are one click away."
      links={[
        { href: '/assets/new', label: 'Register an asset' },
        { href: '/contracts', label: 'Open the contract vault' },
        { href: '/ledger', label: 'Review the ledger' },
        { href: '/rights-holders', label: 'Rights holders' },
      ]}
    >
      <div className="mb-8">
        <GoldNotificationBanner title="Workspace rebrand shipped">
          the Obsidian &amp; Deep Gold design system is now the foundation for every surface —
          dashboard metrics arrive in an upcoming release.
        </GoldNotificationBanner>
      </div>
      <section aria-label="Verification states" className="mb-8">
        <h2 className="font-mono text-xs uppercase tracking-[0.3em] text-white/40">
          Verification states this workspace surfaces
        </h2>
        <div className="mt-3 flex flex-wrap gap-3">
          <VerificationBadge variant="pre-reconciled" />
          <VerificationBadge variant="audited" />
          <VerificationBadge variant="immutable-ledger-active" />
        </div>
      </section>
    </StubView>
  );
}
