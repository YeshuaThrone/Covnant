import { describe, expect, it } from "vitest";
import {
  ASSET_VERTICALS,
  evaluatePayoutCompliance,
  getVerticalComplianceStateSource,
  setVerticalComplianceStateSource,
  type LivestreamComplianceState,
  type NilComplianceState,
  type VerticalComplianceState,
} from "../payoutGate";
import type { KycStatus } from "@/lib/don/types";

/**
 * Payout compliance gate — fail-closed contract across all conditions:
 * operator settlement approval, Plaid-backed KYC, and the per-vertical
 * family. The founder canon is "never default to allowing" — so every test
 * flips ONE condition false (or drops it entirely) and expects a NAMED
 * structured refusal, and only a fully-satisfied explicit-true state pays.
 */

const APPROVED_VERIFIED = {
  operatorSettlementApproved: true,
  kycStatus: "verified" as KycStatus,
};

/** A state where every condition of the vertical is explicitly true. */
const ALL_SATISFIED: Record<string, VerticalComplianceState> = {
  music: { vertical: "music", rights_separation_settled: true },
  film: {
    vertical: "film",
    cama_escrow_released: true,
    guild_residual_holdback_satisfied: true,
  },
  podcast: {
    vertical: "podcast",
    iab_ad_impression_verified: true,
    network_commission_deducted: true,
  },
  gaming: {
    vertical: "gaming",
    platform_commission_deducted: true,
    studio_kyc_verified: true,
    team_member_checks: [
      { member_ref: "member_a", identity_check_passed: true },
      { member_ref: "member_b", identity_check_passed: true },
    ],
  },
  livestream: {
    vertical: "livestream",
    stream_platform_payout_reconciled: true,
    tax_withholding_verified: true,
  },
  publishing: {
    vertical: "publishing",
    ip_rights_cleared: true,
    return_reserve_period_elapsed: true,
    isbn_rights_verified: true,
  },
  merch: { vertical: "merch", physical_fulfillment_confirmed: true },
  ai: {
    vertical: "ai",
    ai_training_consent_verified: true,
    synthetic_voice_likeness_released: true,
  },
  art: { vertical: "art", estate_succession_verified: true },
  theater: {
    vertical: "theater",
    grand_rights_cleared: true,
    venue_settlement_reconciled: true,
  },
  licensing: {
    vertical: "licensing",
    territory_cleared: true,
    category_exclusivity_verified: true,
  },
  // A direct (unassociated) NIL deal: cap check skipped via explicit false.
  nil: {
    vertical: "nil",
    nil_cleared: true,
    compliance_verified: true,
    title_ix_proportionality_cleared: true,
    collective_or_booster_backed: false,
    institutional_cap_verified: false,
  },
  spatial: {
    vertical: "spatial",
    territorial_zoning_cleared: true,
    spatial_audit_verified: true,
  },
  fitness: {
    vertical: "fitness",
    hipaa_gdpr_privacy_cleared: true,
    territorial_studio_exclusivity_verified: true,
  },
  culinary: {
    vertical: "culinary",
    health_inspection_cleared: true,
    territorial_kitchen_exclusivity_verified: true,
  },
  services: {
    vertical: "services",
    health_board_license_verified: true,
    territorial_franchise_exclusivity_verified: true,
  },
  software: {
    vertical: "software",
    api_uptime_sla_verified: true,
    software_security_audit_cleared: true,
  },
  hardware: {
    vertical: "hardware",
    frand_rate_court_determination_cleared: true,
    sep_essentiality_audit_verified: true,
  },
  resource: {
    vertical: "resource",
    environmental_compliance_cleared: true,
    title_ownership_verification_passed: true,
  },
  sports: {
    vertical: "sports",
    event_completion_telemetry_verified: true,
    promoter_insurance_clearance: true,
    is_collegiate_nil_waterfall: false,
  },
  sportsCollegiateNil: {
    vertical: "sports",
    event_completion_telemetry_verified: true,
    promoter_insurance_clearance: true,
    is_collegiate_nil_waterfall: true,
    nil_compliance_audit_cleared: true,
  },
};

describe("payoutGate — common conditions", () => {
  it("refuses when operator settlement approval is missing", () => {
    const verdict = evaluatePayoutCompliance({
      operatorSettlementApproved: false,
      kycStatus: "verified",
      verticalState: ALL_SATISFIED.music,
    });
    expect(verdict).toMatchObject({ ok: false, code: "settlement_not_approved" });
  });

  it("refuses with kyc_state_unknown when the creator has no KYC record", () => {
    const verdict = evaluatePayoutCompliance({
      ...APPROVED_VERIFIED,
      kycStatus: null,
      verticalState: ALL_SATISFIED.music,
    });
    expect(verdict).toMatchObject({ ok: false, code: "kyc_state_unknown" });
  });

  it("refuses when KYC is not verified", () => {
    const verdict = evaluatePayoutCompliance({
      ...APPROVED_VERIFIED,
      kycStatus: "pending" as KycStatus,
      verticalState: ALL_SATISFIED.music,
    });
    expect(verdict).toMatchObject({ ok: false, code: "kyc_not_verified" });
  });

  it("refuses with vertical_state_unknown when no hold state exists for the pairing", () => {
    const verdict = evaluatePayoutCompliance({
      ...APPROVED_VERIFIED,
      verticalState: null,
    });
    expect(verdict).toMatchObject({ ok: false, code: "vertical_state_unknown" });
  });

  it("refuses when the default state source is used (recon has not populated state)", async () => {
    setVerticalComplianceStateSource(null);
    const source = getVerticalComplianceStateSource();
    const state = await source({ payeeId: "payee_1", vertical: "music" });
    expect(state).toBeNull();
  });

  it("covers exactly the twenty founder-directed verticals", () => {
    expect(ASSET_VERTICALS).toEqual([
      "music",
      "film",
      "podcast",
      "gaming",
      "livestream",
      "publishing",
      "merch",
      "ai",
      "art",
      "theater",
      "licensing",
      "nil",
      "spatial",
      "fitness",
      "culinary",
      "services",
      "software",
      "hardware",
      "resource",
      "sports",
    ]);
  });
});

// Every vertical must pay when fully satisfied and refuse with its NAMED
// code the moment any single condition is false.
const APPROVE_CASES: [string, VerticalComplianceState][] = Object.entries(
  ALL_SATISFIED,
);

const REFUSAL_CASES: { vertical: string; state: VerticalComplianceState; code: string }[] = [
  { vertical: "music", state: { vertical: "music", rights_separation_settled: false }, code: "music_rights_separation_unsettled" },
  { vertical: "film", state: { vertical: "film", cama_escrow_released: false, guild_residual_holdback_satisfied: true }, code: "film_cama_escrow_not_released" },
  { vertical: "film", state: { vertical: "film", cama_escrow_released: true, guild_residual_holdback_satisfied: false }, code: "film_guild_residual_holdback_not_satisfied" },
  { vertical: "podcast", state: { vertical: "podcast", iab_ad_impression_verified: false, network_commission_deducted: true }, code: "podcast_impression_verification_missing" },
  { vertical: "podcast", state: { vertical: "podcast", iab_ad_impression_verified: true, network_commission_deducted: false }, code: "podcast_network_commission_not_deducted" },
  { vertical: "gaming", state: { vertical: "gaming", platform_commission_deducted: false, studio_kyc_verified: true, team_member_checks: [] }, code: "gaming_platform_commission_not_deducted" },
  { vertical: "gaming", state: { vertical: "gaming", platform_commission_deducted: true, studio_kyc_verified: false, team_member_checks: [] }, code: "gaming_studio_kyc_not_verified" },
  { vertical: "livestream", state: { vertical: "livestream", stream_platform_payout_reconciled: false, tax_withholding_verified: true }, code: "livestream_payout_not_reconciled" },
  { vertical: "livestream", state: { vertical: "livestream", stream_platform_payout_reconciled: true, tax_withholding_verified: false }, code: "livestream_tax_withholding_unverified" },
  { vertical: "publishing", state: { vertical: "publishing", ip_rights_cleared: false, return_reserve_period_elapsed: true, isbn_rights_verified: true }, code: "publishing_ip_rights_not_cleared" },
  { vertical: "publishing", state: { vertical: "publishing", ip_rights_cleared: true, return_reserve_period_elapsed: false, isbn_rights_verified: true }, code: "publishing_return_reserve_not_elapsed" },
  { vertical: "publishing", state: { vertical: "publishing", ip_rights_cleared: true, return_reserve_period_elapsed: true, isbn_rights_verified: false }, code: "publishing_isbn_rights_unverified" },
  { vertical: "merch", state: { vertical: "merch", physical_fulfillment_confirmed: false }, code: "merch_fulfillment_unconfirmed" },
  { vertical: "ai", state: { vertical: "ai", ai_training_consent_verified: false, synthetic_voice_likeness_released: true }, code: "ai_training_consent_unverified" },
  { vertical: "ai", state: { vertical: "ai", ai_training_consent_verified: true, synthetic_voice_likeness_released: false }, code: "ai_voice_likeness_not_released" },
  { vertical: "art", state: { vertical: "art", estate_succession_verified: false }, code: "art_estate_succession_unverified" },
  { vertical: "theater", state: { vertical: "theater", grand_rights_cleared: false, venue_settlement_reconciled: true }, code: "theater_grand_rights_not_cleared" },
  { vertical: "theater", state: { vertical: "theater", grand_rights_cleared: true, venue_settlement_reconciled: false }, code: "theater_venue_settlement_unreconciled" },
  { vertical: "licensing", state: { vertical: "licensing", territory_cleared: false, category_exclusivity_verified: true }, code: "licensing_territory_not_cleared" },
  { vertical: "licensing", state: { vertical: "licensing", territory_cleared: true, category_exclusivity_verified: false }, code: "licensing_category_exclusivity_unverified" },
  { vertical: "nil", state: { vertical: "nil", nil_cleared: false, compliance_verified: true, title_ix_proportionality_cleared: true, collective_or_booster_backed: false, institutional_cap_verified: false }, code: "nil_not_cleared" },
  { vertical: "nil", state: { vertical: "nil", nil_cleared: true, compliance_verified: false, title_ix_proportionality_cleared: true, collective_or_booster_backed: false, institutional_cap_verified: false }, code: "nil_compliance_unverified" },
  { vertical: "nil", state: { vertical: "nil", nil_cleared: true, compliance_verified: true, title_ix_proportionality_cleared: false, collective_or_booster_backed: false, institutional_cap_verified: false }, code: "nil_title_ix_proportionality_not_cleared" },
  // The associated-entity holdback: collective-backed funds held without cap
  // verification. An UNKNOWN backing refuses too — the gate's `!== false`
  // check treats undefined backing as held (fail-closed).
  { vertical: "nil", state: { vertical: "nil", nil_cleared: true, compliance_verified: true, title_ix_proportionality_cleared: true, collective_or_booster_backed: true, institutional_cap_verified: false }, code: "nil_institutional_cap_unverified" },
  { vertical: "spatial", state: { vertical: "spatial", territorial_zoning_cleared: false, spatial_audit_verified: true }, code: "spatial_zoning_not_cleared" },
  { vertical: "spatial", state: { vertical: "spatial", territorial_zoning_cleared: true, spatial_audit_verified: false }, code: "spatial_audit_unverified" },
  { vertical: "fitness", state: { vertical: "fitness", hipaa_gdpr_privacy_cleared: false, territorial_studio_exclusivity_verified: true }, code: "fitness_privacy_not_cleared" },
  { vertical: "fitness", state: { vertical: "fitness", hipaa_gdpr_privacy_cleared: true, territorial_studio_exclusivity_verified: false }, code: "fitness_exclusivity_unverified" },
  { vertical: "culinary", state: { vertical: "culinary", health_inspection_cleared: false, territorial_kitchen_exclusivity_verified: true }, code: "culinary_inspection_not_cleared" },
  { vertical: "culinary", state: { vertical: "culinary", health_inspection_cleared: true, territorial_kitchen_exclusivity_verified: false }, code: "culinary_exclusivity_unverified" },
  { vertical: "services", state: { vertical: "services", health_board_license_verified: false, territorial_franchise_exclusivity_verified: true }, code: "services_license_not_verified" },
  { vertical: "services", state: { vertical: "services", health_board_license_verified: true, territorial_franchise_exclusivity_verified: false }, code: "services_exclusivity_unverified" },
  { vertical: "software", state: { vertical: "software", api_uptime_sla_verified: false, software_security_audit_cleared: true }, code: "software_uptime_sla_unverified" },
  { vertical: "software", state: { vertical: "software", api_uptime_sla_verified: true, software_security_audit_cleared: false }, code: "software_security_audit_not_cleared" },
  { vertical: "hardware", state: { vertical: "hardware", frand_rate_court_determination_cleared: false, sep_essentiality_audit_verified: true }, code: "hardware_frand_rate_not_cleared" },
  { vertical: "hardware", state: { vertical: "hardware", frand_rate_court_determination_cleared: true, sep_essentiality_audit_verified: false }, code: "hardware_essentiality_unverified" },
  { vertical: "resource", state: { vertical: "resource", environmental_compliance_cleared: false, title_ownership_verification_passed: true }, code: "resource_environmental_not_cleared" },
  { vertical: "resource", state: { vertical: "resource", environmental_compliance_cleared: true, title_ownership_verification_passed: false }, code: "resource_title_unverified" },
  { vertical: "sports", state: { vertical: "sports", event_completion_telemetry_verified: false, promoter_insurance_clearance: true, is_collegiate_nil_waterfall: false }, code: "sports_telemetry_unverified" },
  { vertical: "sports", state: { vertical: "sports", event_completion_telemetry_verified: true, promoter_insurance_clearance: false, is_collegiate_nil_waterfall: false }, code: "sports_insurance_not_cleared" },
  { vertical: "sports", state: { vertical: "sports", event_completion_telemetry_verified: true, promoter_insurance_clearance: true, is_collegiate_nil_waterfall: true, nil_compliance_audit_cleared: false }, code: "sports_nil_audit_not_cleared" },
  { vertical: "sports", state: { vertical: "sports", event_completion_telemetry_verified: true, promoter_insurance_clearance: true, is_collegiate_nil_waterfall: true }, code: "sports_nil_audit_not_cleared" },
];

describe("payoutGate — per-vertical families", () => {
  for (const [vertical, state] of APPROVE_CASES) {
    it(`allows a ${vertical} payout when every condition is explicitly true`, () => {
      const verdict = evaluatePayoutCompliance({
        ...APPROVED_VERIFIED,
        verticalState: state,
      });
      expect(verdict).toEqual({ ok: true });
    });
  }

  for (const { vertical, state, code } of REFUSAL_CASES) {
    it(`refuses a ${vertical} payout with ${code} (fail-closed)`, () => {
      const verdict = evaluatePayoutCompliance({
        ...APPROVED_VERIFIED,
        verticalState: state,
      });
      expect(verdict).toMatchObject({ ok: false, code });
    });
  }

  it("refuses gaming when ANY named team member fails identity checks (empty roster passes)", () => {
    const failingRoster: VerticalComplianceState = {
      vertical: "gaming",
      platform_commission_deducted: true,
      studio_kyc_verified: true,
      team_member_checks: [
        { member_ref: "member_a", identity_check_passed: true },
        { member_ref: "member_b", identity_check_passed: false },
      ],
    };
    const verdict = evaluatePayoutCompliance({
      ...APPROVED_VERIFIED,
      verticalState: failingRoster,
    });
    expect(verdict.ok).toBe(false);

    const emptyRoster: VerticalComplianceState = {
      vertical: "gaming",
      platform_commission_deducted: true,
      studio_kyc_verified: true,
      team_member_checks: [],
    };
    expect(
      evaluatePayoutCompliance({
        ...APPROVED_VERIFIED,
        verticalState: emptyRoster,
      }),
    ).toEqual({ ok: true });
  });

  it("allows a collective-backed NIL payout once the institutional cap is verified", () => {
    const collectiveState: NilComplianceState = {
      vertical: "nil",
      nil_cleared: true,
      compliance_verified: true,
      title_ix_proportionality_cleared: true,
      collective_or_booster_backed: true,
      institutional_cap_verified: true,
    };
    const verdict = evaluatePayoutCompliance({
      ...APPROVED_VERIFIED,
      verticalState: collectiveState,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it("keeps livestream tax withholding mandatory — the esports tournament case", () => {
    // The withholding verification is a single boolean the recon layer
    // populates; international tournament winnings are encoded there.
    const state: LivestreamComplianceState = {
      vertical: "livestream",
      stream_platform_payout_reconciled: true,
      tax_withholding_verified: false,
    };
    const verdict = evaluatePayoutCompliance({
      ...APPROVED_VERIFIED,
      verticalState: state,
    });
    expect(verdict).toMatchObject({
      ok: false,
      code: "livestream_tax_withholding_unverified",
    });
  });
});
