/**
 * Covenant Universal Royalty Collection SDK — wire types.
 * Money fields are integer cents. Party shares convert to basis points
 * (10000 = 100%) before allocation.
 */

export const UNIVERSAL_20_IDENTIFIER_KEYS = [
  "isrc",
  "iswc",
  "ipi",
  "isni",
  "ipn",
  "upc",
  "isan",
  "eidr",
  "visan",
  "grid",
  "isbn",
  "issn",
  "ismn",
  "doi",
  "swid",
  "san",
  "cwrId",
  "epcRfid",
  "nilId",
  "bowi",
] as const;

export type Universal20IdentifierKey =
  (typeof UNIVERSAL_20_IDENTIFIER_KEYS)[number];

export type Universal20Identifiers = {
  [K in Universal20IdentifierKey]?: string;
};

export const ASSET_CATEGORIES = [
  "AUDIO",
  "VIDEO",
  "PUBLISHING",
  "GAME_SOFTWARE",
  "PHYSICAL_MERCH",
  "INTERACTIVE_FASHION",
  "NIL_AVATAR",
] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const TERRITORY_TYPES = [
  "GLOBAL",
  "NORTH_AMERICA",
  "LATAM",
  "EUROPE",
  "ASIA_PACIFIC",
  "MENA",
  "AFRICA",
] as const;
export type TerritoryType = (typeof TERRITORY_TYPES)[number];

export const SPLIT_PARTY_ROLES = [
  "COMPOSER",
  "LYRICIST",
  "PRODUCER",
  "FEATURED_ARTIST",
  "LABEL",
  "AUTHOR",
  "DEVELOPER",
  "DESIGNER",
  "RIGHTS_HOLDER",
  "PUBLISHER",
  "SUB_PUBLISHER",
  "ADMINISTRATOR",
] as const;
export type SplitPartyRole = (typeof SPLIT_PARTY_ROLES)[number];

export function isSplitPartyRole(value: string): value is SplitPartyRole {
  return (SPLIT_PARTY_ROLES as readonly string[]).includes(value);
}

export const SOCIAL_UGC_PLATFORMS = [
  "FACEBOOK",
  "INSTAGRAM",
  "TIKTOK",
  "YOUTUBE_SHORTS",
  "SNAPCHAT",
  "TRILLER",
  "TWITCH",
] as const;
export type SocialUgcPlatform = (typeof SOCIAL_UGC_PLATFORMS)[number];

export const COMPANY_NODE_CATEGORIES = [
  "STREAMING_DSP",
  "SOCIAL_UGC",
  "PRO_COLLECTION_SOCIETY",
  "GAME_PUBLISHER",
  "FILM_DISTRIBUTOR",
  "BOOK_PUBLISHER",
  "MERCH_RETAILER",
] as const;
export type CompanyNodeCategory = (typeof COMPANY_NODE_CATEGORIES)[number];

export const API_PROTOCOLS = [
  "DDEX_ERN",
  "DIRECT_REST",
  "RIGHTS_MANAGER_API",
  "CWR_PROTOCOL",
  "ONCHAIN_LEDGER",
] as const;
export type ApiProtocol = (typeof API_PROTOCOLS)[number];

export const NODE_STATUSES = [
  "ACTIVE",
  "CLEARANCE_ENFORCED",
  "ESCROW_HOLD",
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const SETTLEMENT_STATUSES = [
  "PENDING",
  "SETTLED",
  "ESCROW_RELEASED",
] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export type SplitParty = {
  partyId: string;
  name: string;
  role: SplitPartyRole;
  /** Percent 0–100. Converted to bps via Math.round(percent * 100). */
  sharePercentage?: number;
  /** Basis points. 10000 = 100%. Takes precedence over sharePercentage. */
  shareBps?: number;
  payoutWalletOrBank: string;
  ipi?: string;
  isni?: string;
};

export type UniversalWorkManifest = {
  workId: string;
  title: string;
  category: AssetCategory;
  identifiers: Universal20Identifiers;
  splits: SplitParty[];
  mulCertificateId: string;
  primaryMediaUrl?: string;
  metadataHash: string;
  registeredTerritories?: string[];
};

export type SocialMediaUGCEvent = {
  eventId: string;
  platform: SocialUgcPlatform;
  videoUrl: string;
  contentIdMatchHash: string;
  creatorHandle: string;
  viewCount: number;
  /** Integer cents. */
  estRevenueAccruedCents: number;
  currency: string;
  timestamp: string;
};

export type GlobalCompanyNode = {
  companyId: string;
  name: string;
  category: CompanyNodeCategory;
  supportedCodes: Universal20IdentifierKey[];
  apiProtocol: ApiProtocol;
  status: NodeStatus;
};

export type RoyaltyCollectionStatement = {
  statementId: string;
  companyId: string;
  workId: string;
  grossCents: number;
  netCents: number;
  currency: string;
  period: string;
  claimsEnforcedCount: number;
  settlementStatus: SettlementStatus;
};

export type CovenantFailure = {
  ok: false;
  code: string;
  message: string;
};
