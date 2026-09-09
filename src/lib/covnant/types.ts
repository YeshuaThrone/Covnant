/**
 * Covnant signup domain types — the creator payload the signup API accepts,
 * the profile row it persists, and the auth shapes it discloses.
 *
 * Brand-exact naming from birth: every Covnant-spelled identifier is new
 * code introduced by the signup merge (the drop's Covenant-spelled names,
 * brand-corrected so the sweep never has to churn them). CreatorProfile
 * carries no brand word and keeps its name.
 */

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

/** One row of the creator_profiles table (migration 0003). */
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
