/**
 * THE TAX PROFILE OF RECORD — one registry, one answer (audit #10).
 *
 * The tax audit (note_c5ksDgVw, verified at 556924e) found THREE divergent
 * registries answering "what is this payee's tax profile", plus the legacy
 * vendored engine's own rate fallbacks, with no single authority:
 *
 *   R1  creator_tax_profiles (the Don engine's store record — the fields
 *       applyWithholding maintains and only the server writes, per PR #149)
 *   R2  cbt_assets.rights_holders[].taxProfile (the registration-time JSONB
 *       the CBT escrow balance math reads) + the hardcoded 30%/24%
 *       fail-closed fallbacks when a holder carries no profile at all
 *   R3  DEMO_PAYEE_TAX_BRANCHES (the demo door's assigned branches — the
 *       frozen Gold Board feed)
 *
 * Which registry answered could differ by call site: an operator verifying
 * a creator through the server flow (R1) never reached the consumers that
 * read R2 or R3. This module is the ONE place that unifies their
 * vocabularies: adapters build a TaxProfileOfRecord from each registry,
 * `withServerVerification` propagates the server's verification of record
 * ONTO any adapted profile (upgrade-only — see below), and the projections
 * hand every consumer vocabulary its own shape back.
 *
 * SCOPE OF RECORD — each engine resolves through its own registry, and the
 * adapters are consumed per scope (never globally merged):
 *
 *   • Don/compliance scope (applyWithholding, the verification writer, the
 *     MCP tool): R1 is the record. Unchanged — this module formalizes its
 *     vocabulary.
 *   • CBT escrow scope (withdrawal/dashboard balances): R2 is the record;
 *     the vendored engine stays the rate CALCULATOR (locked 24/30/treaty
 *     semantics) and `effectiveWithholdingRateOf` is its single entry.
 *   • Demo fold (the admin Tax tab): R3 is the record, frozen —
 *     `profileFromDemoBranch` copies it field for field and
 *     `failClosedPayeeProfile` reproduces the exact legacy default.
 *
 * The dev-seed pins WHY scopes must not cross-override: the demo creator
 * is deliberately UNVERIFIED in R1 (backup withholding builds the reserve —
 * locked semantic #4) while VERIFIED in R2 (the escrow balance side), by
 * design. `withServerVerification` is therefore UPGRADE-ONLY: a
 * server-verified R1 row lifts a profile to VERIFIED everywhere it is
 * applied, and an R1 row that is not verified never downgrades another
 * registry's record. Server verification can release a payout to clean;
 * it can never silently rewrite a registry it does not own.
 */

import { CovenantTaxEngine, type TaxProfile } from '@/engine/covenant-master-sdk';
import type { PayeeTaxProfile, TaxFormClassification, TaxTinStatus } from './CovnantTaxComplianceSDK';

/** Which registry resolved a profile of record. */
export type TaxProfileSource =
  | 'creator_tax_profile'
  | 'demo_branch'
  | 'rights_holder_profile'
  | 'fail_closed_default';

/** The registry-agnostic shape every adapter builds and every projection consumes. */
export interface TaxProfileOfRecord {
  identityKey: string;
  tinVerified: boolean;
  w9OnFile: boolean;
  tinStatus: TaxTinStatus;
  formType: TaxFormClassification;
  /** ISO-2 residence of record; null when the source registry carries no country. */
  countryCode: string | null;
  stateJurisdiction?: string;
  usResident: boolean;
  treatyClaimActive: boolean;
  treatyWithholdingRate?: number;
  backupWithholdingRequired: boolean;
  taxIdentifierEncrypted?: string;
  source: TaxProfileSource;
}

/** The demo branch's shape (structural — DEMO_PAYEE_TAX_BRANCHES satisfies it). */
export interface DemoTaxBranchShape {
  countryCode: string;
  stateJurisdiction?: string;
  tinStatus: TaxTinStatus;
  formType: TaxFormClassification;
  usResident: boolean;
  treatyClaimActive: boolean;
}

/** The R1 adapter's row shape (CreatorTaxProfile's verification fields). */
export interface CreatorTaxProfileShape {
  tin_verified: number;
  w9_on_file: number;
}

/**
 * R1 — the Don engine's creator tax profile. Both flags true is the ONLY
 * verified state (isTinVerified's locked conjunction); anything else
 * resolves to the platform's UNSUBMITTED default. The Don scope never
 * reads residency or treaty fields, so those carry the US-reporting
 * defaults the compliance engine's vocabulary implies.
 */
export function profileFromCreatorTaxProfile(
  identityKey: string,
  row: CreatorTaxProfileShape | undefined,
): TaxProfileOfRecord {
  const tinVerified = row?.tin_verified === 1;
  const w9OnFile = row?.w9_on_file === 1;
  return {
    identityKey,
    tinVerified,
    w9OnFile,
    tinStatus: tinVerified && w9OnFile ? 'VERIFIED' : 'UNSUBMITTED',
    formType: '1099_MISC',
    countryCode: 'US',
    usResident: true,
    treatyClaimActive: false,
    backupWithholdingRequired: false,
    source: row ? 'creator_tax_profile' : 'fail_closed_default',
  };
}

/** R2's vendored form vocabulary → the founder engine's classification. */
const FORM_CLASSIFICATION_BY_ENGINE_FORM: Record<TaxProfile['taxFormType'], TaxFormClassification> = {
  W9_US_PERSON: '1099_MISC',
  W8BEN_FOREIGN_INDIVIDUAL: 'W8_BEN',
  W8BEN_E_FOREIGN_ENTITY: 'W8_BEN_E',
  EXEMPT: 'EXEMPT_CORPORATE',
};

/**
 * R2 — the CBT asset's rights-holder JSONB profile. The registration-time
 * self-assertion IS the escrow scope's record: `isVerified` maps to the
 * TIN status, the treaty fields pass through, and the vendored engine's
 * rate calculator reads the projection back with identical semantics.
 */
export function profileFromRightsHolderTaxProfile(
  taxProfile: TaxProfile,
  identityKey = '',
): TaxProfileOfRecord {
  return {
    identityKey,
    tinVerified: taxProfile.isVerified,
    w9OnFile: taxProfile.isVerified,
    tinStatus: taxProfile.isVerified ? 'VERIFIED' : 'UNSUBMITTED',
    formType: FORM_CLASSIFICATION_BY_ENGINE_FORM[taxProfile.taxFormType],
    countryCode: taxProfile.treatyCountryCode ?? null,
    usResident: taxProfile.usTaxResident,
    treatyClaimActive: taxProfile.treatyCountryCode !== undefined,
    ...(taxProfile.treatyWithholdingRate !== undefined
      ? { treatyWithholdingRate: taxProfile.treatyWithholdingRate }
      : {}),
    backupWithholdingRequired: taxProfile.isBackupWithholdingRequired,
    taxIdentifierEncrypted: taxProfile.taxIdentifierEncrypted,
    source: 'rights_holder_profile',
  };
}

/**
 * R3 — the demo door's assigned branch, copied field for field: the Gold
 * Board is frozen and every engine branch the tab exercises (verified and
 * pending TINs, treaty and non-treaty residences, the mandatory locks)
 * must resolve exactly as before.
 */
export function profileFromDemoBranch(
  identityKey: string,
  branch: DemoTaxBranchShape,
): TaxProfileOfRecord {
  return {
    identityKey,
    tinVerified: branch.tinStatus === 'VERIFIED',
    w9OnFile: branch.tinStatus === 'VERIFIED',
    tinStatus: branch.tinStatus,
    formType: branch.formType,
    countryCode: branch.countryCode,
    ...(branch.stateJurisdiction !== undefined
      ? { stateJurisdiction: branch.stateJurisdiction }
      : {}),
    usResident: branch.usResident,
    treatyClaimActive: branch.treatyClaimActive,
    backupWithholdingRequired: false,
    source: 'demo_branch',
  };
}

/**
 * The fail-closed default for the demo fold — a payee with no record on
 * file anywhere: UNSUBMITTED TIN, no treaty, no exemption. The payout
 * cannot release clean. (Identical to payeeTaxProfileFor's legacy default.)
 */
export function failClosedPayeeProfile(identityKey: string): TaxProfileOfRecord {
  return {
    identityKey,
    tinVerified: false,
    w9OnFile: false,
    tinStatus: 'UNSUBMITTED',
    formType: '1099_MISC',
    countryCode: 'US',
    usResident: true,
    treatyClaimActive: false,
    backupWithholdingRequired: false,
    source: 'fail_closed_default',
  };
}

/**
 * The escrow scope's fail-closed fallback for a rights holder on NO asset —
 * an unverified foreign profile so the engine charges the mandatory 30%:
 * compliance errs toward withholding more, never less. (The exact shape
 * balance.ts's legacy UNVERIFIED_FALLBACK_TAX_PROFILE carried.)
 */
export function unverifiedForeignFallbackProfile(): TaxProfileOfRecord {
  return {
    identityKey: '',
    tinVerified: false,
    w9OnFile: false,
    tinStatus: 'UNSUBMITTED',
    formType: 'W8_BEN',
    countryCode: null,
    usResident: false,
    treatyClaimActive: false,
    backupWithholdingRequired: false,
    taxIdentifierEncrypted: '',
    source: 'fail_closed_default',
  };
}

/**
 * Propagate the server's verification of record (R1) onto any adapted
 * profile — UPGRADE-ONLY. A server-verified row (tin_verified AND w9_on_file)
 * lifts the profile to VERIFIED so every consumer that passes the row
 * through sees the operator's verification; an R1 row that is NOT verified
 * never downgrades another registry's record (the dev-seed's demo creator
 * is R1-unverified while R2-verified by design — cross-registry downgrades
 * would rewrite the frozen demo money story).
 */
export function withServerVerification(
  profile: TaxProfileOfRecord,
  creatorProfile: CreatorTaxProfileShape | undefined,
): TaxProfileOfRecord {
  if (!creatorProfile) return profile;
  if (creatorProfile.tin_verified !== 1 || creatorProfile.w9_on_file !== 1) return profile;
  if (profile.tinStatus === 'VERIFIED' && profile.tinVerified && profile.w9OnFile) return profile;
  return { ...profile, tinStatus: 'VERIFIED', tinVerified: true, w9OnFile: true };
}

/** Back-projection: the founder engine's classification → the vendored form vocabulary. */
const ENGINE_FORM_BY_CLASSIFICATION: Record<TaxFormClassification, TaxProfile['taxFormType']> = {
  '1099_MISC': 'W9_US_PERSON',
  '1099_NEC': 'W9_US_PERSON',
  W8_BEN: 'W8BEN_FOREIGN_INDIVIDUAL',
  W8_BEN_E: 'W8BEN_E_FOREIGN_ENTITY',
  EXEMPT_CORPORATE: 'EXEMPT',
};

/**
 * The vendored engine's TaxProfile projection — the shape
 * CovenantTaxEngine.calculateEffectiveTaxRate reads. The calculator never
 * reads the form type, but the type requires it, so the classification
 * back-projects; the verification and residency fields are the semantic
 * payload.
 */
export function toEngineTaxProfile(
  profile: TaxProfileOfRecord,
  taxIdentifierEncrypted = '',
): TaxProfile {
  return {
    taxFormType: ENGINE_FORM_BY_CLASSIFICATION[profile.formType],
    taxIdentifierEncrypted: profile.taxIdentifierEncrypted ?? taxIdentifierEncrypted,
    usTaxResident: profile.usResident,
    ...(profile.countryCode !== null && profile.treatyClaimActive
      ? { treatyCountryCode: profile.countryCode }
      : {}),
    ...(profile.treatyWithholdingRate !== undefined
      ? { treatyWithholdingRate: profile.treatyWithholdingRate }
      : {}),
    isBackupWithholdingRequired: profile.backupWithholdingRequired,
    isVerified: profile.tinStatus === 'VERIFIED',
  };
}

/**
 * THE withholding rate of record for an adapted profile on US territory —
 * the vendored engine's locked calculation, reached through ONE projection
 * so every consumer (escrow balances, registrations, audits) resolves the
 * same rate from the same record.
 */
export function effectiveWithholdingRateOf(profile: TaxProfileOfRecord): number {
  return CovenantTaxEngine.calculateEffectiveTaxRate(toEngineTaxProfile(profile), 'US');
}

/**
 * The founder engine's PayeeTaxProfile projection — the shape the admin
 * Tax tab's fold resolves payouts through. A profile with no country of
 * record folds as US-reporting (the fail-closed default's own state).
 */
export function toPayeeTaxProfile(
  profile: TaxProfileOfRecord,
  payeeId: string,
  payeeName: string,
  ytdClearedGrossUSD: number,
): PayeeTaxProfile {
  return {
    payeeId,
    payeeName,
    countryCode: profile.countryCode ?? 'US',
    ...(profile.stateJurisdiction !== undefined
      ? { stateJurisdiction: profile.stateJurisdiction }
      : {}),
    tinStatus: profile.tinStatus,
    formType: profile.formType,
    usResident: profile.usResident,
    treatyClaimActive: profile.treatyClaimActive,
    ytdClearedGrossUSD,
  };
}
