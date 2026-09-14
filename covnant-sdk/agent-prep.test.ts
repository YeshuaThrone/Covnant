import { describe, expect, it } from 'vitest';
import {
  COLLECTION_SURFACES,
  GLOBAL_IDENTIFIER_SET,
  LOCKED_RULES,
  RIGHTS_PIPELINES,
  getFormattedSystemPrompt,
} from './agent-prep';

/**
 * Byte-for-byte pin of getFormattedSystemPrompt() — the rebuilt mission
 * payload is canon. Update deliberately, in the same change as the payload.
 */
const PINNED_PROMPT = `# Mission — Universal Royalty Collection SDK

Money we can't see, we can't collect. The Don already records every royalty that arrives; the SDK builds the layer that goes and gets the rest — collection nodes, statement parsers, identifier matching, and license clearance — settled by the locked split engines, so nothing is missed.

## Directive (received 2026-09-13)

Build the Universal Royalty Collection SDK: Master Universal License clearance dispatch; the global identifier set (ISRC, ISWC, ISAN, EIDR, DOI, EPC/RFID, NIL, and more); collection nodes across DSPs, social UGC platforms, and PROs; and automated split execution with black-box royalty recovery — across all four rights pipelines, in strict TypeScript, with splits validating to exactly 100%.

## Rights pipelines

1. Composition Performance — performing-rights organizations (ASCAP, BMI, SESAC, GEMA)
2. Composition Mechanical — mechanical licensors (The MLC, HFA)
3. Master Digital Performance — SoundExchange and DSP streaming of masters
4. Master Interactive — UGC claims across Meta, TikTok, YouTube Content ID, and peers

## Collection surfaces

- Collection nodes across DSP, UGC, PRO, and mechanical pipelines — sandbox-first
- Statement parsers for DDEX RDR/NWR, CWR, and CSV royalty statements
- The Increase money lane — four rails behind HMAC verification — already live

## Global identifier set

ISRC · ISWC · ISAN · EIDR · DOI · EPC/RFID · NIL

## Locked rules

1. Split math is called, never reimplemented — calculateUdrSplits over the dust core is the only settlement entry, and the three-gate 100% ladder stands untouched.
2. Sandbox-first, fail-closed — every external touchpoint is configuration-gated; missing configuration raises a typed *_not_configured error, and money never moves on a guess.
3. Exact match only — no fuzzy matching, no auto-repair; unmatched events are preserved verbatim in the quarantine match queue as recovery candidates.
4. Covnant spelling everywhere — repo-owned identifiers and copy carry the Covnant brand; the misspelled brand name is forbidden. Vendored engine names keep their preserved spelling.
5. The two ledger universes stay separate — every SDK-initiated write is CBT-stamped in whichever universe it touches.
6. UCT, CVT, and CBT remain the spine — external identifiers attach through cbt_assets.mapped_identifiers via the vault adapter.`;

describe('agent-prep mission payload', () => {
  it('pins getFormattedSystemPrompt() byte-for-byte', () => {
    expect(getFormattedSystemPrompt()).toBe(PINNED_PROMPT);
  });

  it('is deterministic across calls', () => {
    expect(getFormattedSystemPrompt()).toBe(getFormattedSystemPrompt());
  });

  it('carries the Covnant brand spelling and never the misspelled name', () => {
    const prompt = getFormattedSystemPrompt();
    expect(prompt).toContain('Covnant');
    expect(prompt).not.toMatch(/covenant/i);
  });

  it('states the locked settlement entry point and the exact-100% rule', () => {
    const prompt = getFormattedSystemPrompt();
    expect(prompt).toContain('calculateUdrSplits');
    expect(prompt).toContain('exactly 100%');
    expect(prompt).toContain('fail-closed');
  });

  it('represents all four rights pipelines and the directive identifier set', () => {
    expect(RIGHTS_PIPELINES).toHaveLength(4);
    for (const pipelineName of [
      'Composition Performance',
      'Composition Mechanical',
      'Master Digital Performance',
      'Master Interactive',
    ]) {
      expect(RIGHTS_PIPELINES.some((pipeline) => pipeline.startsWith(pipelineName))).toBe(true);
    }
    expect(GLOBAL_IDENTIFIER_SET).toEqual(['ISRC', 'ISWC', 'ISAN', 'EIDR', 'DOI', 'EPC/RFID', 'NIL']);
    expect(COLLECTION_SURFACES.length).toBeGreaterThanOrEqual(3);
    expect(LOCKED_RULES).toHaveLength(6);
  });
});
