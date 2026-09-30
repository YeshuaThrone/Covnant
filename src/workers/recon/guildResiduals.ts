/**
 * CVT recon worker — guild residual compliance holds (film waterfall
 * directive, Tier 2).
 *
 * Founder canon: SAG-AFTRA, WGA, and DGA residuals are calculated
 * automatically from film statements before net investor or producer funds
 * release — a calculated obligation is never silently skipped, and the
 * waterfall's Tier 2 is where CAMA fees and guild residual compliance holds
 * live.
 *
 * The rate tables are versioned contracts: each version pins its rates and
 * an effective date, and a statement's period selects the latest version
 * effective on or before the period's first day. A renegotiated rate lands
 * as a new version row — the calculation never rewrites history, and a
 * period before every version's effective date fails closed (no guessed
 * rate).
 *
 * The obligations ride the existing match_queue as Tier 2 hold rows
 * (rights_type 'unknown' — residuals are neither recording nor composition
 * royalties, so the split-quarantine rule keeps them out of split math),
 * tagged with the provenance needed to recompute them from the tag alone.
 */

import type {
  GuildResidualGuild,
  GuildResidualTag,
  ParsedStatementLine,
} from "./records";
import { StatementParseError } from "./records";

export interface GuildResidualRateVersion {
  /** Version label — stable, rides the hold row's provenance. */
  version: string;
  /** ISO date the version takes effect. */
  effectiveFrom: string;
  /** Rate per guild, whole basis points (650 bps = 6.5%). */
  rates: Readonly<Record<GuildResidualGuild, number>>;
  note: string;
}

/**
 * The versioned rate contracts. Rates are the pinned values of each version
 * — pinned by fixtures, never float-adjusted. Adding a version is additive;
 * existing versions are immutable history.
 */
export const GUILD_RESIDUAL_RATE_TABLES: Readonly<
  Record<GuildResidualGuild, readonly GuildResidualRateVersion[]>
> = {
  SAG_AFTRA: [
    {
      version: "2026-contract",
      effectiveFrom: "2026-01-01",
      rates: { SAG_AFTRA: 640, WGA: 0, DGA: 0 },
      note: "SAG-AFTRA table v1 — 2026 contract pinned value (6.4% of receipts).",
    },
  ],
  WGA: [
    {
      version: "2026-contract",
      effectiveFrom: "2026-01-01",
      rates: { SAG_AFTRA: 0, WGA: 150, DGA: 0 },
      note: "WGA table v1 — 2026 contract pinned value (1.5% of receipts).",
    },
  ],
  DGA: [
    {
      version: "2026-contract",
      effectiveFrom: "2026-01-01",
      rates: { SAG_AFTRA: 0, WGA: 0, DGA: 180 },
      note: "DGA table v1 — 2026 contract pinned value (1.8% of receipts).",
    },
  ],
};

export const GUILD_RESIDUAL_GUILDS: readonly GuildResidualGuild[] = [
  "SAG_AFTRA",
  "WGA",
  "DGA",
];

/** The period cell's first day, as an ISO date — "2026-08" → "2026-08-01". */
function periodStartDate(period: string): string {
  if (/^\d{4}-\d{2}$/.test(period)) return `${period}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) return period;
  throw new StatementParseError(`invalid_period:${period}`);
}

/**
 * The latest version of the guild's table whose effective date is on or
 * before the period's first day — or null when the period predates every
 * version (the caller fails closed; no guessed rate).
 */
export function selectRateVersion(
  guild: GuildResidualGuild,
  period: string,
): GuildResidualRateVersion | null {
  const periodStart = periodStartDate(period);
  const applicable = GUILD_RESIDUAL_RATE_TABLES[guild]
    .filter((version) => version.effectiveFrom <= periodStart)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return applicable[0] ?? null;
}

/** Floor(base × rate / 10000) in 1e-8 micros — exact bigint math. */
export function residualObligationMicros(baseMicros: bigint, rateBps: number): bigint {
  return (baseMicros * BigInt(rateBps)) / 10000n;
}

/**
 * Calculates the guild residual obligations for one film statement's
 * receipt lines: every non-adjustment film line spawns one hold row per
 * guild whose selected version carries a non-zero rate. Music lines are
 * out of scope (guild residuals are film-waterfall obligations).
 */
export function calculateGuildResiduals(
  lines: readonly ParsedStatementLine[],
): readonly ParsedStatementLine[] {
  const holds: ParsedStatementLine[] = [];
  for (const line of lines) {
    if (line.statementSourceType === null) continue;
    if (line.isAdjustment || line.grossMicros <= 0n) continue;
    const period = line.period;
    if (period === null) {
      throw new StatementParseError(`missing_period:row_${line.lineNumber}`);
    }
    for (const guild of GUILD_RESIDUAL_GUILDS) {
      const version = selectRateVersion(guild, period);
      if (version === null) {
        // Fail closed: a period with no rate version cannot be processed
        // silently — the job fails honestly instead of a guessed rate.
        throw new StatementParseError(
          `no_rate_version:${guild}:${period}:row_${line.lineNumber}`,
        );
      }
      const rateBps = version.rates[guild];
      if (rateBps === 0) continue;
      const obligation = residualObligationMicros(line.grossMicros, rateBps);
      const tag: GuildResidualTag = {
        guild,
        rate_table_version: version.version,
        effective_from: version.effectiveFrom,
        rate_bps: rateBps,
        base_micros: line.grossMicros.toString(),
        obligation_micros: obligation.toString(),
      };
      holds.push({
        ...line,
        tierLevel: 2,
        grossMicros: obligation,
        isAdjustment: false,
        identifiers: {},
        usageNote: `guild residual compliance hold — tier 2 (${tag.guild}, rate table ${tag.rate_table_version} @ ${tag.rate_bps} bps)`,
        guildResidual: tag,
      });
    }
  }
  return holds;
}
