/**
 * /settings — the fiat-only Settings rebuild (Creator UI Layout Contract
 * G-directive).
 *
 * Renders only REAL account facts from the session resolution: the stage
 * name, KYC status, provisioning status, and payout-account link state.
 * Currency is fiat-only — the platform settles in USD, and no other
 * currency (fiat or otherwise) is offered. Notifications and additional
 * security controls have no backing store in this build, so they render
 * honest "not available yet" disclosures instead of fake toggles — the
 * honesty law: nothing is invented, nothing pretends to save.
 */

import type { Metadata } from 'next';

import { HeaderActions } from '@/components/workspace/HeaderActions';
import {
  loadCreatorPageContext,
  storeForContext,
} from '@/lib/server/creatorPages';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Settings — Covnant',
  description:
    'Your workspace settings — real account facts, fiat-only currency, and honest states for what is not available yet.',
};

function SectionCard({
  testId,
  title,
  children,
}: {
  testId: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      aria-label={title}
      className="glass-card p-6"
    >
      <h2 className="font-display text-lg font-semibold text-slate-100">{title}</h2>
      <div className="mt-4 divide-y divide-slate-700/40">{children}</div>
    </section>
  );
}

function FactRow({ label, value, valueTestId }: {
  label: string;
  value: string;
  valueTestId: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-sm text-slate-300">{label}</span>
      <span
        data-testid={valueTestId}
        className="font-mono text-sm text-slate-100"
      >
        {value}
      </span>
    </div>
  );
}

export default async function SettingsPage() {
  const context = await loadCreatorPageContext();

  if (context === null) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6 md:py-10">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold-champagne">Settings</p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-100 md:text-4xl">
          Sign in to view your settings
        </h1>
        <p className="mt-3 text-sm text-slate-400">
          Your workspace settings live behind your sign-in.
        </p>
      </main>
    );
  }

  const { creator, demo } = context;
  const store = await storeForContext(context);
  const uct = await store.getCreatorUct(creator.payee_id);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6 md:py-10">
      <div
        data-testid="settings-header"
        className="flex items-center justify-between gap-2.5"
      >
        <span className="font-mono text-xs tracking-[0.35em] text-gold-champagne">
          SETTINGS
        </span>
        <HeaderActions demo={demo} />
      </div>

      <h1
        data-testid="settings-title"
        className="mt-6 text-4xl font-bold tracking-tight text-slate-100 md:text-5xl"
      >
        <span className="bg-gradient-to-r from-gold-champagne via-emerald-200 to-gold bg-clip-text text-transparent">
          Settings
        </span>
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-400">
        Your workspace account. Everything here reads your real account state —
        nothing on this page is stored in your browser or invented.
      </p>

      <div className="gold-rule my-6 md:my-8" />

      <div className="space-y-5">
        <SectionCard testId="settings-profile" title="Profile">
          <FactRow label="Creator" value={creator.stage_name} valueTestId="settings-stage-name" />
          <FactRow label="Covnant ID" value={uct?.uctNumber ?? 'Not issued'} valueTestId="settings-uct" />
          <FactRow label="Identity verification" value={creator.kyc_status} valueTestId="settings-kyc" />
          <FactRow label="Provisioning" value={creator.provisioning_status} valueTestId="settings-provisioning" />
        </SectionCard>

        <SectionCard testId="settings-payouts" title="Payout account">
          <FactRow
            label="Payout account"
            value={creator.bank_account_linked ? 'Linked' : 'Not linked'}
            valueTestId="settings-bank-status"
          />
          <p className="py-2.5 text-xs leading-relaxed text-slate-500" data-testid="settings-payout-note">
            {creator.bank_account_linked
              ? 'Payouts settle from your sovereign vault to your linked payout account on the sandbox rail.'
              : 'Link a payout account to receive vault payouts. Until one is linked, settled amounts remain in your vault.'}
          </p>
        </SectionCard>

        <SectionCard testId="settings-currency" title="Currency">
          <FactRow label="Settlement currency" value="USD" valueTestId="settings-currency-value" />
          <p className="py-2.5 text-xs leading-relaxed text-slate-500" data-testid="settings-currency-note">
            Covnant settles in USD — fiat only. Amounts across the workspace are
            integer cents, rendered as dollars and cents. Additional currencies
            are not supported yet.
          </p>
        </SectionCard>

        <SectionCard testId="settings-notifications" title="Notifications">
          <p className="py-2.5 text-xs leading-relaxed text-slate-500" data-testid="settings-notifications-note">
            Notification preferences are not available yet. When they arrive,
            they will be managed here — no placeholder switches in the meantime.
          </p>
        </SectionCard>

        <SectionCard testId="settings-security" title="Security">
          <p className="py-2.5 text-xs leading-relaxed text-slate-500" data-testid="settings-security-note">
            Your workspace session is carried by your sign-in cookies. Additional
            security controls (two-factor authentication, device management) are
            not available yet and will appear here when they ship.
          </p>
        </SectionCard>
      </div>

      {demo && (
        <p className="mt-6 rounded-lg border border-amber-300/30 bg-amber-300/10 p-3 text-xs leading-relaxed text-amber-200" data-testid="settings-demo-note">
          This is the demo persona&apos;s settings — the seeded preview state. No
          real holder&apos;s account is shown.
        </p>
      )}
    </main>
  );
}
