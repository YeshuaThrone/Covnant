// Gaming studio KYC — the studio-level verification state (PR 13, founder
// gaming directive).
//
// The gaming payout gate (payoutGate.ts, case "gaming") refuses a payout
// unless the vertical state carries platform_commission_deducted AND
// studio_kyc_verified AND every named team member's identity check passed.
// This module owns the DURABLE state behind that read:
//
//   - the record — one studio's verification: its own KYC status plus the
//     named roster (3D artist, developer, sound designer, ...) with each
//     member's identity-check outcome,
//   - the writer's validation — fail-closed, pure: a studio record exists
//     only with a non-empty payee id, a known KYC status, and a roster
//     that names at least one member with a non-empty ref and role,
//   - the derivation — the record maps onto the gate's exact
//     GamingComplianceState input (studio verified, members passed),
//   - the store-backed resolver — the function the ops/recon layer wires
//     into setVerticalComplianceStateSource for gaming reads; an absent
//     record derives null and the gate refuses (vertical_state_unknown).
//
// FAIL-CLOSED, the house discipline: no record, no state, no payout. An
// empty roster never passes a team gate by omission — the writer refuses
// to save a studio verification that names no members, because "covers
// every named team member" with zero named members is not a verification.
// A member with identity_check_passed false (or a re-verification that
// drops them from the roster) fails the gate the same way.

import type { Store } from "@/lib/server/store";
import type { GamingStudioKycRecord } from "@/modules/don/records";
import type { KycStatus } from "@/lib/don/types";
import { type GamingComplianceState } from "@/modules/compliance/payoutGate";

/** The writer's typed refusal — the gamingSplits / recon-engine shape. */
export type GamingStudioKycError = {
  ok: false;
  code: string;
  message: string;
};

function isKycStatus(status: unknown): status is KycStatus {
  return status === "pending" || status === "verified" || status === "failed";
}

/**
 * Validates one studio KYC verification before the store saves it.
 * Returns the typed error on any violation; the record saves only through
 * a validate-then-write pass. Pure.
 */
export function validateGamingStudioKyc(
  input: Omit<GamingStudioKycRecord, "id">,
): GamingStudioKycError | { ok: true; record: Omit<GamingStudioKycRecord, "id"> } {
  if (typeof input.studio_payee_id !== "string" || input.studio_payee_id.trim() === "") {
    return {
      ok: false,
      code: "gaming_studio_kyc_invalid",
      message: "A studio KYC verification names its studio payee (non-empty studio_payee_id).",
    };
  }
  if (!isKycStatus(input.studio_kyc_status)) {
    return {
      ok: false,
      code: "gaming_studio_kyc_invalid",
      message: `Studio KYC status "${String(input.studio_kyc_status)}" is not one of the Don KYC statuses (pending | verified | failed).`,
    };
  }
  if (!Array.isArray(input.team_members) || input.team_members.length === 0) {
    return {
      ok: false,
      code: "gaming_studio_kyc_roster_empty",
      message:
        "A studio KYC verification covers every named team member — an empty roster is not a verification. Name the roster (3D artist, developer, sound designer, ...).",
    };
  }
  const seenRefs = new Set<string>();
  for (const member of input.team_members) {
    if (typeof member.member_ref !== "string" || member.member_ref.trim() === "") {
      return {
        ok: false,
        code: "gaming_studio_kyc_invalid",
        message: "Every named team member carries a non-empty member_ref.",
      };
    }
    if (seenRefs.has(member.member_ref)) {
      return {
        ok: false,
        code: "gaming_studio_kyc_invalid",
        message: `Team member "${member.member_ref}" appears twice in the roster.`,
      };
    }
    seenRefs.add(member.member_ref);
    if (typeof member.role !== "string" || member.role.trim() === "") {
      return {
        ok: false,
        code: "gaming_studio_kyc_invalid",
        message: `Team member "${member.member_ref}" carries a non-empty role.`,
      };
    }
    if (typeof member.identity_check_passed !== "boolean") {
      return {
        ok: false,
        code: "gaming_studio_kyc_invalid",
        message: `Team member "${member.member_ref}" identity check must be an explicit boolean — unknown refuses at the gate.`,
      };
    }
  }
  return {
    ok: true,
    record: {
      ...input,
      team_members: input.team_members.map((member) => ({ ...member })),
    },
  };
}

/**
 * Derives the gaming vertical compliance state ONE studio record feeds the
 * payout gate — the gate's exact input shape. The studio's KYC is verified
 * only when the record says so explicitly; every named member's identity
 * check rides the roster verbatim. Pure.
 */
export function gamingComplianceStateFromStudioKyc(
  record: GamingStudioKycRecord,
  input: {
    /** Whether the platform commission was deducted for the payout's period. */
    platformCommissionDeducted: boolean;
  },
): GamingComplianceState {
  return {
    vertical: "gaming",
    platform_commission_deducted: input.platformCommissionDeducted === true,
    studio_kyc_verified: record.studio_kyc_status === "verified",
    team_member_checks: record.team_members.map((member) => ({
      member_ref: member.member_ref,
      identity_check_passed: member.identity_check_passed === true,
    })),
  };
}

/**
 * The store-backed resolver the gaming payout gate reads. Loads the
 * studio's verification by payee id and derives the gate's vertical state;
 * an absent record derives null — the gate then refuses with
 * `vertical_state_unknown`, never assuming verified. The caller supplies
 * the platform-commission fact (the recon layer's deduction record); it
 * defaults to false so an unset fact refuses, never allows.
 */
export async function resolveGamingVerticalComplianceState(
  store: Store,
  studioPayeeId: string,
  platformCommissionDeducted: boolean = false,
): Promise<GamingComplianceState | null> {
  const record = await store.getGamingStudioKyc(studioPayeeId);
  if (record === undefined) return null;
  return gamingComplianceStateFromStudioKyc(record, { platformCommissionDeducted });
}
