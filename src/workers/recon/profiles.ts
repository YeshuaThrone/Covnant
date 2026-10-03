/**
 * CVT recon worker — strict statement profiles.
 *
 * Findings §D6 (SDK): no industry CSV royalty standard exists; every sender
 * ships a different layout. Each profile therefore defines ONE strict
 * layout — exact header (order + columns), required cells, bounded value
 * maps — and accepts only files that match it. The profile is the contract,
 * pinned by checked-in fixtures; the alternative (a permissive guesser) is
 * the silent-misparse behavior the recon engine exists to prevent.
 *
 * Rights separation (V1 directive): the profile IS the statement context —
 * a distributor dashboard reports recording (master) royalties, a PRO
 * distribution reports composition (publishing) royalties, film distributor
 * statements report picture receipts (neither master nor publishing →
 * 'unknown', quarantined from split math until reclassified). The tag is
 * explicit, never guessed from rights_pipeline.
 *
 * Film waterfall (V1 directive): statement receipt lines ride tier 0 — the
 * collection-account entry tier the waterfall allocator refines (migration
 * 0011's tier_level canon). Guild residual obligations are calculated
 * separately (guildResiduals.ts) and ride tier 2.
 */

import { canonicalizeIdentifier } from "../../../covnant-sdk/src/contracts/identifiers";
import { PODCAST_PROFILES } from "./podcastProfiles";
import { MERCH_PROFILES } from "./merchProfiles";
import { AI_PROFILES } from "./aiProfiles";
import { GAMING_PROFILES } from "./gamingProfiles";
import { LIVESTREAM_PROFILES } from "./livestreamProfiles";
import { WEBTOON_PROFILES } from "./webtoonProfiles";
import { LICENSING_PROFILES } from "./licensingProfiles";
import { NIL_PROFILES } from "./nilProfiles";
import { SPATIAL_PROFILES } from "./spatialProfiles";
import { FITNESS_PROFILES } from "./fitnessProfiles";
import { FOOD_PROFILES } from "./foodProfiles";
import { SERVICE_PROFILES } from "./serviceProfiles";
import { DEVELOPER_PROFILES } from "./developerProfiles";
import { HARDWARE_PROFILES } from "./hardwareProfiles";
import { ENERGY_PROFILES } from "./energyProfiles";
import { ART_PROFILES } from "./artProfiles";
import {
  optionalCell,
  parseStatementMoney,
  readStrictTable,
  requiredCell,
  sniffHeaderMatches,
} from "./delimited";
import type {
  ParsedStatementLine,
  ReconIdentifiers,
  RightsPipeline,
  StatementProfile,
  StatementProfileKind,
} from "./records";
import { StatementParseError } from "./records";

const CSV = ",";
const TSV = "\t";

/** Canonicalizes one identifier cell through the singular registry. */
function canonicalIdentifier(
  kind: keyof ReconIdentifiers,
  cell: string,
  rowNumber: number,
): ReconIdentifiers {
  const trimmed = cell.trim();
  if (trimmed === "") return {};
  const canonical = canonicalizeIdentifier(kind, trimmed);
  if (canonical === null) {
    throw new StatementParseError(`invalid_${kind.toLowerCase()}:row_${rowNumber}`);
  }
  return { [kind]: canonical };
}

/** Currency cell — ISO 4217 alpha-3, row-scoped rejection. */
function currencyCell(values: ReadonlyMap<string, string>, rowNumber: number): string {
  const currency = requiredCell(values, "Currency", rowNumber);
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new StatementParseError(`invalid_currency:row_${rowNumber}`);
  }
  return currency;
}

/** Money cell wrapper — attributes decimalToMicros rejections to the row. */
function moneyCell(values: ReadonlyMap<string, string>, column: string, rowNumber: number) {
  const cell = requiredCell(values, column, rowNumber);
  try {
    return parseStatementMoney(cell);
  } catch (error) {
    if (error instanceof StatementParseError) {
      throw new StatementParseError(`${error.reason}:${column}:row_${rowNumber}`);
    }
    throw error;
  }
}

interface MusicRowContext {
  title: string;
  identifiers: ReconIdentifiers;
  store: string | null;
  territory: string | null;
  platform: string | null;
}

/** Assembles one music line (master or publishing lane) from raw cells. */
function musicLine(
  profile: StatementProfileKind,
  lane: "master" | "publishing",
  rightsPipeline: RightsPipeline,
  rowNumber: number,
  period: string | null,
  currency: string,
  money: { micros: bigint; negative: boolean },
  context: MusicRowContext,
  raw: readonly string[],
): ParsedStatementLine {
  return {
    lineNumber: rowNumber,
    profile,
    rightsType: lane,
    statementSourceType: null,
    tierLevel: null,
    rightsPipeline,
    period,
    currency,
    grossMicros: money.micros,
    isAdjustment: money.negative,
    identifiers: context.identifiers,
    workTitle: context.title,
    territory: context.territory,
    platform: context.platform,
    usageNote: rightsPipeline,
    raw,
    guildResidual: null,
    podcastDetail: null,
    gamingDetail: null,
    livestreamDetail: null,
    webtoonDetail: null,
    merchDetail: null,
    aiDetail: null,
  };
}

// ---------------------------------------------------------------------------
// DistroKid-style CSV — recording (master) royalties from a distributor
// dashboard. Interactive stores are pinned to master_interactive; download
// stores to master_digital_performance; a store outside the map is a
// rejection (the map grows by one line when a new store needs support).
// ---------------------------------------------------------------------------

const DISTROKID_HEADER = [
  "Sale Date",
  "Store",
  "Artist",
  "Title",
  "ISRC",
  "UPC",
  "Country Of Sale",
  "Quantity",
  "Unit Price",
  "Currency",
  "Net Earnings",
  "Reporting Period",
] as const;

const INTERACTIVE_STREAMING_STORES = new Set([
  "Spotify",
  "Apple Music",
  "Amazon Music",
  "TIDAL",
  "Deezer",
  "YouTube Music",
  "Pandora",
]);

const DOWNLOAD_STORES = new Set(["iTunes", "Amazon MP3", "Google Play", "Bandcamp"]);

function distrokidPipeline(store: string): RightsPipeline {
  if (INTERACTIVE_STREAMING_STORES.has(store)) return "master_interactive";
  if (DOWNLOAD_STORES.has(store)) return "master_digital_performance";
  throw new StatementParseError(`unknown_store:${store}`);
}

const distrokidProfile: StatementProfile = {
  kind: "distrokid_csv",
  title: "DistroKid-style distributor earnings CSV",
  laneRightsType: "master",
  statementSourceType: null,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, DISTROKID_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, DISTROKID_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const store = requiredCell(values, "Store", rowNumber);
      const title = requiredCell(values, "Title", rowNumber);
      const money = moneyCell(values, "Net Earnings", rowNumber);
      const identifiers: ReconIdentifiers = {
        ...canonicalIdentifier("ISRC", values.get("ISRC") ?? "", rowNumber),
        ...canonicalIdentifier("UPC", values.get("UPC") ?? "", rowNumber),
      };
      const pipeline = distrokidPipeline(store);
      return musicLine(
        "distrokid_csv",
        "master",
        pipeline,
        rowNumber,
        optionalCell(values, "Reporting Period"),
        currencyCell(values, rowNumber),
        money,
        {
          title,
          identifiers,
          store,
          territory: optionalCell(values, "Country Of Sale"),
          platform: store,
        },
        DISTROKID_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// TuneCore-style TSV — recording (master) royalties. Gross Amount is sender
// provenance (the store's gross before the store's fee); the event money is
// "Your Net Receipts" — what actually moves toward the rights holder. The
// verbatim row rides raw_payload either way, so the distinction is always
// auditable.
// ---------------------------------------------------------------------------

const TUNECORE_HEADER = [
  "Transaction Date",
  "Transaction Type",
  "Release Title",
  "Track Title",
  "Artist",
  "UPC",
  "ISRC",
  "Store",
  "Territory",
  "Quantity",
  "Unit Price",
  "Currency",
  "Gross Amount",
  "Your Net Receipts",
  "Reporting Period",
] as const;

const tunecoreProfile: StatementProfile = {
  kind: "tunecore_tsv",
  title: "TuneCore-style sales TSV",
  laneRightsType: "master",
  statementSourceType: null,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, TSV, TUNECORE_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, TSV, TUNECORE_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const store = requiredCell(values, "Store", rowNumber);
      const title = requiredCell(values, "Track Title", rowNumber);
      const money = moneyCell(values, "Your Net Receipts", rowNumber);
      const identifiers: ReconIdentifiers = {
        ...canonicalIdentifier("ISRC", values.get("ISRC") ?? "", rowNumber),
        ...canonicalIdentifier("UPC", values.get("UPC") ?? "", rowNumber),
      };
      const transactionType = requiredCell(values, "Transaction Type", rowNumber);
      const pipeline: RightsPipeline =
        transactionType === "Streaming" ? "master_interactive" : "master_digital_performance";
      return musicLine(
        "tunecore_tsv",
        "master",
        pipeline,
        rowNumber,
        optionalCell(values, "Reporting Period"),
        currencyCell(values, rowNumber),
        money,
        {
          title,
          identifiers,
          store,
          territory: optionalCell(values, "Territory"),
          platform: store,
        },
        TUNECORE_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// PRO (ASCAP/BMI-style) CSV — composition (publishing) performance
// distributions. The whole profile is a performance-distribution lane, so
// the pipeline is fixed; a mechanical publishing statement would be its own
// profile.
// ---------------------------------------------------------------------------

const PRO_HEADER = [
  "Distribution ID",
  "Distribution Date",
  "Writer",
  "Publisher",
  "Work Title",
  "ISWC",
  "Category",
  "Shares",
  "Performance Source",
  "Territory",
  "Amount",
  "Currency",
  "Reporting Period",
] as const;

const proProfile: StatementProfile = {
  kind: "pro_publishing_csv",
  title: "PRO (ASCAP/BMI-style) publishing distribution CSV",
  laneRightsType: "publishing",
  statementSourceType: null,
  tierLevel: null,
  matches: (content) => sniffHeaderMatches(content, CSV, PRO_HEADER),
  parse: (content) => {
    const rows = readStrictTable(content, CSV, PRO_HEADER);
    return rows.map((values, index) => {
      const rowNumber = index + 1;
      const title = requiredCell(values, "Work Title", rowNumber);
      const money = moneyCell(values, "Amount", rowNumber);
      const identifiers: ReconIdentifiers = {
        ...canonicalIdentifier("ISWC", values.get("ISWC") ?? "", rowNumber),
      };
      const source = requiredCell(values, "Performance Source", rowNumber);
      return musicLine(
        "pro_publishing_csv",
        "publishing",
        "composition_performance",
        rowNumber,
        optionalCell(values, "Reporting Period"),
        currencyCell(values, rowNumber),
        money,
        {
          title,
          identifiers,
          store: null,
          territory: optionalCell(values, "Territory"),
          platform: source,
        },
        PRO_HEADER.map((column) => values.get(column) ?? ""),
      );
    });
  },
};

// ---------------------------------------------------------------------------
// Film profiles — picture receipts. rights_type is 'unknown' (quarantined —
// the split-quarantine contract), tier_level 0 (the collection-account
// entry tier), and the statement kind rides statement_source_type.
// ---------------------------------------------------------------------------

interface FilmHeader {
  header: readonly string[];
  moneyColumn: string;
  kind: StatementProfileKind;
  statementSourceType: "vod" | "svod" | "theatrical_box_office" | "international_sales_agent";
  /** Bounded transaction/line-type vocabulary, or null when none. */
  lineTypeColumn: string | null;
  lineTypeValues: readonly string[] | null;
  offTopNote: string;
}

function filmProfile(def: FilmHeader): StatementProfile {
  const kind = def.kind;
  return {
    kind,
    title: `Film ${def.statementSourceType} statement CSV`,
    laneRightsType: "unknown",
    statementSourceType: def.statementSourceType,
    tierLevel: 0,
    matches: (content) => sniffHeaderMatches(content, CSV, def.header),
    parse: (content) => {
      const rows = readStrictTable(content, CSV, def.header);
      return rows.map((values, index) => {
        const rowNumber = index + 1;
        if (def.lineTypeColumn !== null && def.lineTypeValues !== null) {
          const lineType = requiredCell(values, def.lineTypeColumn, rowNumber);
          if (!def.lineTypeValues.includes(lineType)) {
            throw new StatementParseError(`invalid_line_type:${lineType}:row_${rowNumber}`);
          }
        }
        const title = requiredCell(values, "Title", rowNumber);
        const money = moneyCell(values, def.moneyColumn, rowNumber);
        const identifiers: ReconIdentifiers = {
          ...canonicalIdentifier("EIDR", values.get("EIDR") ?? "", rowNumber),
        };
        return {
          lineNumber: rowNumber,
          profile: kind,
          rightsType: "unknown",
          statementSourceType: def.statementSourceType,
          tierLevel: 0,
          // Inert on quarantined rows: the column only carries the four
          // music/DSP pipelines, and the split engines never read it for
          // rights_type-'unknown' lines. The waterfall allocator lanes off
          // tier_level + statement_source_type instead.
          rightsPipeline: "master_digital_performance",
          period: optionalCell(values, "Period"),
          currency: currencyCell(values, rowNumber),
          grossMicros: money.micros,
          isAdjustment: money.negative,
          identifiers,
          workTitle: title,
          territory: optionalCell(values, "Territory"),
          platform: optionalCell(values, "Platform"),
          usageNote: def.offTopNote,
          raw: def.header.map((column) => values.get(column) ?? ""),
          guildResidual: null,
          podcastDetail: null,
          gamingDetail: null,
          livestreamDetail: null,
          webtoonDetail: null,
          merchDetail: null,
          aiDetail: null,
        } satisfies ParsedStatementLine;
      });
    },
  };
}

const FILM_VOD_HEADER = [
  "Statement ID",
  "Title",
  "EIDR",
  "Territory",
  "Period Start",
  "Period End",
  "Platform",
  "Transaction Type",
  "Units",
  "Unit Price",
  "Currency",
  "Gross Amount",
  "Distributor Fee %",
  "Net Payable",
  "Period",
] as const;

const FILM_SVOD_HEADER = [
  "Statement ID",
  "Title",
  "EIDR",
  "Territory",
  "Period Start",
  "Period End",
  "Platform",
  "Subscription Tier",
  "Stream Minutes",
  "Currency",
  "License Fee",
  "Period",
] as const;

const FILM_THEATRICAL_HEADER = [
  "Statement ID",
  "Title",
  "EIDR",
  "Territory",
  "Exhibition Date",
  "Theater",
  "Screens",
  "Admissions",
  "Currency",
  "Box Office Gross",
  "Period",
] as const;

const FILM_SALES_AGENT_HEADER = [
  "Statement ID",
  "Title",
  "EIDR",
  "Territory",
  "Buyer",
  "License Type",
  "Currency",
  "Sales Amount",
  "Sales Commission %",
  "Remittance",
  "Period",
] as const;

const filmVodProfile = filmProfile({
  header: FILM_VOD_HEADER,
  moneyColumn: "Net Payable",
  kind: "film_vod_csv",
  statementSourceType: "vod",
  lineTypeColumn: "Transaction Type",
  lineTypeValues: ["EST", "TVOD"],
  offTopNote: "film tier 0 receipt — distributor fee rides Distributor Fee % (off-the-top)",
});

const filmSvodProfile = filmProfile({
  header: FILM_SVOD_HEADER,
  moneyColumn: "License Fee",
  kind: "film_svod_csv",
  statementSourceType: "svod",
  lineTypeColumn: null,
  lineTypeValues: null,
  offTopNote: "film tier 0 receipt — subscription license fee, collection-account entry",
});

const filmTheatricalProfile = filmProfile({
  header: FILM_THEATRICAL_HEADER,
  moneyColumn: "Box Office Gross",
  kind: "film_theatrical_box_office_csv",
  statementSourceType: "theatrical_box_office",
  lineTypeColumn: null,
  lineTypeValues: null,
  offTopNote: "film tier 0 receipt — box-office gross, collection-account entry",
});

const filmSalesAgentProfile = filmProfile({
  header: FILM_SALES_AGENT_HEADER,
  moneyColumn: "Remittance",
  kind: "film_international_sales_agent_csv",
  statementSourceType: "international_sales_agent",
  lineTypeColumn: null,
  lineTypeValues: null,
  offTopNote:
    "film tier 0 receipt — post-commission remittance; the agent commission is the off-the-top deduction",
});

/** Every profile, in dispatch order. */
export const STATEMENT_PROFILES: readonly StatementProfile[] = [
  distrokidProfile,
  tunecoreProfile,
  proProfile,
  filmVodProfile,
  filmSvodProfile,
  filmTheatricalProfile,
  filmSalesAgentProfile,
  // The podcast lane (PR 10) — dispatched through the same single opinion;
  // the worker branches on the profile kind before the music machinery.
  ...PODCAST_PROFILES,
  // The gaming lane (PR 12) — same dispatch opinion; the worker branches on
  // the profile kind before the music machinery (commission bands, the
  // engine-royalty accumulator, and the DevEx converter are gaming-only).
  ...GAMING_PROFILES,
  // The livestream/esports lane (PR 14) — same dispatch opinion; the worker
  // branches on the profile kind before the music machinery (the virtual
  // currency converter, the 95/5 Kick split, and the prize-pool escrow are
  // livestream-only).
  ...LIVESTREAM_PROFILES,
  // The webtoon lane (PR 19) — same dispatch opinion; the worker branches
  // on the profile kind before the music machinery (the coin conversion,
  // the layered store/platform shares, the KENP pool math, and the
  // monthly-pass dedup are webtoon-only).
  ...WEBTOON_PROFILES,
  // The merch lane (PR 22) — same dispatch opinion; the worker branches on
  // the profile kind before the music machinery (the DTC COGS equation,
  // the POD printing-before-split, the consignment reconciliation, and the
  // POS net are merch-only).
  ...MERCH_PROFILES,
  // The AI lane (PR 24) — same dispatch opinion; the worker branches on
  // the profile kind before the music machinery (the metered usage unit
  // math, the direct-to-actor voice routing, and the nested derivative
  // split are AI-only).
  ...AI_PROFILES,
  // The art-market lane (PR 28) — same dispatch opinion; the worker
  // branches on the profile kind before the music machinery (the founder
  // gallery equation, the ARR sliding scale, the fabrication recoupment
  // waterfalls, and the museum licensing isolation are art-only).
  ...ART_PROFILES,
  // The brand-licensing lane (PR 32) — same dispatch opinion; the worker
  // branches on the profile kind before the music machinery (the Net Sales
  // realization, the cumulative tier walk, the agency commission, the
  // dual-IP split, the treaty withholding, and the sub-license override
  // with its audit gate are licensing-only).
  ...LICENSING_PROFILES,
  // The NIL lane (PR 34) — same dispatch opinion; the worker branches on
  // the profile kind before the music machinery (the compliance parser's
  // $600 flag, the state matrix, the associated-entity holdback, the
  // adjusted pool walk, and the equal group split are NIL-only, and NIL
  // rows never touch the music split machinery).
  ...NIL_PROFILES,
  // The spatial lane (PR 36) — same dispatch opinion; the worker branches
  // on the profile kind before the music machinery (the Adjusted Location
  // Sales calculator, the throughput tier walk with cumulative tracking,
  // the dwell/session micro-royalties, the zone routing to the assigned
  // IP owner, and the shared facility overhead deduction are spatial-only,
  // and spatial rows never touch the music split machinery).
  ...SPATIAL_PROFILES,
  // The fitness lane (PR 38) — same dispatch opinion; the worker branches
  // on the profile kind before the music machinery (the Digital Stream
  // Realization calculator, the cumulative monthly tier walk, the sync
  // music deductions before the trainer net share, the live-event server
  // load residuals, the franchise class override with its network fee,
  // the co-brand split, the wearable/algorithm micro-royalties, and the
  // module-weighted co-creation waterfalls are fitness-only, and fitness
  // rows never touch the music split machinery).
  ...FITNESS_PROFILES,
  // The food lane (PR 40) — same dispatch opinion; the worker branches on
  // the profile kind before the music machinery (the Net Recipe
  // Realization calculator, the cumulative location-month unit-tier walk,
  // the weighted co-brand splits, the host operator splits with the brand
  // holdback, the cook-cycle micro-royalties, and the supplier rebate
  // waterfalls are food-only, and food rows never touch the music split
  // machinery).
  ...FOOD_PROFILES,
  // The service lane (PR 42) — same dispatch opinion; the worker branches
  // on the profile kind before the music machinery (the Net Service
  // Realization calculator, the franchise contract's three-way gross
  // partition, the cross-location redemption splits, the breakage
  // allocations, the protocol micro-royalties, the vendor rebate
  // waterfalls, and the isolated booth-lease legs are service-only, and
  // service rows never touch the music split machinery).
  ...SERVICE_PROFILES,
  // The developer lane (PR 44) — same dispatch opinion; the worker
  // branches on the profile kind before the music machinery (the Net API
  // Realization calculator, the tiered per-call and usage-share
  // micro-royalties, the marketplace splits, the co-authored package
  // splits, the SBOM dependency micro-fees, the white-label MMG
  // recoupment, and the agent tool-call settlements are developer-only,
  // and developer rows never touch the music split machinery).
  ...DEVELOPER_PROFILES,
  // The hardware lane (PR 46, the founder hardware directive) — same
  // dispatch opinion again: the worker branches on the profile kind
  // before the music machinery (the Net Hardware Patent Realization
  // calculator, the tiered FRAND SEP royalties, the automotive OEM pool
  // routings, the essentiality-weighted pool waterfalls, the clean-tech
  // telemetry micro-payouts, the cross-license nettings, and the OTA
  // unlock instant settlements are hardware-only, and hardware rows
  // never touch the music split machinery).
  ...HARDWARE_PROFILES,
  // The energy lane (PR 48, the founder resource directive) — same
  // dispatch opinion again: the worker branches on the profile kind
  // before the music machinery (the Net Resource Realization
  // calculator, the tiered parcel royalty and GPU yield walks, the
  // acreage-ratio owner divisions, the telemetry-weighted compute-grid
  // splits, the division order reroutes with statutory interest, and
  // the per-tonne carbon offset micro-royalties are energy-only, and
  // energy rows never touch the music split machinery).
  ...ENERGY_PROFILES,
];

/**
 * Dispatches one statement's content to its profile via the exact header
 * probe — the single dispatch opinion, shared by the worker and the tests.
 * Null when no profile matches: the CALLER owns the failure posture (the
 * worker routes unmatched content to the vision-engine seam or fails
 * honestly), so the dispatcher itself never guesses.
 */
export function dispatchStatementProfile(content: string): StatementProfile | null {
  return STATEMENT_PROFILES.find((profile) => profile.matches(content)) ?? null;
}
