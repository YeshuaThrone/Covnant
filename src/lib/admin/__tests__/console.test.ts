import { describe, expect, it } from 'vitest';
import {
  adminPageView,
  complianceDraftChanges,
  draftFromProfile,
  formatActionChanges,
  formatChangeValue,
  loginFailureMessage,
  type ComplianceDraft,
} from '../console';
import type { AdminCreatorProfile } from '@/lib/admin/types';
import type { AdminGateVerdict } from '@/lib/admin/gate';

/**
 * Admin console UI decisions — pure-logic coverage for the PR G surface:
 * the page's gate-verdict → view mapping (login vs console vs
 * unavailable), the editor's enum-aware before/after diff (the mirror of
 * the store's server-side computeComplianceChanges), and the login
 * surface's honest failure lines. No DOM — these are the decisions, not
 * the render.
 */

const PROFILE: AdminCreatorProfile = {
  id: 'b3c1a7e2-0000-4000-8000-000000000001',
  stage_name: 'Nova Reign',
  legal_name: 'Jordan A. Reyes',
  email: 'creator@example.com',
  phone: '+15125550123',
  phone_verified_at: null,
  core_industry: 'Music — Recording',
  title: 'Recording Artist',
  udr_terms_accepted_at: '2026-09-09T00:00:00.000Z',
  created_at: '2026-09-09T00:00:00.000Z',
  kyc_status: 'PENDING_INITIALIZATION',
  tax_form_type: 'W9',
  tax_verified: false,
  bank_account_linked: false,
};

function verdict(ok: true): AdminGateVerdict;
function verdict(ok: false, code: 'admin_not_configured' | 'admin_not_authenticated'): AdminGateVerdict;
function verdict(ok: boolean, code?: 'admin_not_configured' | 'admin_not_authenticated'): AdminGateVerdict {
  return ok ? { ok: true } : { ok: false, status: code === 'admin_not_configured' ? 503 : 401, code: code!, message: '' };
}

describe('adminPageView — the gate renders login vs console vs unavailable', () => {
  it('a passing verdict renders the console', () => {
    expect(adminPageView(verdict(true))).toBe('console');
  });

  it('an unauthenticated visitor gets the login surface', () => {
    expect(adminPageView(verdict(false, 'admin_not_authenticated'))).toBe('login');
  });

  it('an unset secret fails closed to the unavailable state — never the login form, never the console', () => {
    expect(adminPageView(verdict(false, 'admin_not_configured'))).toBe('unavailable');
  });
});

describe('complianceDraftChanges — editor enum handling', () => {
  it('a draft equal to the stored row produces an empty patch (nothing to write)', () => {
    const draft = draftFromProfile(PROFILE);
    expect(complianceDraftChanges(PROFILE, draft)).toEqual({});
  });

  it('only the fields the operator changed land in the patch', () => {
    const draft: ComplianceDraft = {
      kyc_status: 'PENDING',
      tax_form_type: 'W9',
      tax_verified: false,
    };
    expect(complianceDraftChanges(PROFILE, draft)).toEqual({ kyc_status: 'PENDING' });
  });

  it('every editable field can change at once', () => {
    const draft: ComplianceDraft = {
      kyc_status: 'VERIFIED',
      tax_form_type: 'W8BEN',
      tax_verified: true,
    };
    expect(complianceDraftChanges(PROFILE, draft)).toEqual({
      kyc_status: 'VERIFIED',
      tax_form_type: 'W8BEN',
      tax_verified: true,
    });
  });

  it('a null slot (nullable column read from a hand-crafted row) is never written', () => {
    const draft: ComplianceDraft = { kyc_status: 'PENDING', tax_form_type: null, tax_verified: null };
    expect(complianceDraftChanges(PROFILE, draft)).toEqual({ kyc_status: 'PENDING' });
  });

  it('a value outside the enforced kyc domain throws — it must never silently vanish from the confirm diff', () => {
    const draft = { kyc_status: 'APPROVED', tax_form_type: 'W9', tax_verified: false } as unknown as ComplianceDraft;
    expect(() => complianceDraftChanges(PROFILE, draft)).toThrow(/kyc_status/);
  });

  it('a value outside the enforced tax-form domain throws', () => {
    const draft = { kyc_status: null, tax_form_type: 'W2', tax_verified: null } as unknown as ComplianceDraft;
    expect(() => complianceDraftChanges(PROFILE, draft)).toThrow(/tax_form_type/);
  });

  it('every enforced enum member round-trips (KYC_STATUSES × TAX_FORM_TYPES)', () => {
    for (const kyc of ['PENDING_INITIALIZATION', 'PENDING', 'VERIFIED', 'REJECTED'] as const) {
      for (const form of ['W9', 'W8BEN', 'EIN'] as const) {
        const patch = complianceDraftChanges(PROFILE, { kyc_status: kyc, tax_form_type: form, tax_verified: null });
        expect(patch.kyc_status).toBe(kyc === 'PENDING_INITIALIZATION' ? undefined : kyc);
        expect(patch.tax_form_type).toBe(form === 'W9' ? undefined : form);
      }
    }
  });
});

describe('formatActionChanges / formatChangeValue — diff rendering', () => {
  it('renders field-level before/after lines the way the action log records them', () => {
    expect(
      formatActionChanges({
        kyc_status: { from: 'PENDING_INITIALIZATION', to: 'PENDING' },
        tax_verified: { from: false, to: true },
      }),
    ).toEqual(['kyc_status: PENDING_INITIALIZATION → PENDING', 'tax_verified: false → true']);
  });

  it('renders null values honestly as an em dash', () => {
    expect(formatChangeValue(null)).toBe('—');
    expect(formatActionChanges({ tax_form_type: { from: null, to: 'EIN' } })).toEqual(['tax_form_type: — → EIN']);
  });
});

describe('loginFailureMessage — honest fail states', () => {
  it('wrong password says so, plainly', () => {
    expect(loginFailureMessage('admin_invalid_password')).toBe('Incorrect password.');
  });

  it('not-configured says so, plainly', () => {
    expect(loginFailureMessage('admin_not_configured')).toBe('Admin console is not configured.');
  });

  it('rate limiting and empty submissions get their own lines', () => {
    expect(loginFailureMessage('rate_limited')).toBe('Too many sign-in attempts. Try again later.');
    expect(loginFailureMessage('missing_password')).toBe('Enter the admin password.');
  });

  it('unknown and network failures share one generic line — no leak, no hint', () => {
    expect(loginFailureMessage(null)).toBe('Sign-in failed. Try again.');
    expect(loginFailureMessage('something_unexpected')).toBe('Sign-in failed. Try again.');
  });
});
