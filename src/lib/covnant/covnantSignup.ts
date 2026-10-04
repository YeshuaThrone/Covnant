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

/**
 * SignUp failure classification (pure). The documented GoTrue hazard
 * (2026-09-27 production canon, retained): an exhausted built-in SMTP quota
 * surfaces as a misleading 400 "Email address ... is invalid". The payload's
 * email was already format-validated (signupValidation.ts), so that message
 * at this point is the masked mailer failure — a fail-closed, clean-retry
 * 503, never the line a visitor would read as "my email is wrong". An
 * explicit rate-limit message maps to the 429; anything else stays the
 * sanitized 400 auth_signup_failed. Per the founder's directive, quota
 * exhaustion is REPORTED (the retry + resend path) — never papered over by
 * wiring a third-party SMTP service (external email needs founder approval).
 */
export function signupAuthError(
  rawMessage: string | undefined,
): CovnantSignupFailure {
  const message = (rawMessage ?? "").toLowerCase();
  if (message.includes("email address") && message.includes("invalid")) {
    return {
      ok: false,
      status: 503,
      code: "email_send_failed",
      message:
        "We could not send the confirmation email right now — submit again in a minute.",
    };
  }
  if (
    message.includes("rate limit") ||
    message.includes("once every") ||
    message.includes("too many requests")
  ) {
    return {
      ok: false,
      status: 429,
      code: "email_send_rate_limited",
      message:
        "A confirmation email was requested too soon — wait a minute and submit again.",
    };
  }
  return {
    ok: false,
    status: 400,
    code: "auth_signup_failed",
    message: rawMessage || "Unable to create credentials.",
  };
}

export async function registerCovnantCreator(
  payload: CovnantSignupInput,
  clients: CovnantAuthClients,
  now: () => Date = () => new Date(),
): Promise<CovnantSignupResult> {
  // Sign up through the PUBLIC anon-key auth API so Supabase dispatches the
  // confirmation email — the founder's active verification path (directive
  // 2026-10-02: a signup is verified by EMAIL; Textbee/SMS is parked). With
  // Confirm-email enabled the user is born UNCONFIRMED and data.session is
  // null: the only session path is the confirmation link completing at
  // /auth/callback (the route that owns session establishment).
  //
  // This SUPERSEDES the 2026-09-27 admin.createUser(email_confirm: true)
  // decision, which minted confirmed-at-birth users and sent no email. Its
  // retired rationale — the built-in SMTP quota (a few sends/hour) throttling
  // signup and magic-link logins to a standstill — is accepted anew under
  // the founder's directive: if the quota blocks a real send, that is
  // reported (signupAuthError's fail-closed 503/429 + the resend endpoint),
  // never worked around with external SMTP infrastructure.
  const { data, error } = await clients.auth.auth.signUp({
    email: payload.email,
    password: payload.password,
    options: {
      data: {
        stage_name: payload.stage_name,
        legal_name: payload.legal_name,
        core_industry: payload.core_industry,
        title: payload.title,
        phone: payload.phone,
      },
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
    return signupAuthError(error.message);
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
      // The 201 envelope is sessionless by contract (the seal renders
      // sessionless: true): with Confirm-email on, signUp returns no session,
      // and even where Supabase would autoconfirm, the envelope stays null —
      // the creator establishes their session through the confirmation link
      // completing at /auth/callback, never through the signup response.
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
