/**
 * Covnant signup domain types — the creator payload the signup API accepts,
 * the profile row it persists, and the auth shapes it discloses.
 *
 * Brand-exact naming from birth: every Covnant-spelled identifier is new
 * code introduced by the signup merge (the drop's Covenant-spelled names,
 * brand-corrected so the sweep never has to churn them). CreatorProfile
 * carries no brand word and keeps its name.
 */

import type { SignupEngine } from '@/lib/covnant/uct';

/** The validated signup request payload (password never leaves the API). */
export type CovnantSignupInput = {
  stage_name: string;
  legal_name: string;
  email: string;
  phone: string | null;
  core_industry: string;
  title: string;
  password: string;
  udr_terms_accepted: boolean;
};

/**
 * One row of the creator_profiles table (migrations 0003 + 0004).
 */
export type CreatorProfile = {
  id: string;
  stage_name: string;
  legal_name: string;
  email: string;
  phone: string | null;
  phone_verified_at: string | null;
  core_industry: string;
  title: string;
  udr_terms_accepted_at: string;
  /**
   * Compliance columns (migration 0004): nullable with backfilled defaults —
   * kyc_status 'PENDING_INITIALIZATION', tax_form_type 'W9', both booleans
   * false. Optional members because the signup 201's profile select predates
   * 0004 and omits them; GET /api/covnant/me always surfaces them.
   */
  kyc_status?: string | null;
  tax_form_type?: string | null;
  tax_verified?: boolean | null;
  bank_account_linked?: boolean | null;
  /** Row creation timestamp (default now()). Same optional-member rule. */
  created_at?: string | null;
};

/** The auth-user fields disclosed by the signup response. */
export type CovnantAuthUser = {
  id: string;
  email: string | null;
  email_confirmed_at: string | null;
};

/**
 * The session state disclosed by the signup response. Nullable by design:
 * null when Supabase "Confirm email" is enabled — the account exists but is
 * unconfirmed, so there is no session to hand back ("check your inbox").
 */
export type CovnantSessionState = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number | null;
  token_type: string;
  user: CovnantAuthUser;
};

/**
 * The auth core's success value. The drop's redundant `success: true` flag
 * is omitted by ruling — the response envelope's `ok: true` already says it.
 */
export type CovnantSignupSuccess = {
  session: CovnantSessionState | null;
  user: CovnantAuthUser;
  profile: CreatorProfile;
};

/**
 * The session owner's UCT identity block of GET /api/covnant/me — the minted
 * creator-root identity and its immutable issuance facts, resolved strictly
 * from the session email's CBT-SIGNUP-REGISTRY holder entry.
 */
export type CovnantMeIdentity = {
  uct: string;
  uctCreatedAt: string;
  jurisdiction: string;
  engine?: SignupEngine;
};

/** Provisioning state of the holder's Increase virtual account — status ONLY. */
export type CovnantMeProvisioning = {
  status: 'PROVISIONED' | 'PENDING';
  reason?: string;
};

/**
 * Per-holder escrow totals — BigInt smallest-unit strings (1e-8 scale, the
 * ledger's numeric(20,8) columns), the SAME shared-helper math
 * /api/artist/dashboard uses so the surfaces can never disagree.
 */
export type CovnantMeSettlements = {
  grossEarnings: string;
  taxWithheld: string;
  availableEscrowBalance: string;
  isTaxVerified: boolean;
};

/** The GET /api/covnant/me 200 aggregate — composed from the verified session only. */
export type CovnantMeResponse = {
  profile: CreatorProfile;
  identity: CovnantMeIdentity;
  role: string;
  provisioning: CovnantMeProvisioning;
  settlements: CovnantMeSettlements;
};
