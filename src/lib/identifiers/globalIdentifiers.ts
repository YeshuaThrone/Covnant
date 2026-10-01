// Universal Registry Identification Types & Validation Constraints
// ============================================================================
// Founder registry, composed from the canonical artifacts, each block carried
// character-exact:
//   - v11 (art_14kRJ9R9): the four base unions + GLOBAL_IDENTIFIER_PATTERNS
//     (63 types) — the engine contract (PR 52).
//   - v15 (art_C2Ul5xWj): ExtendedSportsIdentifierType + EXTENDED_SPORTS_PATTERNS
//     — the seven telemetry types, registry 63 -> 70.
//   - v25 (pinned): Web3AndSpatialIdentifierType + WEB3_SPATIAL_PATTERNS — the
//     four geospatial/Web3 types. The W3C_VC_ID TS pattern carries the /i flag;
//     the SQL branch (migration 0015) is case-sensitive — a flagged founder
//     question (the DB is the stricter gate), both surfaces character-exact.
//
// REGISTRY COUNT — read dynamically, never hardcode: the founder work order
// cites "75 types", which double-counts OPTA_PERSON_ID (registered in the v15
// seven AND counted again as v23's type #71). The distinct registry lands at
// 74. Suites must assert Object.keys(GLOBAL_IDENTIFIER_PATTERNS).length —
// GLOBAL_IDENTIFIER_TYPE_COUNT — never a literal.

export type FineArtIdentifierType =
  | 'AAT_ID'
  | 'ARK'
  | 'ALR_ID'
  | 'CRSA_CODE'
  | 'DARIA_ID'
  | 'GND_ID'
  | 'LIDO_CODE'
  | 'OBJECT_ID'
  | 'ULAN_ID'
  | 'CIDOC_CRM_ID'
  | 'CDWA_ID'
  | 'CITES_CERT_ID'
  | 'CONA_ID'
  | 'SPECTRUM_ID';

export type SportsIdentifierType =
  | 'ATP_WTA_CODE'
  | 'FIFA_CONNECT_ID'
  | 'FIBA_ID'
  | 'GLAN'
  | 'IRB_RUGBY_ID'
  | 'NCAA_ID'
  | 'NIL_ID'
  | 'PAID'
  | 'UCI_CODE'
  | 'WADA_ADAMS_ID'
  | 'WDSF_ID'
  | 'FIDE_ID'
  | 'ESIC_ID'
  | 'PUUID';

export type SpatialAndCulinaryIdentifierType =
  | 'CAS_REGISTRY'
  | 'CPT_CODE'
  | 'FDC_ID'
  | 'FIT_ID'
  | 'GIAI'
  | 'GLN'
  | 'GRAI'
  | 'HL7_FHIR_ID'
  | 'INCI_ID'
  | 'IEEE_11073_ID'
  | 'LOINC_CODE'
  | 'NPI'
  | 'PLU_CODE'
  | 'UPRN'
  | 'GTIN14'
  | 'GS1_DIGITAL_LINK'
  | 'E_AMBROSIA_ID';

export type SoftwareAndInfrastructureIdentifierType =
  | 'API_ENDPOINT_UUID'
  | 'BIC_SWIFT'
  | 'CPC_PATENT'
  | 'CVE_ID'
  | 'DOCDB_PATENT'
  | 'DUNS_NUMBER'
  | 'EIC_CODE'
  | 'EID'
  | 'IMEI'
  | 'LEI'
  | 'MAC_ADDRESS'
  | 'PURL'
  | 'REC_SERIAL'
  | 'SCADA_UUID'
  | 'SPDX_ID'
  | 'SWID_TAG'
  | 'GSRN'
  | 'THREEGPP_SPEC';

// Extended Sports & Telemetry Types (canon v15)
export type ExtendedSportsIdentifierType =
  | 'SECOND_SPECTRUM_ID'
  | 'OPTA_PERSON_ID'
  | 'GENIUS_SPORTS_ID'
  | 'CATAPULT_SESSION_UUID'
  | 'KINEXON_ID'
  | 'ICC_PLAYER_ID'
  | 'WORLD_ATHLETICS_ID';

// Extended Geospatial & Decentralized Web3 Identifiers (canon v25)
export type Web3AndSpatialIdentifierType =
  | 'H3_INDEX' // Uber H3 Spatial Index (e.g., 8928308280fffff)
  | 'DID_URI' // Decentralized Identifier (e.g., did:method:identifier)
  | 'ETH_ADDRESS' // Ethereum / EVM Wallet Address (0x...)
  | 'W3C_VC_ID'; // W3C Verifiable Credential UUID

export type GlobalIdentifierType =
  | FineArtIdentifierType
  | SportsIdentifierType
  | SpatialAndCulinaryIdentifierType
  | SoftwareAndInfrastructureIdentifierType
  | ExtendedSportsIdentifierType
  | Web3AndSpatialIdentifierType;

// ---------------------------------------------------------------------------
// Regular Expression Validation Registry
// ---------------------------------------------------------------------------

// Extended Sports & Telemetry — canon v15, verbatim.
export const EXTENDED_SPORTS_PATTERNS: Record<ExtendedSportsIdentifierType, RegExp> = {
  SECOND_SPECTRUM_ID: /^SS-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  OPTA_PERSON_ID: /^p\d{4,8}$/,
  GENIUS_SPORTS_ID: /^GS-ENT-\d{6,10}$/,
  CATAPULT_SESSION_UUID: /^CAT-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  KINEXON_ID: /^KX-TAG-[A-F0-9]{8,12}$/i,
  ICC_PLAYER_ID: /^ICC-\d{5,8}$/,
  WORLD_ATHLETICS_ID: /^WA-\d{7,10}$/,
};

// Extended Geospatial & Decentralized Web3 — canon v25, verbatim (W3C_VC_ID
// carries the /i flag on the TypeScript surface; the SQL branch does not —
// flagged founder question, character-exact carry).
export const WEB3_SPATIAL_PATTERNS: Record<Web3AndSpatialIdentifierType, RegExp> = {
  H3_INDEX: /^[89a-fA-F][0-9a-fA-F]{14}$/,
  DID_URI: /^did:[a-z0-9]+:[a-zA-Z0-9._%-]+$/,
  ETH_ADDRESS: /^0x[a-fA-F0-9]{40}$/,
  W3C_VC_ID: /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};

export const GLOBAL_IDENTIFIER_PATTERNS: Record<GlobalIdentifierType, RegExp> = {
  // Fine Art & Antiquities (v11)
  AAT_ID: /^AAT-\d{8}$/,
  ARK: /^ark:\/\d{5}\/[a-z0-9]+$/,
  ALR_ID: /^ALR-[A-Z0-9]{8,12}$/,
  CRSA_CODE: /^CRSA-[A-Z]{3}-\d{6}$/,
  DARIA_ID: /^DARIA-[A-F0-9]{16}$/,
  GND_ID: /^1[012]?\d{7}[0-X]$/,
  LIDO_CODE: /^LIDO-[A-Z0-9_-]{8,32}$/,
  OBJECT_ID: /^OBJID-[A-Z]{3}-\d{8}$/,
  ULAN_ID: /^ULAN-\d{8,10}$/,
  CIDOC_CRM_ID: /^CRM-[E-F]\d{1,3}$/,
  CDWA_ID: /^CDWA-\d{8,12}$/,
  CITES_CERT_ID: /^[A-Z]{2}\/\d{6}\/[A-Z0-9]{4,8}$/,
  CONA_ID: /^CONA-\d{8,10}$/,
  SPECTRUM_ID: /^SPEC-[A-Z0-9]{6,16}$/,

  // Sports & Performance Telemetry (v11)
  ATP_WTA_CODE: /^[A-Z]{3}\d{3}$/,
  FIFA_CONNECT_ID: /^[19]\d{2}[A-Z0-9]{8,10}$/,
  FIBA_ID: /^FIBA-\d{6,8}$/,
  GLAN: /^GLAN-[A-Z0-9]{12}$/,
  IRB_RUGBY_ID: /^IRB-\d{7,9}$/,
  NCAA_ID: /^\d{9}$/,
  NIL_ID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  PAID: /^(NFLPA|NBAPA|MLBPA|NHLPA|MLSPA)-\d{6}$/,
  UCI_CODE: /^100\d{8}$/,
  WADA_ADAMS_ID: /^ADM-\d{8}$/,
  WDSF_ID: /^WDSF-\d{6,8}$/,
  FIDE_ID: /^\d{6,9}$/,
  ESIC_ID: /^ESIC-[A-Z0-9]{8,12}$/,
  PUUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,

  // Spatial, Fitness, Culinary & Formulations (v11)
  CAS_REGISTRY: /^\d{2,7}-\d{2}-\d$/,
  CPT_CODE: /^\d{4}[0-9A-Z]$/,
  FDC_ID: /^\d{6,8}$/,
  FIT_ID: /^FIT-[A-Z0-9]{10}$/,
  GIAI: /^\d{6,12}[A-Z0-9]{1,18}$/,
  GLN: /^\d{13}$/,
  GRAI: /^0\d{12}[A-Z0-9]{1,16}$/,
  HL7_FHIR_ID: /^[A-Za-z0-9\-.]{1,64}$/,
  INCI_ID: /^INCI-[A-Z0-9-]{6,20}$/,
  IEEE_11073_ID: /^[0-9A-F]{16}$/i,
  LOINC_CODE: /^\d{3,5}-\d$/,
  NPI: /^\d{10}$/,
  PLU_CODE: /^(3\d{3}|4\d{3}|8\d{4}|9\d{4})$/,
  UPRN: /^\d{12}$/,
  GTIN14: /^\d{14}$/,
  GS1_DIGITAL_LINK: /^https?:\/\/id\.gs1\.org\/\d{2}\/.+$/,
  E_AMBROSIA_ID: /^PGI-[A-Z]{2}-\d{6,8}$/,

  // Software, Patents, Energy & Corporate Entities (v11)
  API_ENDPOINT_UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  BIC_SWIFT: /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/,
  CPC_PATENT: /^[A-H]\d{2}[A-Z]\d{1,4}\/\d{2,6}$/,
  CVE_ID: /^CVE-\d{4}-\d{4,7}$/,
  DOCDB_PATENT: /^[A-Z]{2}\d{1,12}[A-Z]\d?$/,
  DUNS_NUMBER: /^\d{9}$/,
  EIC_CODE: /^\d{2}[A-Z0-9\-]{14}$/,
  EID: /^89\d{30}$/,
  IMEI: /^\d{15}$/,
  LEI: /^[A-Z0-9]{18}\d{2}$/,
  MAC_ADDRESS: /^([0-9A-FA-F]{2}[:-]){5}([0-9A-FA-F]{2})$/,
  // The namespace class gains the at-sign (flagged correction, addendum 31):
  // scoped npm purls — kept in parity with the trigger's PURL branch (0012/0015).
  PURL: /^pkg:[a-z0-9-]+\/[a-z0-9_.@-]+\/?[a-z0-9_.-]+@.+$/i,
  REC_SERIAL: /^REC-[A-Z]{2}-\d{8}-\d{6}$/,
  SCADA_UUID: /^SCADA-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  SPDX_ID: /^SPDXRef-[A-Za-z0-9.-]+$/,
  SWID_TAG: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  GSRN: /^\d{18}$/,
  THREEGPP_SPEC: /^3GPP-TS-\d{2}\.\d{3}$/,

  // Extended sports telemetry (v15) and geospatial/Web3 (v25) spread in so
  // the founder's blocks stay verbatim in their own constants.
  ...EXTENDED_SPORTS_PATTERNS,
  ...WEB3_SPATIAL_PATTERNS,
};

/** Live registry size — the only number suites may assert against. */
export const GLOBAL_IDENTIFIER_TYPE_COUNT = Object.keys(
  GLOBAL_IDENTIFIER_PATTERNS,
).length;

// ---------------------------------------------------------------------------
// Verification Payload Interfaces (v11, verbatim)
// ---------------------------------------------------------------------------
export interface IdentityIngestionPayload {
  entityId: string;
  verticalCategory: string;
  primaryCodeType: GlobalIdentifierType;
  primaryCodeValue: string;
  crossReferences?: Array<{
    linkedCodeType: GlobalIdentifierType;
    linkedCodeValue: string;
    verificationSource: string;
  }>;
}

export function validateIdentifier(
  type: GlobalIdentifierType,
  value: string,
): boolean {
  const pattern = GLOBAL_IDENTIFIER_PATTERNS[type];
  if (!pattern) {
    throw new Error(`Unsupported global identifier type: ${type}`);
  }
  return pattern.test(value);
}
