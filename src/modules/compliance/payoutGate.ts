import type { Store } from "@/lib/server/store";
import type { KycStatus } from "@/lib/don/types";
import type {
  AiPayoutGateStateRecord,
  EstatePayoutGateStateRecord,
  TheatricalPayoutGateStateRecord,
} from "@/modules/don/records";
import type { FitnessPayoutGateStateRecord } from "@/modules/fitness/records";
import type { CulinaryPayoutGateStateRecord } from "@/modules/culinary/records";
import type { ServicesPayoutGateStateRecord } from "@/modules/service/records";
import type { LicensingPayoutGateStateRecord } from "@/modules/licensing/records";
import type { NilPayoutGateStateRecord } from "@/modules/nil/records";
import type { SpatialPayoutGateStateRecord } from "@/modules/spatial/records";

/**
 * Payout compliance gate — the fail-closed v1 gate for every Lithic ACH
 * dispatch and Gold Note Card issuance (founder directives, 2026-09-30).
 *
 * Universal conditions:
 *   1. operator_settlement_approved is true, AND
 *   2. the target creator's KYC status is VERIFIED (resolved from the
 *      Plaid-backed verification ledger — absent records are unknown), AND
 *   3. the vertical compliance state is present.
 *
 * Per-vertical gate families (absent or unknown refuses, always):
 *   music       rights_separation_settled (MASTER or PUBLISHING resolved,
 *               nothing quarantined unresolved)
 *   film        cama_escrow_released AND guild_residual_holdback_satisfied
 *   podcast     iab_ad_impression_verified AND network_commission_deducted
 *   gaming      platform_commission_deducted AND studio_kyc_verified AND
 *               every named team member passing identity checks
 *   livestream  stream_platform_payout_reconciled AND
 *               tax_withholding_verified (withholding evidence is mandatory
 *               for international esports tournament winnings — the recon
 *               layer encodes that when populating the boolean)
 *   publishing  ip_rights_cleared AND (print books)
 *               return_reserve_period_elapsed AND isbn_rights_verified
 *   merch       physical_fulfillment_confirmed (tracking delivered) — note
 *               dispatch only ever releases non-reserve (available) funds;
 *               the vault hold never touches reserve_balance
 *   ai          ai_training_consent_verified AND
 *               synthetic_voice_likeness_released
 *   art         estate_succession_verified (a validated legal certificate
 *               must exist before dispatch to the estate or multi-heir
 *               waterfall)
 *   theater     grand_rights_cleared AND venue_settlement_reconciled
 *               (theatrical and live-comedy productions)
 *   licensing   territory_cleared AND category_exclusivity_verified
 *               (brand licensing payouts)
 *   nil         nil_cleared AND compliance_verified AND
 *               title_ix_proportionality_cleared — plus the
 *               associated-entity holdback: collective or booster-backed
 *               funds stay held until institutional cap verification
 *               (an UNKNOWN backing also refuses; only an explicit false —
 *               a direct, unassociated deal — skips the cap check)
 *   spatial     territorial_zoning_cleared AND spatial_audit_verified
 *               (spatial and location-based entertainment payouts)
 *   fitness     hipaa_gdpr_privacy_cleared AND
 *               territorial_studio_exclusivity_verified (fitness payouts —
 *               workout telemetry privacy and studio franchise exclusivity)
 *   culinary    health_inspection_cleared AND
 *               territorial_kitchen_exclusivity_verified (culinary and
 *               ghost-kitchen payouts — health inspection and kitchen
 *               franchise exclusivity)
 *   services    health_board_license_verified AND
 *               territorial_franchise_exclusivity_verified (salon, med-spa,
 *               and hospitality franchise payouts — health board licensing
 *               and franchise exclusivity)
 *   software    api_uptime_sla_verified AND
 *               software_security_audit_cleared (developer-tools payouts —
 *               API uptime SLA and security audit)
 *   hardware    frand_rate_court_determination_cleared AND
 *               sep_essentiality_audit_verified (hardware patent payouts —
 *               FRAND rate court determination and SEP essentiality audit)
 *   resource    environmental_compliance_cleared AND
 *               title_ownership_verification_passed (energy and resource
 *               payouts — environmental compliance and title ownership)
 *   sports      event_completion_telemetry_verified AND
 *               promoter_insurance_clearance (sports gate and ticketing
 *               payouts — event completion telemetry and promoter
 *               insurance); collegiate NIL waterfall disbursements
 *               additionally require nil_compliance_audit_cleared
 *
 * The vertical state is read through the seam the recon layer populates
 * (settlement/compliance hold state per payee and vertical). Until that
 * lands, the default source returns null and every dispatch refuses — the
 * gate NEVER defaults to allowing.
 */

export const ASSET_VERTICALS = [
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
] as const;

export type AssetVertical = (typeof ASSET_VERTICALS)[number];

export type MusicComplianceState = {
  vertical: "music";
  rights_separation_settled: boolean;
};

export type FilmComplianceState = {
  vertical: "film";
  cama_escrow_released: boolean;
  guild_residual_holdback_satisfied: boolean;
};

export type PodcastComplianceState = {
  vertical: "podcast";
  iab_ad_impression_verified: boolean;
  network_commission_deducted: boolean;
};

/** One named team member's identity check (gaming vertical). */
export type GamingTeamMemberCheck = {
  member_ref: string;
  identity_check_passed: boolean;
};

export type GamingComplianceState = {
  vertical: "gaming";
  platform_commission_deducted: boolean;
  studio_kyc_verified: boolean;
  team_member_checks: GamingTeamMemberCheck[];
};

export type LivestreamComplianceState = {
  vertical: "livestream";
  stream_platform_payout_reconciled: boolean;
  tax_withholding_verified: boolean;
};

export type PublishingComplianceState = {
  vertical: "publishing";
  ip_rights_cleared: boolean;
  /** Print-book payouts: the book-return reserve period must have elapsed. */
  return_reserve_period_elapsed: boolean;
  isbn_rights_verified: boolean;
};

export type MerchComplianceState = {
  vertical: "merch";
  physical_fulfillment_confirmed: boolean;
};

export type AiComplianceState = {
  vertical: "ai";
  ai_training_consent_verified: boolean;
  synthetic_voice_likeness_released: boolean;
};

export type ArtComplianceState = {
  vertical: "art";
  estate_succession_verified: boolean;
};

export type TheaterComplianceState = {
  vertical: "theater";
  grand_rights_cleared: boolean;
  venue_settlement_reconciled: boolean;
};

export type LicensingComplianceState = {
  vertical: "licensing";
  territory_cleared: boolean;
  category_exclusivity_verified: boolean;
};

export type NilComplianceState = {
  vertical: "nil";
  nil_cleared: boolean;
  compliance_verified: boolean;
  title_ix_proportionality_cleared: boolean;
  /** True when the funds come from a collective or booster-backed pool. */
  collective_or_booster_backed: boolean;
  /** Required before release when collective_or_booster_backed is true. */
  institutional_cap_verified: boolean;
};

export type SpatialComplianceState = {
  vertical: "spatial";
  territorial_zoning_cleared: boolean;
  spatial_audit_verified: boolean;
};

export type FitnessComplianceState = {
  vertical: "fitness";
  hipaa_gdpr_privacy_cleared: boolean;
  territorial_studio_exclusivity_verified: boolean;
};

export type CulinaryComplianceState = {
  vertical: "culinary";
  health_inspection_cleared: boolean;
  territorial_kitchen_exclusivity_verified: boolean;
};

export type ServicesComplianceState = {
  vertical: "services";
  health_board_license_verified: boolean;
  territorial_franchise_exclusivity_verified: boolean;
};

export type SoftwareComplianceState = {
  vertical: "software";
  api_uptime_sla_verified: boolean;
  software_security_audit_cleared: boolean;
};

export type HardwareComplianceState = {
  vertical: "hardware";
  frand_rate_court_determination_cleared: boolean;
  sep_essentiality_audit_verified: boolean;
};

export type ResourceComplianceState = {
  vertical: "resource";
  environmental_compliance_cleared: boolean;
  title_ownership_verification_passed: boolean;
};

export type SportsComplianceState = {
  vertical: "sports";
  event_completion_telemetry_verified: boolean;
  promoter_insurance_clearance: boolean;
  /**
   * True when the disbursement is a collegiate NIL waterfall payout; only
   * those payouts require the NIL compliance audit. Explicit false marks a
   * non-NIL sports payout and skips the audit condition.
   */
  is_collegiate_nil_waterfall: boolean;
  nil_compliance_audit_cleared?: boolean;
};

export type VerticalComplianceState =
  | MusicComplianceState
  | FilmComplianceState
  | PodcastComplianceState
  | GamingComplianceState
  | LivestreamComplianceState
  | PublishingComplianceState
  | MerchComplianceState
  | AiComplianceState
  | ArtComplianceState
  | TheaterComplianceState
  | LicensingComplianceState
  | NilComplianceState
  | SpatialComplianceState
  | FitnessComplianceState
  | CulinaryComplianceState
  | ServicesComplianceState
  | SoftwareComplianceState
  | HardwareComplianceState
  | ResourceComplianceState
  | SportsComplianceState;

/**
 * The state source the recon layer populates. Receives the payee key (the
 * Don store's sovereign identity) and the asset vertical; returns null when
 * the hold state for that pairing does not exist — the gate then refuses
 * with `vertical_state_unknown`.
 */
export type VerticalComplianceStateSource = (input: {
  payeeId: string;
  vertical: AssetVertical;
}) => Promise<VerticalComplianceState | null>;

let stateSourceOverride: VerticalComplianceStateSource | null = null;

/** Test/ops override — mirrors the BaaS adapter override pattern. */
export function setVerticalComplianceStateSource(
  source: VerticalComplianceStateSource | null,
): void {
  stateSourceOverride = source;
}

/**
 * Default: the recon layer has not populated compliance hold state yet —
 * every payout refuses until the source is replaced. Deliberately not
 * mutable state of its own; the override above is the seam.
 */
const defaultVerticalComplianceStateSource: VerticalComplianceStateSource =
  async () => null;

export function getVerticalComplianceStateSource(): VerticalComplianceStateSource {
  return stateSourceOverride ?? defaultVerticalComplianceStateSource;
}

/**
 * Resolves the creator's KYC status from the Plaid-backed verification
 * ledger (kyc_verifications). The records sort newest-first; the latest
 * record is the current state. No records → null → the gate refuses —
 * an unverified creator is never assumed verified.
 */
export async function resolveCreatorKycStatus(
  store: Store,
  creatorId: string,
): Promise<KycStatus | null> {
  const records = await store.listKycVerificationsByCreator(creatorId);
  if (records.length === 0) {
    return null;
  }
  return records[0].status;
}

/**
 * The AI vertical's compliance state, resolved from the payout-gate state
 * of record (migration 0029) — the store-backed reader the holding
 * release path falls back to for the 'ai' vertical. FAIL-CLOSED on both
 * failure modes the directive names: an ABSENT record returns null (the
 * gate refuses with vertical_state_unknown), and an 'unknown' stored
 * state maps to false (the gate refuses the specific condition). The
 * booleans are true ONLY on the verified/released states of record —
 * nothing defaults to allowing.
 */
export async function resolveAiVerticalComplianceState(
  store: Store,
  payeeId: string,
): Promise<Extract<
  VerticalComplianceState,
  { vertical: "ai" }
> | null> {
  const record: AiPayoutGateStateRecord | undefined =
    await store.getAiPayoutGateState(payeeId);
  if (record === undefined) {
    return null;
  }
  return {
    vertical: "ai",
    ai_training_consent_verified:
      record.ai_training_consent_state === "verified",
    synthetic_voice_likeness_released:
      record.synthetic_voice_likeness_state === "released",
  };
}

/**
 * The art vertical's compliance state, resolved from the estate payout-gate
 * state of record (migration 0033) — the store-backed reader the holding
 * release path falls back to for the 'art' vertical (the AI resolver's
 * pattern). FAIL-CLOSED on both failure modes the directive names: an
 * ABSENT record returns null (the gate refuses with
 * vertical_state_unknown), and an 'unknown' stored state maps to false
 * (the gate refuses the specific estate condition —
 * art_estate_succession_unverified). The boolean is true ONLY on the
 * verified state of record — nothing defaults to allowing.
 */
export async function resolveArtVerticalComplianceState(
  store: Store,
  payeeId: string,
): Promise<Extract<
  VerticalComplianceState,
  { vertical: "art" }
> | null> {
  const record: EstatePayoutGateStateRecord | undefined =
    await store.getEstatePayoutGateState(payeeId);
  if (record === undefined) {
    return null;
  }
  return {
    vertical: "art",
    estate_succession_verified: record.estate_succession_state === "verified",
  };
}

/**
 * The theater vertical's compliance state, resolved from the theatrical
 * payout-gate state of record (migration 0035) — the store-backed reader
 * the theatrical payout path uses for the 'theater' vertical (the AI and
 * estate resolvers' pattern, scoped per payee × production). FAIL-CLOSED
 * on both failure modes the directive names: an ABSENT record returns
 * null (the gate refuses with vertical_state_unknown), and an 'unknown'
 * stored state maps to false (the gate refuses the specific condition —
 * theater_grand_rights_not_cleared / theater_venue_settlement_unreconciled).
 * The booleans are true ONLY on the grand_rights_cleared /
 * venue_settlement_reconciled states of record — nothing defaults to
 * allowing.
 */
export async function resolveTheatricalVerticalComplianceState(
  store: Store,
  payeeId: string,
  productionId: string,
): Promise<Extract<
  VerticalComplianceState,
  { vertical: "theater" }
> | null> {
  const record: TheatricalPayoutGateStateRecord | undefined =
    await store.getTheatricalPayoutGateState(payeeId, productionId);
  if (record === undefined) {
    return null;
  }
  return {
    vertical: "theater",
    grand_rights_cleared: record.grand_rights_state === "cleared",
    venue_settlement_reconciled: record.venue_settlement_state === "reconciled",
  };
}

/**
 * The licensing vertical's compliance state, resolved from the licensing
 * payout-gate state of record (migration 0037) — the store-backed reader
 * the licensing payout path uses for the 'licensing' vertical (the
 * theatrical resolver's pattern, scoped per payee × license scope).
 * FAIL-CLOSED on both failure modes the directive names: an ABSENT record
 * returns null (the gate refuses with vertical_state_unknown), and an
 * 'unknown' stored state maps to false (the gate refuses the specific
 * condition — licensing_territory_not_cleared /
 * licensing_category_exclusivity_unverified). The booleans are true ONLY
 * on the territory_cleared / category_exclusivity_verified states of
 * record — nothing defaults to allowing.
 */
export async function resolveLicensingVerticalComplianceState(
  store: Store,
  payeeId: string,
  scopeKey: string,
): Promise<
  Extract<VerticalComplianceState, { vertical: "licensing" }> | null
> {
  const record: LicensingPayoutGateStateRecord | undefined =
    await store.getLicensingPayoutGateState(payeeId, scopeKey);
  if (record === undefined) {
    return null;
  }
  return {
    vertical: "licensing",
    territory_cleared: record.territory_state === "cleared",
    category_exclusivity_verified:
      record.category_exclusivity_state === "verified",
  };
}

/**
 * The NIL vertical's compliance state, resolved from the NIL payout-gate
 * state of record (migration 0038) — the store-backed reader the NIL
 * payout path uses for the 'nil' vertical (the licensing resolver's
 * pattern, scoped per athlete × school). FAIL-CLOSED on both failure
 * modes the directive names: an ABSENT record returns null (the gate
 * refuses with vertical_state_unknown), and an 'unknown' stored state
 * maps to false (the gate refuses the specific condition —
 * nil_not_cleared / nil_compliance_unverified /
 * nil_title_ix_proportionality_not_cleared). The booleans are true ONLY on
 * the nil_cleared / verified / cleared states of record — nothing
 * defaults to allowing. The associated-entity holdback passes through the
 * same fail-closed mapping: an unknown backing reads as backed (the cap
 * condition then refuses until verified), and only an explicit false —
 * a direct, unassociated deal — skips the cap check.
 */
export async function resolveNilVerticalComplianceState(
  store: Store,
  payeeId: string,
  schoolId: string,
): Promise<Extract<VerticalComplianceState, { vertical: "nil" }> | null> {
  const record: NilPayoutGateStateRecord | undefined = await store.getNilPayoutGateState(
    payeeId,
    schoolId,
  );
  if (record === undefined) {
    return null;
  }
  return {
    vertical: "nil",
    nil_cleared: record.nil_clearance_state === "nil_cleared",
    compliance_verified: record.compliance_state === "verified",
    title_ix_proportionality_cleared: record.title_ix_state === "cleared",
    // An UNKNOWN backing stays fail-closed: true forces the cap
    // condition to be verified before anything releases.
    collective_or_booster_backed: record.collective_or_booster_backed !== false,
    institutional_cap_verified: record.institutional_cap_state === "verified",
  };
}

/**
 * The spatial vertical's compliance state (PR 37, the founder spatial
 * directive), resolved from the spatial payout-gate states of record
 * (migration 0041) — the store-backed reader the spatial payout path
 * uses for the 'spatial' vertical (the NIL resolver's pattern, scoped
 * per payee × venue). FAIL-CLOSED on both failure modes the directive
 * names: an ABSENT record returns null (the gate refuses with
 * vertical_state_unknown), and an 'unknown' stored state maps to false
 * (the gate refuses with territorial_zoning_not_cleared /
 * spatial_audit_unverified). The booleans are true ONLY on the
 * territorial_zoning_cleared / spatial_audit_verified states of record
 * — nothing defaults to allowing.
 */
export async function resolveSpatialVerticalComplianceState(
  store: Store,
  payeeId: string,
  venueId: string,
): Promise<Extract<VerticalComplianceState, { vertical: "spatial" }> | null> {
  const record: SpatialPayoutGateStateRecord | undefined =
    await store.getSpatialPayoutGateState(payeeId, venueId);
  if (record === undefined) {
    return null;
  }
  return {
    vertical: "spatial",
    territorial_zoning_cleared: record.territorial_zoning_state === "cleared",
    spatial_audit_verified: record.spatial_audit_state === "verified",
  };
}

export async function resolveFitnessVerticalComplianceState(
  store: Store,
  payeeId: string,
  studioFranchiseCode: string,
): Promise<Extract<VerticalComplianceState, { vertical: "fitness" }> | null> {
  const record: FitnessPayoutGateStateRecord | undefined = await store.getFitnessPayoutGateState(
    payeeId,
    studioFranchiseCode,
  );
  if (record === undefined) {
    return null;
  }
  return {
    vertical: "fitness",
    hipaa_gdpr_privacy_cleared: record.hipaa_gdpr_privacy_state === "cleared",
    territorial_studio_exclusivity_verified: record.territorial_exclusivity_state === "verified",
  };
}

export async function resolveCulinaryVerticalComplianceState(
  store: Store,
  payeeId: string,
  ghostKitchenLocationCode: string,
): Promise<Extract<VerticalComplianceState, { vertical: "culinary" }> | null> {
  const record: CulinaryPayoutGateStateRecord | undefined = await store.getCulinaryPayoutGateState(
    payeeId,
    ghostKitchenLocationCode,
  );
  if (record === undefined) {
    return null;
  }
  return {
    vertical: "culinary",
    health_inspection_cleared: record.health_inspection_state === "cleared",
    territorial_kitchen_exclusivity_verified: record.territorial_exclusivity_state === "verified",
  };
}

/**
 * The services vertical's compliance state (PR 43, the founder services
 * directive), resolved from the services payout-gate states of record
 * (migration 0047) — the store-backed reader the service payout path uses
 * for the 'services' vertical (the culinary resolver's pattern, scoped
 * per payee × salon location). FAIL-CLOSED on both failure modes the
 * directive names: an ABSENT record returns null (the gate refuses with
 * vertical_state_unknown), and an 'unknown' stored state maps to false
 * (the gate refuses with services_license_not_verified /
 * services_exclusivity_unverified). The booleans are true ONLY on the
 * health_board_license_verified / territorial_franchise_exclusivity_verified
 * states of record — nothing defaults to allowing.
 */
export async function resolveServicesVerticalComplianceState(
  store: Store,
  payeeId: string,
  salonLocationId: string,
): Promise<Extract<VerticalComplianceState, { vertical: "services" }> | null> {
  const record: ServicesPayoutGateStateRecord | undefined = await store.getServicesPayoutGateState(
    payeeId,
    salonLocationId,
  );
  if (record === undefined) {
    return null;
  }
  return {
    vertical: "services",
    health_board_license_verified: record.health_license_state === "verified",
    territorial_franchise_exclusivity_verified:
      record.territorial_exclusivity_state === "verified",
  };
}

export type PayoutComplianceInput = {
  operatorSettlementApproved: boolean;
  kycStatus: KycStatus | null;
  verticalState: VerticalComplianceState | null;
};

export type PayoutComplianceVerdict =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Pure verdict — no store, no I/O. Every false/unknown value refuses with
 * the named code; only explicit true passes each condition.
 */
export function evaluatePayoutCompliance(
  input: PayoutComplianceInput,
): PayoutComplianceVerdict {
  if (input.operatorSettlementApproved !== true) {
    return {
      ok: false,
      code: "settlement_not_approved",
      message:
        "Payout refused: operator settlement approval has not been granted for this dispatch.",
    };
  }
  if (input.kycStatus === null) {
    return {
      ok: false,
      code: "kyc_state_unknown",
      message:
        "Payout refused: the target creator has no KYC verification record — KYC state is unknown.",
    };
  }
  if (input.kycStatus !== "verified") {
    return {
      ok: false,
      code: "kyc_not_verified",
      message: `Payout refused: the target creator's KYC status is "${input.kycStatus}", not verified.`,
    };
  }
  const state = input.verticalState;
  if (state === null) {
    return {
      ok: false,
      code: "vertical_state_unknown",
      message:
        "Payout refused: no compliance hold state exists for this payee and vertical yet.",
    };
  }
  switch (state.vertical) {
    case "music": {
      if (state.rights_separation_settled !== true) {
        return {
          ok: false,
          code: "music_rights_separation_unsettled",
          message:
            "Payout refused: MASTER/PUBLISHING rights separation is not fully settled for this asset.",
        };
      }
      return { ok: true };
    }
    case "film": {
      if (state.cama_escrow_released !== true) {
        return {
          ok: false,
          code: "film_cama_escrow_not_released",
          message: "Payout refused: the CAMA escrow has not been released.",
        };
      }
      if (state.guild_residual_holdback_satisfied !== true) {
        return {
          ok: false,
          code: "film_guild_residual_holdback_not_satisfied",
          message:
            "Payout refused: open guild residual obligations (SAG-AFTRA/WGA/DGA) remain for this asset.",
        };
      }
      return { ok: true };
    }
    case "podcast": {
      if (state.iab_ad_impression_verified !== true) {
        return {
          ok: false,
          code: "podcast_impression_verification_missing",
          message:
            "Payout refused: IAB ad-impression verification has not been confirmed for this period.",
        };
      }
      if (state.network_commission_deducted !== true) {
        return {
          ok: false,
          code: "podcast_network_commission_not_deducted",
          message:
            "Payout refused: the network commission has not been deducted for this period.",
        };
      }
      return { ok: true };
    }
    case "gaming": {
      if (state.platform_commission_deducted !== true) {
        return {
          ok: false,
          code: "gaming_platform_commission_not_deducted",
          message:
            "Payout refused: the platform commission (Apple/Steam/EGS) has not been deducted.",
        };
      }
      if (state.studio_kyc_verified !== true) {
        return {
          ok: false,
          code: "gaming_studio_kyc_not_verified",
          message: "Payout refused: the studio's KYC is not verified.",
        };
      }
      const unverified = state.team_member_checks.find(
        (member) =>
          !member.member_ref ||
          member.identity_check_passed !== true,
      );
      if (unverified !== undefined) {
        return {
          ok: false,
          code: "gaming_team_identity_unverified",
          message: `Payout refused: team member "${unverified.member_ref || "unnamed"}" has not passed identity checks.`,
        };
      }
      return { ok: true };
    }
    case "livestream": {
      if (state.stream_platform_payout_reconciled !== true) {
        return {
          ok: false,
          code: "livestream_payout_not_reconciled",
          message:
            "Payout refused: the stream platform payout has not been reconciled.",
        };
      }
      if (state.tax_withholding_verified !== true) {
        return {
          ok: false,
          code: "livestream_tax_withholding_unverified",
          message:
            "Payout refused: tax withholding verification is not confirmed (mandatory for international esports tournament winnings).",
        };
      }
      return { ok: true };
    }
    case "publishing": {
      if (state.ip_rights_cleared !== true) {
        return {
          ok: false,
          code: "publishing_ip_rights_not_cleared",
          message:
            "Payout refused: IP rights are not fully cleared for this publishing/adaptation work.",
        };
      }
      // Print-book additions: the return reserve must have elapsed and the
      // ISBN rights chain must be verified — both fail closed.
      if (state.return_reserve_period_elapsed !== true) {
        return {
          ok: false,
          code: "publishing_return_reserve_not_elapsed",
          message:
            "Payout refused: the book-return reserve period has not elapsed for this print title.",
        };
      }
      if (state.isbn_rights_verified !== true) {
        return {
          ok: false,
          code: "publishing_isbn_rights_unverified",
          message:
            "Payout refused: ISBN rights have not been verified for this print title.",
        };
      }
      return { ok: true };
    }
    case "merch": {
      if (state.physical_fulfillment_confirmed !== true) {
        return {
          ok: false,
          code: "merch_fulfillment_unconfirmed",
          message:
            "Payout refused: physical fulfillment (tracking delivered) has not been confirmed for this merch release.",
        };
      }
      return { ok: true };
    }
    case "ai": {
      if (state.ai_training_consent_verified !== true) {
        return {
          ok: false,
          code: "ai_training_consent_unverified",
          message:
            "Payout refused: AI training consent has not been verified for this voice/likeness work.",
        };
      }
      if (state.synthetic_voice_likeness_released !== true) {
        return {
          ok: false,
          code: "ai_voice_likeness_not_released",
          message:
            "Payout refused: the synthetic voice/likeness has not been released for this work.",
        };
      }
      return { ok: true };
    }
    case "art": {
      if (state.estate_succession_verified !== true) {
        return {
          ok: false,
          code: "art_estate_succession_unverified",
          message:
            "Payout refused: estate succession has not been verified (a validated legal certificate is required) for this estate/multi-heir payout.",
        };
      }
      return { ok: true };
    }
    case "theater": {
      if (state.grand_rights_cleared !== true) {
        return {
          ok: false,
          code: "theater_grand_rights_not_cleared",
          message:
            "Payout refused: grand rights have not been cleared for this theatrical/live-comedy production.",
        };
      }
      if (state.venue_settlement_reconciled !== true) {
        return {
          ok: false,
          code: "theater_venue_settlement_unreconciled",
          message:
            "Payout refused: the venue settlement has not been reconciled for this production.",
        };
      }
      return { ok: true };
    }
    case "licensing": {
      if (state.territory_cleared !== true) {
        return {
          ok: false,
          code: "licensing_territory_not_cleared",
          message:
            "Payout refused: the licensed territory has not been cleared for this brand licensing payout.",
        };
      }
      if (state.category_exclusivity_verified !== true) {
        return {
          ok: false,
          code: "licensing_category_exclusivity_unverified",
          message:
            "Payout refused: category exclusivity has not been verified for this brand licensing payout.",
        };
      }
      return { ok: true };
    }
    case "nil": {
      if (state.nil_cleared !== true) {
        return {
          ok: false,
          code: "nil_not_cleared",
          message: "Payout refused: the NIL deal has not been cleared for this payout.",
        };
      }
      if (state.compliance_verified !== true) {
        return {
          ok: false,
          code: "nil_compliance_unverified",
          message: "Payout refused: NIL compliance has not been verified for this payout.",
        };
      }
      if (state.title_ix_proportionality_cleared !== true) {
        return {
          ok: false,
          code: "nil_title_ix_proportionality_not_cleared",
          message:
            "Payout refused: Title IX proportionality has not been cleared for this NIL payout.",
        };
      }
      // Associated-entity holdback: collective or booster-backed funds stay
      // held until institutional cap verification. Only an EXPLICIT false
      // (a direct, unassociated deal) skips the cap check — an unknown
      // backing refuses, per the fail-closed canon.
      if (
        state.collective_or_booster_backed !== false &&
        state.institutional_cap_verified !== true
      ) {
        return {
          ok: false,
          code: "nil_institutional_cap_unverified",
          message:
            "Payout refused: collective or booster-backed NIL funds remain held until institutional cap verification (associated-entity holdback).",
        };
      }
      return { ok: true };
    }
    case "spatial": {
      if (state.territorial_zoning_cleared !== true) {
        return {
          ok: false,
          code: "spatial_zoning_not_cleared",
          message:
            "Payout refused: territorial zoning has not been cleared for this spatial or location-based entertainment payout.",
        };
      }
      if (state.spatial_audit_verified !== true) {
        return {
          ok: false,
          code: "spatial_audit_unverified",
          message:
            "Payout refused: the spatial audit has not been verified for this payout.",
        };
      }
      return { ok: true };
    }
    case "fitness": {
      if (state.hipaa_gdpr_privacy_cleared !== true) {
        return {
          ok: false,
          code: "fitness_privacy_not_cleared",
          message:
            "Payout refused: HIPAA/GDPR privacy clearance has not been verified for this fitness payout.",
        };
      }
      if (state.territorial_studio_exclusivity_verified !== true) {
        return {
          ok: false,
          code: "fitness_exclusivity_unverified",
          message:
            "Payout refused: territorial studio exclusivity has not been verified for this fitness payout.",
        };
      }
      return { ok: true };
    }
    case "culinary": {
      if (state.health_inspection_cleared !== true) {
        return {
          ok: false,
          code: "culinary_inspection_not_cleared",
          message:
            "Payout refused: the health inspection has not been cleared for this culinary or ghost-kitchen payout.",
        };
      }
      if (state.territorial_kitchen_exclusivity_verified !== true) {
        return {
          ok: false,
          code: "culinary_exclusivity_unverified",
          message:
            "Payout refused: territorial kitchen exclusivity has not been verified for this culinary payout.",
        };
      }
      return { ok: true };
    }
    case "services": {
      if (state.health_board_license_verified !== true) {
        return {
          ok: false,
          code: "services_license_not_verified",
          message:
            "Payout refused: the health board license has not been verified for this salon, med-spa, or hospitality franchise payout.",
        };
      }
      if (state.territorial_franchise_exclusivity_verified !== true) {
        return {
          ok: false,
          code: "services_exclusivity_unverified",
          message:
            "Payout refused: territorial franchise exclusivity has not been verified for this services payout.",
        };
      }
      return { ok: true };
    }
    case "software": {
      if (state.api_uptime_sla_verified !== true) {
        return {
          ok: false,
          code: "software_uptime_sla_unverified",
          message:
            "Payout refused: the API uptime SLA has not been verified for this developer-tools payout.",
        };
      }
      if (state.software_security_audit_cleared !== true) {
        return {
          ok: false,
          code: "software_security_audit_not_cleared",
          message:
            "Payout refused: the security audit has not been cleared for this software payout.",
        };
      }
      return { ok: true };
    }
    case "hardware": {
      if (state.frand_rate_court_determination_cleared !== true) {
        return {
          ok: false,
          code: "hardware_frand_rate_not_cleared",
          message:
            "Payout refused: the FRAND rate court determination has not been cleared for this hardware patent payout.",
        };
      }
      if (state.sep_essentiality_audit_verified !== true) {
        return {
          ok: false,
          code: "hardware_essentiality_unverified",
          message:
            "Payout refused: the SEP essentiality audit has not been verified for this hardware patent payout.",
        };
      }
      return { ok: true };
    }
    case "resource": {
      if (state.environmental_compliance_cleared !== true) {
        return {
          ok: false,
          code: "resource_environmental_not_cleared",
          message:
            "Payout refused: environmental compliance has not been cleared for this energy or resource payout.",
        };
      }
      if (state.title_ownership_verification_passed !== true) {
        return {
          ok: false,
          code: "resource_title_unverified",
          message:
            "Payout refused: title ownership has not been verified for this energy or resource payout.",
        };
      }
      return { ok: true };
    }
    case "sports": {
      if (state.event_completion_telemetry_verified !== true) {
        return {
          ok: false,
          code: "sports_telemetry_unverified",
          message:
            "Payout refused: event completion telemetry has not been verified for this sports or ticketing payout.",
        };
      }
      if (state.promoter_insurance_clearance !== true) {
        return {
          ok: false,
          code: "sports_insurance_not_cleared",
          message:
            "Payout refused: promoter insurance has not been cleared for this sports or ticketing payout.",
        };
      }
      if (state.is_collegiate_nil_waterfall === true && state.nil_compliance_audit_cleared !== true) {
        return {
          ok: false,
          code: "sports_nil_audit_not_cleared",
          message:
            "Payout refused: the NIL compliance audit has not been cleared for this collegiate NIL waterfall disbursement.",
        };
      }
      return { ok: true };
    }
  }
}
