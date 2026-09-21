/**
 * Payee tax profiles — the compliance layer the tax engine resolves
 * against (founder addendum, 2026-09-21: the Tax tab reflects EVERY
 * creator, so a profile is built for EACH payee from their identity of
 * record — the master store's UCT identities — plus their jurisdiction
 * and TIN-state records. Never a separate curated demo list.)
 *
 * The demo door's branch ASSIGNMENT lives in DEMO_PAYEE_TAX_BRANCHES: the
 * eight store identities carry the compliance states that exercise every
 * engine branch on the tab (verified and pending TINs, treaty and
 * non-treaty residences, the mandatory locks). Real deployments replace
 * this map with the compliance vault read — the engine call is identical.
 * A payee with no record resolves fail-closed to UNSUBMITTED: no form on
 * file means the payout cannot release clean.
 */

import { UCT_DEMO_IDENTITIES } from '@/lib/master/masterStore';
import type { PayeeTaxProfile, TaxFormClassification, TaxTinStatus } from './CovnantTaxComplianceSDK';

/** The compliance fields a profile adds to a payee's identity of record. */
export interface PayeeTaxBranch {
  countryCode: string;
  stateJurisdiction?: string;
  tinStatus: TaxTinStatus;
  formType: TaxFormClassification;
  usResident: boolean;
  treatyClaimActive: boolean;
}

/**
 * The demo door's TIN/treaty states, ASSIGNED across the master store's
 * UCT identities. The UCT id's issuance country is the identity layer;
 * the tax residence here is the W-8/W-9 compliance layer of record. The
 * operations party's PENDING state matches the settlement engine's own
 * backup-withholding profile for that party — both engines tell one story.
 */
export const DEMO_PAYEE_TAX_BRANCHES: Readonly<Record<string, PayeeTaxBranch>> = Object.freeze({
  'identity-founder': {
    countryCode: 'US',
    stateJurisdiction: 'TX',
    tinStatus: 'VERIFIED',
    formType: '1099_MISC',
    usResident: true,
    treatyClaimActive: false,
  },
  'identity-gold-hours': {
    countryCode: 'GB',
    tinStatus: 'VERIFIED',
    formType: 'W8_BEN_E',
    usResident: false,
    treatyClaimActive: true,
  },
  'identity-meridian': {
    countryCode: 'MX',
    tinStatus: 'VERIFIED',
    formType: 'W8_BEN_E',
    usResident: false,
    treatyClaimActive: true,
  },
  'identity-sovereign-stage': {
    // A verified residence with no treaty rate on record — the statutory
    // fallback applies without a lock.
    countryCode: 'BR',
    tinStatus: 'VERIFIED',
    formType: 'W8_BEN_E',
    usResident: false,
    treatyClaimActive: false,
  },
  'identity-vault-runners': {
    // TIN never submitted: the mandatory 30 percent lock, forfeiting the
    // treaty rate the residence would otherwise carry.
    countryCode: 'JP',
    tinStatus: 'UNSUBMITTED',
    formType: 'W8_BEN_E',
    usResident: false,
    treatyClaimActive: false,
  },
  'identity-operations': {
    countryCode: 'US',
    stateJurisdiction: 'TX',
    tinStatus: 'PENDING',
    formType: '1099_NEC',
    usResident: true,
    treatyClaimActive: false,
  },
  'identity-gold-hours-publishing': {
    // Corporate payee of record — exempt from payee form reporting.
    countryCode: 'US',
    stateJurisdiction: 'TX',
    tinStatus: 'VERIFIED',
    formType: 'EXEMPT_CORPORATE',
    usResident: true,
    treatyClaimActive: false,
  },
  'identity-sovereign-fit': {
    countryCode: 'US',
    stateJurisdiction: 'TX',
    tinStatus: 'VERIFIED',
    formType: '1099_MISC',
    usResident: true,
    treatyClaimActive: false,
  },
});

/**
 * The demo door keys payee ids as `${identityKey}-demo-${index}` (the
 * settlement roster's own ids). The identity key is the stable part —
 * the same person settles under different roster indexes per asset.
 */
export function identityKeyFromPayeeId(payeeId: string): string {
  const marker = payeeId.indexOf('-demo-');
  return marker > 0 ? payeeId.slice(0, marker) : payeeId;
}

/** The payee's display jurisdiction of record: country plus state nexus when present. */
export function jurisdictionLabel(branch: PayeeTaxBranch): string {
  return branch.stateJurisdiction ? `${branch.countryCode}-${branch.stateJurisdiction}` : branch.countryCode;
}

/**
 * Build the payee's tax profile of record: identity (UCT id, name) from
 * the master store, compliance state from the branch layer, YTD from the
 * caller's fold of the cleared history. Fail-closed for a payee with no
 * identity record — UNSUBMITTED TIN, no treaty, no exemption.
 */
export function payeeTaxProfileFor(
  payeeId: string,
  payeeName: string,
  ytdClearedGrossUSD: number,
): PayeeTaxProfile {
  const identityKey = identityKeyFromPayeeId(payeeId);
  const identity = UCT_DEMO_IDENTITIES[identityKey];
  const branch = DEMO_PAYEE_TAX_BRANCHES[identityKey];
  return {
    payeeId,
    payeeName: identity?.name ?? payeeName,
    ...(branch ?? {
      countryCode: 'US',
      tinStatus: 'UNSUBMITTED',
      formType: '1099_MISC',
      usResident: true,
      treatyClaimActive: false,
    }),
    ytdClearedGrossUSD,
  };
}
