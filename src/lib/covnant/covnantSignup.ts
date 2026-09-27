/**
 * The signup auth core — Supabase Auth signUp + creator_profiles insert,
 * with best-effort compensation. Brand-spelled from birth
 * (registerCovnantCreator — the drop's Covenant-spelled name, corrected).
 *
 * The core knows nothing about the registry/UCT pipeline: callers pass the
 * auth + admin clients, and the route layers the preserved registry
 * transaction and provisioning trigger around it. The route OWNS the
 * ordering invariant (registry checked BEFORE signUp) and the compensation
 * invariant for failures in the stages after this core.
 *
 * Duplicate detection uses BOTH Supabase signals: an error message saying
 * the account already exists, and the anti-enumeration response shape (a
 * user with zero identities) that Supabase returns instead of an error.
 */

import type { SupabaseClient, User } from "@supabase/supabase-js";
import type {
  CovnantSignupInput,
  CovnantSignupSuccess,
  CreatorProfile,
} from "@/lib/covnant/types";

export type CovnantSignupFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type CovnantSignupResult =
  { ok: true; value: CovnantSignupSuccess } | CovnantSignupFailure;

export type CovnantAuthClients = {
  auth: SupabaseClient;
  admin: SupabaseClient;
};

function isDuplicateSignup(
  user: User | null,
  errorMessage: string | undefined,
): boolean {
  const message = (errorMessage ?? "").toLowerCase();
  if (
    message.includes("already registered") ||
    message.includes("already exists")
  ) {
    return true;
  }
  if (user === null) {
    return false;
  }
  return Array.isArray(user.identities) && user.identities.length === 0;
}

function toAuthUser(user: User) {
  return {
    id: user.id,
    email: user.email ?? null,
    email_confirmed_at: user.email_confirmed_at ?? null,
  };
}

function profileRow(
  userId: string,
  payload: CovnantSignupInput,
  acceptedAt: string,
) {
  return {
    id: userId,
    stage_name: payload.stage_name,
    legal_name: payload.legal_name,
    email: payload.email,
    phone: payload.phone,
    phone_verified_at: null,
    core_industry: payload.core_industry,
    title: payload.title,
    udr_terms_accepted_at: acceptedAt,
  };
}

export async function registerCovnantCreator(
  payload: CovnantSignupInput,
  clients: CovnantAuthClients,
  now: () => Date = () => new Date(),
): Promise<CovnantSignupResult> {
  // Provision through the SERVICE-ROLE admin API, not the public signUp:
  // public signUp forces a confirmation-email send per registration, and the
  // project's built-in SMTP quota (a few sends/hour) throttles both signup
  // AND magic-link logins to a standstill. Admin creation mints the user
  // directly (no email send, no shared-quota dependency); the email is
  // marked confirmed at birth and verification happens at login time via
  // the magic-link flow the app already uses.
  const { data, error } = await clients.admin.auth.admin.createUser({
    email: payload.email,
    password: payload.password,
    email_confirm: true,
    user_metadata: {
      stage_name: payload.stage_name,
      legal_name: payload.legal_name,
      core_industry: payload.core_industry,
      title: payload.title,
      phone: payload.phone,
    },
  });

  const user = data?.user ?? null;

  if (isDuplicateSignup(user, error?.message)) {
    return {
      ok: false,
      status: 409,
      code: "duplicate_email",
      message: "An account with this email already exists.",
    };
  }

  if (error) {
    return {
      ok: false,
      status: 400,
      code: "auth_signup_failed",
      message: error.message || "Unable to create credentials.",
    };
  }

  if (user === null) {
    return {
      ok: false,
      status: 502,
      code: "auth_signup_failed",
      message: "Supabase Auth did not return a user.",
    };
  }

  const acceptedAt = now().toISOString();
  const row = profileRow(user.id, payload, acceptedAt);

  const inserted = await clients.admin
    .from("creator_profiles")
    .insert(row)
    .select(
      "id, stage_name, legal_name, email, phone, phone_verified_at, core_industry, title, udr_terms_accepted_at",
    )
    .single();

  if (inserted.error || inserted.data === null) {
    await compensateCovnantSignup(
      clients.admin,
      user.id,
      "profile_insert_failed",
    );
    console.error("Failed to insert creator_profiles:", inserted.error);
    return {
      ok: false,
      status: 500,
      code: "profile_insert_failed",
      message: "Failed to persist the creator profile.",
    };
  }

  const profile = inserted.data as CreatorProfile;
  return {
    ok: true,
    value: {
      // Admin creation returns no session — the 201 envelope is sessionless
      // by contract (the seal renders sessionless: true) and the creator
      // establishes their session through the email-link login flow.
      session: null,
      user: toAuthUser(user),
      profile: {
        ...profile,
        phone_verified_at: null,
      },
    },
  };
}

/**
 * Best-effort compensation: delete the creator_profiles row, then the auth
 * user. creator_profiles.id references auth.users ON DELETE CASCADE, so the
 * user delete alone would suffice — both run explicitly per the
 * compensation invariant, and a failed step is logged, never thrown: a
 * failed compensation leaves a recoverable state (a later signup either
 * re-claims the holder or re-runs compensation) and is visible server-side.
 */
export async function compensateCovnantSignup(
  admin: SupabaseClient,
  userId: string,
  cause: string,
): Promise<void> {
  const { error: profileError } = await admin
    .from("creator_profiles")
    .delete()
    .eq("id", userId);
  if (profileError) {
    console.error(
      `Signup compensation (${cause}) failed to delete the creator_profiles row:`,
      profileError,
    );
  }
  const { error: userError } = await admin.auth.admin.deleteUser(userId);
  if (userError) {
    console.error(
      `Signup compensation (${cause}) failed to delete the auth user:`,
      userError,
    );
  }
}
