import { StubView } from '@/components/shell/StubView';

/**
 * /settings — workspace preferences. Later PRs build the live settings
 * surface (profile, notifications, payout defaults); the shell entry
 * resolves today.
 */
export default function SettingsPage() {
  return (
    <StubView
      kicker="Settings"
      title="Workspace Settings"
      body="Profile, notification, and payout preferences for your workspace. The live settings surface arrives in an upcoming release — nothing here gates registration, agreements, or settlements today."
      links={[
        { href: '/dashboard', label: 'Back to the workspace' },
      ]}
    />
  );
}
