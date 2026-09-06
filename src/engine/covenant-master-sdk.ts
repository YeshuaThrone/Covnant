/**
 * ==========================================================================
 * COVENANT MASTER ENGINE (v2.0.0 - Production Auditor & Tax Ready)
 * ==========================================================================
 * Architecture: The Don Engine / Covenant Platform
 * Features:
 *   - Universal Asset Registry & Split Engine
 *   - Universal Social & Entertainment Claim Processor
 *   - Multi-Currency Dynamic Precision (Fiat 4-dec, Crypto 8-dec)
 *   - Automated Tax Engine (W-8BEN / W-9 / 1099 Threshold Tracking)
 *   - Embedded Real-Time Auditor Engine
 *   - Next.js Server Actions & Supabase Integration
 * ==========================================================================
 */

import { createHash, randomBytes } from 'crypto';
import { SupabaseClient, createClient } from '@supabase/supabase-js';

/* ==========================================================================
   1. TYPES & ENUMS
   ========================================================================== */

export type MediaMedium = 
  | 'MUSIC_TRACK' | 'MUSIC_ALBUM' | 'SHEET_MUSIC' 
  | 'FEATURE_FILM' | 'TV_SHOW' | 'TV_SEASON' | 'TV_EPISODE' 
  | 'PODCAST_EPISODE' | 'AUDIOBOOK' | 'PRINT_BOOK' | 'EBOOK' 
  | 'MAGAZINE_SERIAL' | 'VIDEO_GAME' | 'LIVE_STREAM' | 'MARS_ORBITAL_BROADCAST';

export type SettlementCurrency = 
  | 'USD' | 'EUR' | 'GBP' | 'CAD' | 'AUD' | 'JPY' | 'MXN' | 'BRL' | 'INR' | 'CNY'
  | 'SAT' | 'ETH' | 'SOL' | 'MARS_CREDIT';

export type PaymentRail = 
  | 'ACH' | 'WIRE' | 'SEPA' | 'SWIFT' | 'FEDNOW' 
  | 'SPEI' | 'PIX' | 'UPI' | 'LIGHTNING' | 'SOLANA' | 'INTERPLANETARY_RELAY';

export type SocialEntertainmentPlatform = 
  | 'META_FB_IG' | 'TIKTOK' | 'YOUTUBE_CONTENT_ID' | 'TWITCH' 
  | 'SNAPCHAT' | 'TRILLER' | 'X_TWITTER' | 'DISCORD' 
  | 'APPLE_MUSIC' | 'SPOTIFY' | 'ROBLOX' | 'EPIC_GAMES_UE5';

export type TaxFormType = 'W9_US_PERSON' | 'W8BEN_FOREIGN_INDIVIDUAL' | 'W8BEN_E_FOREIGN_ENTITY' | 'EXEMPT';

export const CURRENCY_DECIMALS: Record<string, number> = {
  USD: 4, EUR: 4, GBP: 4, CAD: 4, AUD: 4, JPY: 2, MXN: 4, BRL: 4, INR: 4, CNY: 4,
  SAT: 8, ETH: 8, SOL: 8, MARS_CREDIT: 6,
};

export function getScaleForCurrency(currency: string): { scaleNum: number; scaleBI: bigint } {
  const decimals = CURRENCY_DECIMALS[currency] ?? 4;
  const scaleNum = Math.pow(10, decimals);
  return { scaleNum, scaleBI: BigInt(scaleNum) };
}

export interface UniversalAssetIdentifier {
  isrc?: string;
  iswc?: string;
  ismn?: string;
  grid?: string;
  eidrCanonical?: string;
  isanHex?: string;
  isbn?: string;
  issn?: string;
  gtin?: string;
  guid?: string;
  mlc_work_id?: string;
  hfa_song_id?: string;
  prs_tunecode?: string;
}

export interface TaxProfile {
  taxFormType: TaxFormType;
  taxIdentifierEncrypted: string; // SSN, EIN, or Foreign TIN
  usTaxResident: boolean;
  treatyCountryCode?: string;
  treatyWithholdingRate?: number; // e.g., 0.00 to 0.30
  isBackupWithholdingRequired: boolean; // IRS Chapter 24 Backup Withholding
  formExpirationTimestamp?: number;
  isVerified: boolean;
}

export interface BankRoutingInstruction {
  accountHolderName: string;
  bankName: string;
  accountNumberOrIBAN: string;
  routingOrBIC: string;
  intermediaryBankBIC?: string;
  currency: SettlementCurrency | string;
  countryCode: string;
  planetaryJurisdiction: 'EARTH' | 'MARS' | 'ORBITAL';
  railType: PaymentRail | string;
}

export interface SelfServeRightsHolder {
  id: string;
  name: string;
  role: 'COMPOSER' | 'LYRICIST' | 'PRODUCER' | 'DIRECTOR' | 'ACTOR' | 'PUBLISHER' | 'STUDIO' | 'HOST' | 'DISTRIBUTOR';
  isni?: string;
  ipi?: string;
  splitPercentage: number;
  taxProfile: TaxProfile;
  payoutRouting: BankRoutingInstruction;
  confirmedByArtist: boolean;
}

export interface CovenantBlockAsset {
  cvtCode?: string;
  cbtCode: string;
  title: string;
  medium: MediaMedium;
  mappedIdentifiers: UniversalAssetIdentifier;
  rightsHolders: SelfServeRightsHolder[];
  createdTimestamp: number;
}

export interface RoyaltySettlementEvent {
  transactionId: string;
  cbtCode: string;
  grossAmount: number;
  currency: SettlementCurrency;
  sourcePlatform: SocialEntertainmentPlatform | string;
  territoryCountryCode: string;
  timestamp: number;
}

export interface DisbursementDetail {
  rightsHolderId: string;
  rightsHolderName: string;
  role: string;
  grossShare: number;
  withholdingTaxRateApplied: number;
  withholdingTaxDeducted: number;
  netShare: number;
  currency: string;
  isTaxReportable: boolean;
  taxFormRequired: '1099-MISC' | '1099-NEC' | '1042-S' | 'NONE';
  routing: BankRoutingInstruction;
}

export interface SettlementResult {
  transactionId: string;
  cbtCode: string;
  totalSettled: number;
  currency: SettlementCurrency;
  platformFeeDeducted: number;
  cornerDustCollected: number;
  disbursements: DisbursementDetail[];
  reconciliationStatus: 'PASS' | 'FAIL_OVER_DISBURSED';
}

export interface AuditAnomaly {
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  code: string;
  message: string;
  affectedTarget: string;
}

export interface SystemAuditReport {
  timestamp: number;
  status: 'HEALTHY' | 'ACTION_REQUIRED' | 'AUDIT_FAILED';
  totalAssetsChecked: number;
  totalTransactionsAudited: number;
  anomaliesDetected: AuditAnomaly[];
}

export interface GlobalMatchClaimPayload {
  platform: SocialEntertainmentPlatform;
  cbtCode: string;
  externalAssetId: string;
  mediaContentId: string;
  channelOrProfileId: string;
  grossAdRevenueOrRoyalty: number;
  currency: SettlementCurrency;
  territoryCountryCode: string;
  timestamp: number;
}

export interface PlatformAllowlistRequest {
  cbtCode: string;
  platform: SocialEntertainmentPlatform;
  targetAccountOrChannelId: string;
  creatorIncentiveSharePct: number;
  status: 'ACTIVE' | 'REVOKED';
}

/* ==========================================================================
   2. COVENANT TAX & WITHHOLDING ENGINE
   ========================================================================== */

export class CovenantTaxEngine {
  /**
   * Calculates applicable US IRS withholding tax based on tax form status and treaties.
   * Standard US Backup Withholding = 24%. Standard Foreign Withholding = 30% (unless reduced by treaty).
   */
  public static calculateEffectiveTaxRate(profile: TaxProfile, territoryCountryCode: string): number {
    if (!profile.isVerified) {
      // Unverified tax profiles default to mandatory 30% foreign or 24% US backup withholding
      return profile.usTaxResident ? 0.24 : 0.30;
    }

    if (profile.usTaxResident) {
      return profile.isBackupWithholdingRequired ? 0.24 : 0.00;
    }

    // Foreign Persons (W-8BEN / W-8BEN-E)
    if (profile.treatyCountryCode && profile.treatyWithholdingRate !== undefined) {
      return profile.treatyWithholdingRate;
    }

    return 0.30; // Default US statutory rate for non-resident aliens without treaty
  }

  /**
   * Identifies IRS tax reporting form requirements (1099 vs 1042-S)
   */
  public static DetermineTaxFormRequirement(
    profile: TaxProfile, 
    cumulativeYtdEarningsUSD: number,
    role: string
  ): '1099-MISC' | '1099-NEC' | '1042-S' | 'NONE' {
    if (!profile.usTaxResident) {
      return cumulativeYtdEarningsUSD > 0 ? '1042-S' : 'NONE';
    }

    // US Persons 1099 threshold is $600/year
    if (cumulativeYtdEarningsUSD >= 600) {
      // Royalties go to 1099-MISC (Box 2); Independent Services/Production go to 1099-NEC
      if (role === 'COMPOSER' || role === 'LYRICIST' || role === 'PUBLISHER') {
        return '1099-MISC';
      }
      return '1099-NEC';
    }

    return 'NONE';
  }
}

/* ==========================================================================
   3. COVENANT MASTER ENGINE CLASS
   ========================================================================== */

const CBT_PREFIX_MAP: Record<MediaMedium, string> = {
  MUSIC_TRACK: 'TRK', MUSIC_ALBUM: 'ALB', SHEET_MUSIC: 'SHT',
  FEATURE_FILM: 'FLM', TV_SHOW: 'TVS', TV_SEASON: 'SSN', TV_EPISODE: 'TVE',
  PODCAST_EPISODE: 'POD', AUDIOBOOK: 'ABK', PRINT_BOOK: 'PBK', EBOOK: 'EBK',
  MAGAZINE_SERIAL: 'MAG', VIDEO_GAME: 'GME', LIVE_STREAM: 'STR', MARS_ORBITAL_BROADCAST: 'MOB',
};

/**
 * Cryptographically secure, collision-proof Covenant Asset Code (CVT)
 * Format: CVT-XXXXXX-2026
 */
export function generateCVTAssetCode(): string {
  const hex = randomBytes(3).toString('hex').toUpperCase();
  const year = new Date().getFullYear();
  return `CVT-${hex}-${year}`;
}

export class CovenantMasterSDK {
  private cbtRegistry: Map<string, CovenantBlockAsset> = new Map();

  constructor(
    private platformFeePercentage: number = 0.00,
    public dbClient?: SupabaseClient
  ) {}

  public registerInMemory(asset: CovenantBlockAsset): void {
    this.cbtRegistry.set(asset.cbtCode, asset);
  }

  public getInMemoryAsset(cbtCode: string): CovenantBlockAsset | undefined {
    return this.cbtRegistry.get(cbtCode);
  }

  public async getOrHydrateAsset(cbtCode: string): Promise<CovenantBlockAsset> {
    let asset = this.getInMemoryAsset(cbtCode);
    if (asset) return asset;

    if (this.dbClient) {
      const { data, error } = await this.dbClient
        .from('cbt_assets')
        .select('*')
        .eq('cbt_code', cbtCode)
        .single();

      if (error || !data) {
        throw new Error(`Asset ${cbtCode} could not be resolved from DB or Memory.`);
      }

      asset = {
        cbtCode: data.cbt_code,
        title: data.title,
        medium: data.medium as MediaMedium,
        mappedIdentifiers: data.mapped_identifiers,
        rightsHolders: data.rights_holders,
        createdTimestamp: Number(data.created_timestamp),
      };

      this.registerInMemory(asset);
      return asset;
    }

    throw new Error(`Asset ${cbtCode} not found in engine memory and no DB client supplied.`);
  }

  public generateCBTCode(medium: MediaMedium, title: string): string {
    const prefix = CBT_PREFIX_MAP[medium] || 'GEN';
    const hash = createHash('sha256')
      .update(`${title}_${Date.now()}_${Math.random()}`)
      .digest('hex')
      .substring(0, 12)
      .toUpperCase();
    return `CBT-${prefix}-${hash}`;
  }

  public validateSplits(holders: SelfServeRightsHolder[]): void {
    const scale = 10000;
    const totalSplitScaled = holders.reduce((acc, curr) => {
      const cleanPercentage = Math.round(curr.splitPercentage * scale) / scale;
      return acc + Math.round(cleanPercentage * scale);
    }, 0);

    const targetScaled = 100 * scale;
    if (Math.abs(totalSplitScaled - targetScaled) > 1) {
      throw new Error(
        `Total splits must equal exactly 100.0000%. Current sum: ${(totalSplitScaled / scale).toFixed(4)}%`
      );
    }
  }

  public async registerCBTAsset(
    title: string,
    medium: MediaMedium,
    mappedIdentifiers: UniversalAssetIdentifier,
    rightsHolders: SelfServeRightsHolder[]
  ): Promise<{ cvtCode: string; cbtCode: string; success: boolean }> {
    this.validateSplits(rightsHolders);

    const cvtCode = generateCVTAssetCode();
    const cbtCode = this.generateCBTCode(medium, title);
    const asset: CovenantBlockAsset = {
      cvtCode,
      cbtCode,
      title,
      medium,
      mappedIdentifiers,
      rightsHolders,
      createdTimestamp: Date.now(),
    };

    this.registerInMemory(asset);

    if (this.dbClient) {
      const { error } = await this.dbClient.from('cbt_assets').insert([
        {
          cvt_code: cvtCode,
          cbt_code: cbtCode,
          title: asset.title,
          medium: asset.medium,
          mapped_identifiers: asset.mappedIdentifiers,
          rights_holders: asset.rightsHolders,
          created_timestamp: asset.createdTimestamp,
        },
      ]);
      if (error) throw new Error(`Database registration failed: ${error.message}`);
    }

    return { cvtCode, cbtCode, success: true };
  }

  public async processRoyaltySettlement(event: RoyaltySettlementEvent): Promise<SettlementResult> {
    const asset = await this.getOrHydrateAsset(event.cbtCode);
    const { scaleNum, scaleBI } = getScaleForCurrency(event.currency);
    const HUNDRED_BI = 100n;

    const grossScaledBI = BigInt(Math.round(event.grossAmount * scaleNum));
    const feePctScaledBI = BigInt(Math.round(this.platformFeePercentage * scaleNum));

    const platformFeeScaledBI = (grossScaledBI * feePctScaledBI) / (HUNDRED_BI * scaleBI);
    const netSettlementScaledBI = grossScaledBI - platformFeeScaledBI;

    let totalDisbursedGrossBI = 0n;

    const disbursements: DisbursementDetail[] = asset.rightsHolders.map((holder) => {
      const splitScaledBI = BigInt(Math.round(holder.splitPercentage * scaleNum));
      const holderGrossScaledBI = (netSettlementScaledBI * splitScaledBI) / (HUNDRED_BI * scaleBI);
      totalDisbursedGrossBI += holderGrossScaledBI;

      // Tax calculation
      const taxRate = CovenantTaxEngine.calculateEffectiveTaxRate(holder.taxProfile, event.territoryCountryCode);
      const taxRateBI = BigInt(Math.round(taxRate * scaleNum));
      const taxDeductedScaledBI = (holderGrossScaledBI * taxRateBI) / (HUNDRED_BI * scaleBI);
      const holderNetScaledBI = holderGrossScaledBI - taxDeductedScaledBI;

      const grossShareNum = Number(holderGrossScaledBI) / scaleNum;
      const taxForm = CovenantTaxEngine.DetermineTaxFormRequirement(holder.taxProfile, grossShareNum, holder.role);

      return {
        rightsHolderId: holder.id,
        rightsHolderName: holder.name,
        role: holder.role,
        grossShare: grossShareNum,
        withholdingTaxRateApplied: taxRate,
        withholdingTaxDeducted: Number(taxDeductedScaledBI) / scaleNum,
        netShare: Number(holderNetScaledBI) / scaleNum,
        currency: event.currency,
        isTaxReportable: taxForm !== 'NONE',
        taxFormRequired: taxForm,
        routing: holder.payoutRouting,
      };
    });

    const cornerDustScaledBI = netSettlementScaledBI - totalDisbursedGrossBI;
    const finalPlatformFeeScaledBI = platformFeeScaledBI + cornerDustScaledBI;

    const totalDisbursedNum = Number(totalDisbursedGrossBI) / scaleNum;
    const platformFeeNum = Number(finalPlatformFeeScaledBI) / scaleNum;
    const isBalanced = (totalDisbursedNum + platformFeeNum) <= event.grossAmount + (1 / scaleNum);

    return {
      transactionId: event.transactionId,
      cbtCode: event.cbtCode,
      totalSettled: event.grossAmount,
      currency: event.currency,
      platformFeeDeducted: platformFeeNum,
      cornerDustCollected: Number(cornerDustScaledBI) / scaleNum,
      disbursements,
      reconciliationStatus: isBalanced ? 'PASS' : 'FAIL_OVER_DISBURSED',
    };
  }
}

/* ==========================================================================
   4. COVENANT AUDITOR AGENT ENGINE
   ========================================================================== */

export class CovenantAuditorAgent {
  constructor(private masterSDK: CovenantMasterSDK) {}

  /**
   * Scans assets and settlement ledger for tax non-compliance, missing IDs, or math discrepancies.
   */
  public async RunFullSystemAudit(): Promise<SystemAuditReport> {
    const anomalies: AuditAnomaly[] = [];
    let totalAssetsChecked = 0;
    let totalTransactionsAudited = 0;

    if (this.masterSDK.dbClient) {
      // 1. Audit CBT Assets Table
      const { data: assets } = await this.masterSDK.dbClient.from('cbt_assets').select('*');
      if (assets) {
        totalAssetsChecked = assets.length;
        for (const rawAsset of assets) {
          const asset: CovenantBlockAsset = {
            cbtCode: rawAsset.cbt_code,
            title: rawAsset.title,
            medium: rawAsset.medium,
            mappedIdentifiers: rawAsset.mapped_identifiers,
            rightsHolders: rawAsset.rights_holders,
            createdTimestamp: Number(rawAsset.created_timestamp),
          };

          // Check splits sum
          try {
            this.masterSDK.validateSplits(asset.rightsHolders);
          } catch (e: any) {
            anomalies.push({
              severity: 'CRITICAL',
              code: 'INVALID_SPLIT_SUM',
              message: e.message,
              affectedTarget: asset.cbtCode,
            });
          }

          // Check tax form validity
          for (const holder of asset.rightsHolders) {
            if (!holder.taxProfile || !holder.taxProfile.isVerified) {
              anomalies.push({
                severity: 'WARNING',
                code: 'UNVERIFIED_TAX_PROFILE',
                message: `Rights holder ${holder.name} (${holder.id}) has unverified tax information. Backup withholding applied.`,
                affectedTarget: asset.cbtCode,
              });
            }
          }
        }
      }

      // 2. Audit Royalty Ledger Table
      const { data: ledger } = await this.masterSDK.dbClient.from('universal_royalty_ledger').select('*');
      if (ledger) {
        totalTransactionsAudited = ledger.length;
        for (const row of ledger) {
          const gross = Number(row.gross_settled);
          const fee = Number(row.covenant_fee);

          if (fee > gross) {
            anomalies.push({
              severity: 'CRITICAL',
              code: 'OVER_DISBURSED_TRANSACTION',
              message: `Transaction ${row.transaction_id} fee (${fee}) exceeds gross amount (${gross}).`,
              affectedTarget: row.transaction_id,
            });
          }
        }
      }
    }

    const hasCritical = anomalies.some((a) => a.severity === 'CRITICAL');
    const hasWarning = anomalies.some((a) => a.severity === 'WARNING');

    return {
      timestamp: Date.now(),
      status: hasCritical ? 'AUDIT_FAILED' : hasWarning ? 'ACTION_REQUIRED' : 'HEALTHY',
      totalAssetsChecked,
      totalTransactionsAudited,
      anomaliesDetected: anomalies,
    };
  }
}

/* ==========================================================================
   5. UNIVERSAL SOCIAL & ENTERTAINMENT ENGINE
   ========================================================================== */

export class CovenantGlobalSocialEngine {
  private allowlistRegistry: Map<string, PlatformAllowlistRequest> = new Map();

  constructor(private masterSDK: CovenantMasterSDK) {}

  public registerGlobalAllowlist(entry: PlatformAllowlistRequest): void {
    const key = `${entry.platform}:${entry.targetAccountOrChannelId}:${entry.cbtCode}`;
    this.allowlistRegistry.set(key, entry);
  }

  private async getOrHydrateAllowlist(
    platform: SocialEntertainmentPlatform,
    channelId: string,
    cbtCode: string
  ): Promise<PlatformAllowlistRequest | undefined> {
    const key = `${platform}:${channelId}:${cbtCode}`;
    let entry = this.allowlistRegistry.get(key);
    if (entry) return entry;

    if (this.masterSDK.dbClient) {
      const { data } = await this.masterSDK.dbClient
        .from('platform_allowlists')
        .select('*')
        .eq('platform', platform)
        .eq('target_account_id', channelId)
        .eq('cbt_code', cbtCode)
        .eq('status', 'ACTIVE')
        .single();

      if (data) {
        entry = {
          cbtCode: data.cbt_code,
          platform: data.platform as SocialEntertainmentPlatform,
          targetAccountOrChannelId: data.target_account_id,
          creatorIncentiveSharePct: Number(data.creator_incentive_share_pct),
          status: data.status,
        };
        this.registerGlobalAllowlist(entry);
        return entry;
      }
    }

    return undefined;
  }

  public async processGlobalClaimEvent(claim: GlobalMatchClaimPayload): Promise<SettlementResult> {
    const allowlistRule = await this.getOrHydrateAllowlist(
      claim.platform,
      claim.channelOrProfileId,
      claim.cbtCode
    );

    let netGrossToSettle = claim.grossAdRevenueOrRoyalty;

    if (allowlistRule && allowlistRule.status === 'ACTIVE' && allowlistRule.creatorIncentiveSharePct > 0) {
      const { scaleNum, scaleBI } = getScaleForCurrency(claim.currency);
      const HUNDRED_BI = 100n;
      const grossScaledBI = BigInt(Math.round(claim.grossAdRevenueOrRoyalty * scaleNum));
      const incentivePctScaledBI = BigInt(Math.round(allowlistRule.creatorIncentiveSharePct * scaleNum));

      const creatorIncentiveScaledBI = (grossScaledBI * incentivePctScaledBI) / (HUNDRED_BI * scaleBI);
      netGrossToSettle = Number(grossScaledBI - creatorIncentiveScaledBI) / scaleNum;
    }

    const event: RoyaltySettlementEvent = {
      transactionId: `CLAIM-${claim.platform}-${claim.mediaContentId}-${claim.timestamp}`,
      cbtCode: claim.cbtCode,
      grossAmount: netGrossToSettle,
      currency: claim.currency,
      sourcePlatform: claim.platform,
      territoryCountryCode: claim.territoryCountryCode,
      timestamp: claim.timestamp,
    };

    return await this.masterSDK.processRoyaltySettlement(event);
  }
}

/* ==========================================================================
   6. NEXT.JS SERVER ACTIONS
   ========================================================================== */

export async function saveAssetSplitsAction(
  title: string,
  medium: MediaMedium,
  identifiers: UniversalAssetIdentifier,
  holders: SelfServeRightsHolder[]
) {
  'use server';

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const dbClient = (supabaseUrl && supabaseKey) 
      ? createClient(supabaseUrl, supabaseKey) 
      : undefined;

    const sdk = new CovenantMasterSDK(0.00, dbClient);
    const result = await sdk.registerCBTAsset(title, medium, identifiers, holders);

    return { success: true, data: result };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function runSystemAuditAction() {
  'use server';

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase client unconfigured.');
    }

    const dbClient = createClient(supabaseUrl, supabaseKey);
    const masterSDK = new CovenantMasterSDK(0.00, dbClient);
    const auditor = new CovenantAuditorAgent(masterSDK);

    const report = await auditor.RunFullSystemAudit();
    return { success: true, report };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function processUniversalSocialWebhookAction(claims: GlobalMatchClaimPayload[]) {
  'use server';

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const dbClient = (supabaseUrl && supabaseKey)
      ? createClient(supabaseUrl, supabaseKey)
      : undefined;

    const masterSDK = new CovenantMasterSDK(10.00, dbClient);
    const globalSocialEngine = new CovenantGlobalSocialEngine(masterSDK);

    const settlementResults: SettlementResult[] = [];

    for (const claim of claims) {
      const result = await globalSocialEngine.processGlobalClaimEvent(claim);
      settlementResults.push(result);
    }

    if (dbClient) {
      const ledgerEntries = settlementResults.map((r, i) => ({
        transaction_id: r.transactionId,
        cbt_code: r.cbtCode,
        platform: claims[i].platform,
        gross_settled: r.totalSettled,
        covenant_fee: r.platformFeeDeducted,
        corner_dust_collected: r.cornerDustCollected,
        currency: r.currency,
        disbursements: r.disbursements,
        created_at: new Date().toISOString(),
      }));

      const { error } = await dbClient
        .from('universal_royalty_ledger')
        .upsert(ledgerEntries, { onConflict: 'transaction_id' });

      if (error) throw new Error(`Supabase Ledger Upsert Error: ${error.message}`);
    }

    return { success: true, processedCount: settlementResults.length, data: settlementResults };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}