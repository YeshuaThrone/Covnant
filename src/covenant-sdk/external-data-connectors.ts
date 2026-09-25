/**
 * Sandbox Luminate + Jaxsta normalizers.
 * Does not call live Luminate, Jaxsta, DSP, or PRO HTTP.
 * Estimated yield is integer cents from USD micros (1_000_000 micros = $1).
 */

import { FX_MICROS } from "./fx";
import type { Universal20Identifiers } from "./types";
import type { UnclaimedRoyaltyRecord } from "./universal-blackbox-sweeper";

export const SANDBOX_LUMINATE_URL = "sandbox://luminate";

/** Paste benchmark $0.0038/unit → 3_800 USD micros. */
export const DEFAULT_LUMINATE_RATE_MICROS = 3_800;

export type LuminateConsumptionPayload = {
  luminateId: string;
  isrc?: string;
  upc?: string;
  songTitle: string;
  artistName: string;
  labelOrDistributor?: string;
  airplaySpins?: number;
  onDemandAudioStreams?: number;
  physicalSales?: number;
  periodStartDate: string;
  periodEndDate: string;
  marketTerritory: string;
};

export type JaxstaMatchedWriter = {
  writerName: string;
  ipi?: string;
  role: string;
};

export type JaxstaCreditRecord = {
  jaxstaEntityId: string;
  isrc?: string;
  iswc?: string;
  trackTitle: string;
  matchedWriters: JaxstaMatchedWriter[];
  publisherName?: string;
  unclaimedStatusFlag: boolean;
};

function defaultClock(): Date {
  return new Date();
}

function addUtcYears(from: Date, years: number): Date {
  const next = new Date(from.getTime());
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next;
}

function slugIdPart(value: string): string {
  const slug = value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug === "" ? "NA" : slug.slice(0, 40);
}

function optionalBound(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function sandboxBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl !== undefined && baseUrl.startsWith("sandbox://")) {
    return baseUrl;
  }
  return SANDBOX_LUMINATE_URL;
}

/**
 * units * rateMicros → integer cents. Floors leftover micros; never toFixed.
 */
export function yieldCentsFromUnits(
  units: number,
  rateMicros: number = DEFAULT_LUMINATE_RATE_MICROS,
): number | undefined {
  if (!Number.isSafeInteger(units) || units < 0) {
    return undefined;
  }
  if (!Number.isSafeInteger(rateMicros) || rateMicros < 0) {
    return undefined;
  }
  if (units > 0 && rateMicros > 0) {
    const maxUnits = Math.floor(Number.MAX_SAFE_INTEGER / (rateMicros * 100));
    if (units > maxUnits) {
      return undefined;
    }
  }
  return Math.floor((units * rateMicros * 100) / FX_MICROS);
}

function consumptionUnits(item: LuminateConsumptionPayload): number | undefined {
  const streams = item.onDemandAudioStreams ?? 0;
  const airplay = item.airplaySpins ?? 0;
  if (!Number.isSafeInteger(streams) || streams < 0) {
    return undefined;
  }
  if (!Number.isSafeInteger(airplay) || airplay < 0) {
    return undefined;
  }
  const units = streams + airplay;
  if (!Number.isSafeInteger(units) || units < 0) {
    return undefined;
  }
  return units;
}

/**
 * Normalizes Luminate consumption / Jaxsta credit feeds into unclaimed records.
 * Constructor accepts an API key for paste compatibility; it is never sent.
 */
export class CovenantExternalDataIngestionEngine {
  private readonly luminateApiBaseUrl: string;
  private readonly luminateApiKey: string;
  private readonly clock: () => Date;

  constructor(
    options: { apiKey?: string; baseUrl?: string; clock?: () => Date } = {},
  ) {
    this.luminateApiKey = options.apiKey ?? "";
    this.luminateApiBaseUrl = sandboxBaseUrl(options.baseUrl);
    this.clock = options.clock ?? defaultClock;
  }

  public getSandboxNodeUrl(): string {
    return this.luminateApiBaseUrl;
  }

  public hasSandboxCredential(): boolean {
    return this.luminateApiKey.length > 0;
  }

  public parseLuminateConsumptionData(
    luminatePayloads: LuminateConsumptionPayload[],
    estimatedPerStreamRateMicros?: number,
  ): UnclaimedRoyaltyRecord[] {
    const rateMicros =
      estimatedPerStreamRateMicros ?? DEFAULT_LUMINATE_RATE_MICROS;
    const holdingPeriodEnd = addUtcYears(this.clock(), 2).toISOString();
    const unclaimedRecords: UnclaimedRoyaltyRecord[] = [];

    for (const item of luminatePayloads) {
      const luminateId = optionalBound(item.luminateId);
      if (!luminateId) {
        continue;
      }
      const units = consumptionUnits(item);
      const unallocatedAmountCents =
        units === undefined
          ? undefined
          : yieldCentsFromUnits(units, rateMicros);
      if (unallocatedAmountCents === undefined) {
        continue;
      }
      const isrc = optionalBound(item.isrc);
      const upc = optionalBound(item.upc);
      const identifiers: Universal20Identifiers = {
        ...(isrc ? { isrc } : {}),
        ...(upc ? { upc } : {}),
      };
      unclaimedRecords.push({
        recordId: `LUMINATE_${slugIdPart(luminateId)}`,
        sourceChannel: "DSP_DIRECT_DISTRIBUTION",
        sourceEntityName: `Luminate_Audit_${slugIdPart(item.labelOrDistributor ?? "Unknown_Distro")}`,
        unallocatedAmountCents,
        currency: "USD",
        territory: optionalBound(item.marketTerritory) ?? "US",
        rawMetadata: {
          title: optionalBound(item.songTitle),
          artistOrWriterName: optionalBound(item.artistName),
          identifiers,
          confidenceScore: 0.95,
        },
        holdingPeriodEnd,
      });
    }

    return unclaimedRecords;
  }

  public parseJaxstaCreditFeed(
    jaxstaRecords: JaxstaCreditRecord[],
  ): UnclaimedRoyaltyRecord[] {
    const holdingPeriodEnd = addUtcYears(this.clock(), 3).toISOString();
    const unclaimedRecords: UnclaimedRoyaltyRecord[] = [];

    for (const credit of jaxstaRecords) {
      const jaxstaEntityId = optionalBound(credit.jaxstaEntityId);
      if (!jaxstaEntityId) {
        continue;
      }
      const iswc = optionalBound(credit.iswc);
      if (!credit.unclaimedStatusFlag && iswc) {
        continue;
      }
      const writerNames = credit.matchedWriters
        .map((writer) => optionalBound(writer.writerName))
        .filter((name): name is string => name !== undefined);
      const isrc = optionalBound(credit.isrc);
      const identifiers: Universal20Identifiers = {
        ...(isrc ? { isrc } : {}),
        ...(iswc ? { iswc } : {}),
      };
      unclaimedRecords.push({
        recordId: `JAXSTA_${slugIdPart(jaxstaEntityId)}`,
        sourceChannel: "PRO_CMO_UNMATCHED",
        sourceEntityName: "Jaxsta_Credit_Registry",
        unallocatedAmountCents: 0,
        currency: "USD",
        territory: "WW",
        rawMetadata: {
          title: optionalBound(credit.trackTitle),
          artistOrWriterName:
            writerNames.length > 0 ? writerNames.join(", ") : undefined,
          identifiers,
          confidenceScore: 0.92,
        },
        holdingPeriodEnd,
      });
    }

    return unclaimedRecords;
  }
}
