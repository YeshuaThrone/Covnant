/**
 * Provisioning status labels — the one text vocabulary for the Increase
 * provisioning chip across every surface (dashboard account cards, sidebar
 * cards, readiness checklist). Status ONLY: these labels never render
 * account or routing numbers — the reason code is a provisioning fact, not
 * account credentials.
 */

import type { CovnantMeProvisioning } from '@/lib/covnant/types';

export type ProvisioningStatusValue = CovnantMeProvisioning['status'];

export type ProvisioningLabel = {
  /** The chip's status text. */
  label: string;
  /** The PENDING explainer — why the account is not ready yet. */
  note: string;
};

export const PROVISIONING_LABELS: Record<ProvisioningStatusValue, ProvisioningLabel> = {
  PROVISIONED: {
    label: 'Virtual account ready',
    note: 'Your virtual account is ready to receive settlements.',
  },
  PENDING: {
    label: 'Virtual account provisioning',
    note: 'Your virtual account is being provisioned — settlements route to your escrow until it is ready.',
  },
};
