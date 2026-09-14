/**
 * Universal Royalty Collection SDK — agent mission payload, rebuilt clean.
 *
 * The mission directive arrived (2026-09-13) as a Gemini agent-prep payload
 * whose template literals and quotes were damaged in transit; this module
 * re-enters it clean: mission content intact, template literals repaired,
 * and every repo-owned name carrying the Covnant brand spelling per the
 * locked brand-exact rename rule. Vendored engine names keep their preserved
 * spelling, and the vendored engine stays hash-locked.
 *
 * getFormattedSystemPrompt() renders the payload for an agent. Its output is
 * pinned byte-for-byte by agent-prep.test.ts — change the payload and the
 * test's pinned string deliberately, in the same change.
 */

/** The SDK's mission name, as carried by the directive. */
export const MISSION_NAME = 'Universal Royalty Collection SDK';

/** Date the directive was received. */
export const MISSION_RECEIVED_AT = '2026-09-13';

/** Mission thesis — why the collection layer exists at all. */
export const MISSION_THESIS =
  "Money we can't see, we can't collect. The Don already records every royalty that arrives; the SDK builds the layer that goes and gets the rest — collection nodes, statement parsers, identifier matching, and license clearance — settled by the locked split engines, so nothing is missed.";

/** The mission directive, verbatim from the payload with transit damage repaired. */
export const MISSION_DIRECTIVE =
  'Build the Universal Royalty Collection SDK: Master Universal License clearance dispatch; the global identifier set (ISRC, ISWC, ISAN, EIDR, DOI, EPC/RFID, NIL, and more); collection nodes across DSPs, social UGC platforms, and PROs; and automated split execution with black-box royalty recovery — across all four rights pipelines, in strict TypeScript, with splits validating to exactly 100%.';

/** The four rights pipelines, in mission order. */
export const RIGHTS_PIPELINES: readonly string[] = [
  'Composition Performance — performing-rights organizations (ASCAP, BMI, SESAC, GEMA)',
  'Composition Mechanical — mechanical licensors (The MLC, HFA)',
  'Master Digital Performance — SoundExchange and DSP streaming of masters',
  'Master Interactive — UGC claims across Meta, TikTok, YouTube Content ID, and peers',
];

/** Collection surfaces the SDK feeds: sandbox nodes, parsers, and the live money lane. */
export const COLLECTION_SURFACES: readonly string[] = [
  'Collection nodes across DSP, UGC, PRO, and mechanical pipelines — sandbox-first',
  'Statement parsers for DDEX RDR/NWR, CWR, and CSV royalty statements',
  'The Increase money lane — four rails behind HMAC verification — already live',
];

/** The global identifier set the registry must cover, as named by the directive. */
export const GLOBAL_IDENTIFIER_SET: readonly string[] = [
  'ISRC',
  'ISWC',
  'ISAN',
  'EIDR',
  'DOI',
  'EPC/RFID',
  'NIL',
];

/** Locked operating rules the SDK may not reopen. */
export const LOCKED_RULES: readonly string[] = [
  'Split math is called, never reimplemented — calculateUdrSplits over the dust core is the only settlement entry, and the three-gate 100% ladder stands untouched.',
  'Sandbox-first, fail-closed — every external touchpoint is configuration-gated; missing configuration raises a typed *_not_configured error, and money never moves on a guess.',
  'Exact match only — no fuzzy matching, no auto-repair; unmatched events are preserved verbatim in the quarantine match queue as recovery candidates.',
  'Covnant spelling everywhere — repo-owned identifiers and copy carry the Covnant brand; the misspelled brand name is forbidden. Vendored engine names keep their preserved spelling.',
  'The two ledger universes stay separate — every SDK-initiated write is CBT-stamped in whichever universe it touches.',
  'UCT, CVT, and CBT remain the spine — external identifiers attach through cbt_assets.mapped_identifiers via the vault adapter.',
];

/** The assembled mission payload. */
export interface SdkMission {
  readonly name: string;
  readonly receivedAt: string;
  readonly thesis: string;
  readonly directive: string;
  readonly rightsPipelines: readonly string[];
  readonly collectionSurfaces: readonly string[];
  readonly globalIdentifierSet: readonly string[];
  readonly lockedRules: readonly string[];
}

export const SDK_MISSION: SdkMission = {
  name: MISSION_NAME,
  receivedAt: MISSION_RECEIVED_AT,
  thesis: MISSION_THESIS,
  directive: MISSION_DIRECTIVE,
  rightsPipelines: RIGHTS_PIPELINES,
  collectionSurfaces: COLLECTION_SURFACES,
  globalIdentifierSet: GLOBAL_IDENTIFIER_SET,
  lockedRules: LOCKED_RULES,
};

/**
 * Render the mission payload as the system prompt an agent receives.
 * Pure and deterministic — the output is pinned by agent-prep.test.ts.
 */
export function getFormattedSystemPrompt(): string {
  const lines: string[] = [
    `# Mission — ${MISSION_NAME}`,
    '',
    MISSION_THESIS,
    '',
    `## Directive (received ${MISSION_RECEIVED_AT})`,
    '',
    MISSION_DIRECTIVE,
    '',
    '## Rights pipelines',
    '',
    ...RIGHTS_PIPELINES.map((pipeline, index) => `${index + 1}. ${pipeline}`),
    '',
    '## Collection surfaces',
    '',
    ...COLLECTION_SURFACES.map((surface) => `- ${surface}`),
    '',
    '## Global identifier set',
    '',
    GLOBAL_IDENTIFIER_SET.join(' · '),
    '',
    '## Locked rules',
    '',
    ...LOCKED_RULES.map((rule, index) => `${index + 1}. ${rule}`),
  ];
  return lines.join('\n');
}
