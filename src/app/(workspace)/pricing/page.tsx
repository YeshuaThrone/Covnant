import { StubView } from '@/components/shell/StubView';

/**
 * /pricing — subscription plans for the Covnant workspace. Later PRs build
 * the live plan surface with billing; the shell entry resolves today.
 */
export default function PricingPage() {
  return (
    <StubView
      kicker="Plans"
      title="Covnant Plans"
      body="Membership plans for creators, rights holders, and rights organizations. The live plan enrollment flow arrives in an upcoming release — registration, the contract vault, and the ledger are open today."
      links={[
        { href: '/dashboard', label: 'Back to the workspace' },
      ]}
    />
  );
}
