/**
 * Admin console UI decision logic — pure functions shared by the /admin
 * page (server) and the console components (client). No I/O, no React:
 * every branch the console renders is decided here, so the gate's
 * login-vs-console-vs-unavailable behavior and the editor's enum handling
 * are unit-testable without a DOM.
 *
 * The gate semantics are PR F's (src/lib/admin/gate.ts); this module only
 * maps a gate verdict to the view the page renders and shapes the editor's
 * local diff. The server re-validates every mutation (validateCompliancePatch)
 * — the client diff exists so the operator CONFIRMS exactly what will be
 * written before the PATCH fires.
 */

import type { AdminActionChanges, AdminCreatorProfile, CreatorCompliancePatch, KycStatus, TaxFormType } from './types';
import { KYC_STATUSES, TAX_FORM_TYPES } from './types';
import type { AdminGateVerdict } from './gate';

/** The three views the /admin page renders for a gate verdict. */
export type AdminPageView = 'unavailable' | 'login' | 'console';

/**
 * Gate verdict → page view. Fail-closed reads as: the secret is unset →
 * the console is unavailable (never open); the operator is not
 * authenticated → the login surface; otherwise the console.
 */
export function adminPageView(verdict: AdminGateVerdict): AdminPageView {
  if (verdict.ok) return 'console';
  return verdict.code === 'admin_not_configured' ? 'unavailable' : 'login';
}

/**
 * The editor's draft — one slot per v1-editable field. `null` means "no
 * selection yet" (a nullable column read from a hand-crafted row): a null
 * slot is never written; selecting a domain value is the intent to write.
 */
export interface ComplianceDraft {
  kyc_status: KycStatus | null;
  tax_form_type: TaxFormType | null;
  tax_verified: boolean | null;
}

/** The editor's draft as-is for the row's stored compliance values. */
export function draftFromProfile(before: AdminCreatorProfile): ComplianceDraft {
  return {
    kyc_status: before.kyc_status,
    tax_form_type: before.tax_form_type,
    tax_verified: before.tax_verified,
  };
}

function isKycStatus(value: unknown): value is KycStatus {
  return typeof value === 'string' && (KYC_STATUSES as readonly string[]).includes(value);
}

function isTaxFormType(value: unknown): value is TaxFormType {
  return typeof value === 'string' && (TAX_FORM_TYPES as readonly string[]).includes(value);
}

/**
 * Field-level before/after for exactly the fields the operator's draft
 * changes — the mirror of the store's computeComplianceChanges, so the
 * confirm step shows the operator the same diff the action log will
 * record. Values outside the 0004 enum domains are a programming error
 * (the selects are bounded by KYC_STATUSES/TAX_FORM_TYPES) and throw —
 * an invalid value must never silently vanish from the confirm diff.
 */
export function complianceDraftChanges(
  before: AdminCreatorProfile,
  draft: ComplianceDraft,
): CreatorCompliancePatch {
  const patch: CreatorCompliancePatch = {};

  if (draft.kyc_status !== null) {
    if (!isKycStatus(draft.kyc_status)) {
      throw new Error(`complianceDraftChanges: kyc_status value outside the enforced domain: ${String(draft.kyc_status)}`);
    }
    if (draft.kyc_status !== before.kyc_status) patch.kyc_status = draft.kyc_status;
  }

  if (draft.tax_form_type !== null) {
    if (!isTaxFormType(draft.tax_form_type)) {
      throw new Error(`complianceDraftChanges: tax_form_type value outside the enforced domain: ${String(draft.tax_form_type)}`);
    }
    if (draft.tax_form_type !== before.tax_form_type) patch.tax_form_type = draft.tax_form_type;
  }

  if (draft.tax_verified !== null && draft.tax_verified !== before.tax_verified) {
    patch.tax_verified = draft.tax_verified;
  }

  return patch;
}

/** Renders one stored value for a diff line — booleans verbatim, null as an em dash. */
export function formatChangeValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** Human diff lines for a changes object: `field: from → to`. */
export function formatActionChanges(changes: AdminActionChanges): string[] {
  return Object.entries(changes).map(([field, change]) => `${field}: ${formatChangeValue(change.from)} → ${formatChangeValue(change.to)}`);
}

/**
 * Honest failure lines for the login surface, keyed by the API's machine
 * code (jsonError's `reason`). Unknown and network failures share one
 * generic line — the gate never leaks which part failed.
 */
export function loginFailureMessage(reason: string | null | undefined): string {
  switch (reason) {
    case 'admin_invalid_password':
      return 'Incorrect password.';
    case 'admin_not_configured':
      return 'Admin console is not configured.';
    case 'rate_limited':
      return 'Too many sign-in attempts. Try again later.';
    case 'missing_password':
      return 'Enter the admin password.';
    default:
      return 'Sign-in failed. Try again.';
  }
}
