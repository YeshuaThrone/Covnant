/**
 * Admin console domain types — the creator_profiles row (0003 identity +
 * 0004 compliance), the compliance mutation's validated patch, and the
 * shared store result envelope.
 *
 * The 0004 enum domains exist ONLY as column comments in the database (no
 * CHECK constraints) — the APP enforces them. KYC_STATUSES and
 * TAX_FORM_TYPES below are the enforced domains, validated server-side
 * before any write reaches the table. They are deliberately defined here
 * rather than reused from elsewhere: src/lib/splits/shared.ts carries the
 * ENGINE's display enum (W9_US_PERSON, W8BEN_FOREIGN_INDIVIDUAL, …), not
 * the storage domain the 0004 comments pin (W9 / W8BEN / EIN).
 */

import type { CreatorProfile } from '@/lib/covnant/types';

/** kyc_status domain — migration 0004's column comment. */
export const KYC_STATUSES = [
  'PENDING_INITIALIZATION',
  'PENDING',
  'VERIFIED',
  'REJECTED',
] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

/** tax_form_type domain — migration 0004's column comment. */
export const TAX_FORM_TYPES = ['W9', 'W8BEN', 'EIN'] as const;
export type TaxFormType = (typeof TAX_FORM_TYPES)[number];

/**
 * The admin console's view of a creator_profiles row — derived from PR D's
 * CreatorProfile (src/lib/covnant/types.ts, migrations 0003 + 0004) with the
 * compliance columns narrowed to the enforced domains above. Members are
 * required (unlike CreatorProfile's optional 0004 members) because the admin
 * reads full rows service-role, so every column is always present.
 *
 * The 0004 columns are nullable in the database (defaults apply on insert
 * omission; NULL is possible only from hand-crafted rows), so they are typed
 * honestly nullable here instead of hidden behind non-null lies.
 */
export type AdminCreatorProfile = Omit<
  CreatorProfile,
  'title' | 'kyc_status' | 'tax_form_type' | 'tax_verified' | 'created_at'
> & {
  created_at: string;
  /**
   * Honest nullability: 0003 defines title as a nullable column (signup
   * always writes one, but hand-crafted rows need not) — the console reads
   * ALL rows, so the admin type keeps the database's optionality even
   * though CreatorProfile (signup/self-view) surfaces title as string.
   */
  title: string | null;
  // 0004 compliance columns — defaults PENDING_INITIALIZATION / W9 / false / false.
  kyc_status: KycStatus | null;
  tax_form_type: TaxFormType | null;
  tax_verified: boolean | null;
  /**
   * Read-only by design: real linkage flows through Increase/Plaid — a manual
   * flip would make the flag lie about whether a linked account exists.
   */
  bank_account_linked: boolean | null;
};

/**
 * The compliance fields an admin may edit in v1 — everything else on the row
 * (identity, email, terms timestamp, bank linkage, ids) is read-only.
 */
export type CreatorCompliancePatch = {
  kyc_status?: KycStatus;
  tax_form_type?: TaxFormType;
  tax_verified?: boolean;
};

/** Field-level before/after for the action log's `changes` column. */
export type AdminActionChanges = Record<string, { from: unknown; to: unknown }>;

/** Shared store failure — sanitized, route-ready (never a thrown error). */
export type AdminStoreFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type AdminStoreResult<T> = { ok: true; value: T } | AdminStoreFailure;
