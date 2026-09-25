import {
  identifiersShareBoundCode,
} from "./identifiers";
import type {
  Universal20Identifiers,
  UniversalWorkManifest,
} from "./types";

export const ROYALTY_CHANNEL_SOURCES = [
  "PRO_CMO_UNMATCHED",
  "SOCIAL_UGC",
  "SYNC_CUE_SHEETS",
  "DSP_DIRECT_DISTRIBUTION",
  "LIVE_VENUE_PERFORMANCE",
  "GAMING_INTERACTIVE",
] as const;

export type RoyaltyChannelSource = (typeof ROYALTY_CHANNEL_SOURCES)[number];

export const MATCH_TYPES = [
  "EXACT_CODE_MATCH",
  "FUZZY_METADATA_MATCH",
  "CUE_SHEET_LEGAL_LOD",
] as const;

export type MatchType = (typeof MATCH_TYPES)[number];

export type UnclaimedRoyaltyRecord = {
  recordId: string;
  sourceChannel: RoyaltyChannelSource;
  sourceEntityName: string;
  /** Integer cents sitting in an unmatched / escrow pool. */
  unallocatedAmountCents: number;
  currency: string;
  /** ISO-3166-1 alpha-2. */
  territory: string;
  rawMetadata: {
    title?: string;
    artistOrWriterName?: string;
    identifiers?: Partial<Universal20Identifiers>;
    cueSheetId?: string;
    venueName?: string;
    confidenceScore?: number;
  };
  holdingPeriodEnd: string;
};

export type MatchingResult = {
  matchedWorkId: string;
  recordId: string;
  sourceChannel: RoyaltyChannelSource;
  recoveredAmountCents: number;
  currency: string;
  matchType: MatchType;
  confidenceScore: number;
};

export type BlackBoxReconcileResult = {
  totalRecordsEvaluated: number;
  totalRecoveredRevenueCents: number;
  channelBreakdownCents: Record<RoyaltyChannelSource, number>;
  matches: MatchingResult[];
};

const FUZZY_RECOVERY_FLOOR = 0.7;

function emptyChannelBreakdown(): Record<RoyaltyChannelSource, number> {
  return {
    PRO_CMO_UNMATCHED: 0,
    SOCIAL_UGC: 0,
    SYNC_CUE_SHEETS: 0,
    DSP_DIRECT_DISTRIBUTION: 0,
    LIVE_VENUE_PERFORMANCE: 0,
    GAMING_INTERACTIVE: 0,
  };
}

function normalizeText(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized === "" ? undefined : normalized;
}

function matchableCents(amount: number): number | undefined {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    return undefined;
  }
  return amount;
}

function workPartyNames(work: UniversalWorkManifest): string[] {
  const names: string[] = [];
  for (const party of work.splits) {
    const name = normalizeText(party.name);
    if (name) {
      names.push(name);
    }
  }
  return names;
}

function fuzzyConfidence(
  record: UnclaimedRoyaltyRecord,
  work: UniversalWorkManifest,
): number {
  const title = normalizeText(record.rawMetadata.title);
  const workTitle = normalizeText(work.title);
  const artist = normalizeText(record.rawMetadata.artistOrWriterName);
  const names = workPartyNames(work);
  const titleHit = title !== undefined && workTitle !== undefined && title === workTitle;
  const artistHit = artist !== undefined && names.includes(artist);
  if (titleHit && artistHit) {
    return 0.85;
  }
  if (titleHit) {
    return 0.7;
  }
  if (artistHit) {
    return 0.55;
  }
  return 0;
}

function findExactWork(
  record: UnclaimedRoyaltyRecord,
  registeredWorks: UniversalWorkManifest[],
): UniversalWorkManifest | undefined {
  return registeredWorks.find((work) =>
    identifiersShareBoundCode(record.rawMetadata.identifiers, work.identifiers),
  );
}

function findCueSheetWork(
  record: UnclaimedRoyaltyRecord,
  registeredWorks: UniversalWorkManifest[],
): UniversalWorkManifest | undefined {
  if (record.sourceChannel !== "SYNC_CUE_SHEETS") {
    return undefined;
  }
  const cueSheetId = normalizeText(record.rawMetadata.cueSheetId);
  const title = normalizeText(record.rawMetadata.title);
  if (!cueSheetId || !title) {
    return undefined;
  }
  return registeredWorks.find((work) => normalizeText(work.title) === title);
}

function findFuzzyWork(
  record: UnclaimedRoyaltyRecord,
  registeredWorks: UniversalWorkManifest[],
): { work: UniversalWorkManifest; confidenceScore: number } | undefined {
  let best: { work: UniversalWorkManifest; confidenceScore: number } | undefined;
  for (const work of registeredWorks) {
    const confidenceScore = fuzzyConfidence(record, work);
    if (confidenceScore < FUZZY_RECOVERY_FLOOR) {
      continue;
    }
    if (!best || confidenceScore > best.confidenceScore) {
      best = { work, confidenceScore };
    }
  }
  return best;
}

/**
 * Sandbox unmatched-pool reconciliation.
 * Matches unclaimed records to registered Covenant works by exact UGI,
 * cue-sheet title + LOD, then fuzzy title/writer metadata.
 * Money is integer cents. Does not call live PRO / DSP / Covenant HTTP.
 */
export class CovenantUniversalBlackBoxSweeper {
  public async reconcileBlackBoxPool(
    unclaimedRecords: UnclaimedRoyaltyRecord[],
    registeredWorks: UniversalWorkManifest[],
  ): Promise<BlackBoxReconcileResult> {
    const matches: MatchingResult[] = [];
    let totalRecoveredRevenueCents = 0;
    const channelBreakdownCents = emptyChannelBreakdown();

    for (const record of unclaimedRecords) {
      const recoveredAmountCents = matchableCents(record.unallocatedAmountCents);
      if (recoveredAmountCents === undefined) {
        continue;
      }

      const exactWork = findExactWork(record, registeredWorks);
      if (exactWork) {
        matches.push({
          matchedWorkId: exactWork.workId,
          recordId: record.recordId,
          sourceChannel: record.sourceChannel,
          recoveredAmountCents,
          currency: record.currency,
          matchType: "EXACT_CODE_MATCH",
          confidenceScore: 1,
        });
        totalRecoveredRevenueCents += recoveredAmountCents;
        channelBreakdownCents[record.sourceChannel] += recoveredAmountCents;
        continue;
      }

      const cueWork = findCueSheetWork(record, registeredWorks);
      if (cueWork) {
        matches.push({
          matchedWorkId: cueWork.workId,
          recordId: record.recordId,
          sourceChannel: record.sourceChannel,
          recoveredAmountCents,
          currency: record.currency,
          matchType: "CUE_SHEET_LEGAL_LOD",
          confidenceScore: 0.95,
        });
        totalRecoveredRevenueCents += recoveredAmountCents;
        channelBreakdownCents[record.sourceChannel] += recoveredAmountCents;
        continue;
      }

      const fuzzy = findFuzzyWork(record, registeredWorks);
      if (fuzzy) {
        matches.push({
          matchedWorkId: fuzzy.work.workId,
          recordId: record.recordId,
          sourceChannel: record.sourceChannel,
          recoveredAmountCents,
          currency: record.currency,
          matchType: "FUZZY_METADATA_MATCH",
          confidenceScore: fuzzy.confidenceScore,
        });
        totalRecoveredRevenueCents += recoveredAmountCents;
        channelBreakdownCents[record.sourceChannel] += recoveredAmountCents;
      }
    }

    return {
      totalRecordsEvaluated: unclaimedRecords.length,
      totalRecoveredRevenueCents,
      channelBreakdownCents,
      matches,
    };
  }
}
