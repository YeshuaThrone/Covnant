import { describe, expect, it } from "vitest";
import {
  COVENANT_AGENT_PREP,
  CovenantAgentPrepSDK,
} from "./agent-prep";
import {
  UNIVERSAL_20_IDENTIFIER_KEYS,
  UNIVERSAL_GLOBAL_IDENTIFIER_COUNT,
  UNIVERSAL_GLOBAL_IDENTIFIERS,
  boundIdentifierCount,
  hasBoundIdentifier,
  isUniversalGlobalIdentifier,
} from "./identifiers";
import {
  RIGHTS_PIPELINES,
  RIGHTS_PIPELINE_COUNT,
  RIGHTS_PIPELINE_LABELS,
  isRightsPipeline,
} from "./rights";

describe("COVENANT_AGENT_PREP", () => {
  it("locks the collection-SDK mission", () => {
    expect(COVENANT_AGENT_PREP.missionStatement).toBe(
      "we are about to build the royalty collection SDK",
    );
    expect(COVENANT_AGENT_PREP.architectureFocus).toHaveLength(4);
    expect(COVENANT_AGENT_PREP.mandatoryRuleSet).toContain(
      "Split percentage calculations MUST strictly validate to 100% (10000 bps)",
    );
    expect(COVENANT_AGENT_PREP.mandatoryRuleSet).toContain(
      "Integer cents only; leftover dust sweeps to payee_id platform, never to a creator",
    );
    expect(COVENANT_AGENT_PREP.mandatoryRuleSet).toContain(
      "sum(creator_allocations) + company_dust === gross on every line item",
    );
  });

  it("formats a system prompt with mission, focus, and rules", () => {
    const prompt = CovenantAgentPrepSDK.getFormattedSystemPrompt();
    expect(prompt).toContain("=== COVENANT SDK BUILD DIRECTIVE ===");
    expect(prompt).toContain(COVENANT_AGENT_PREP.missionStatement);
    expect(prompt).toContain("CORE ARCHITECTURE:");
    expect(prompt).toContain("MANDATORY RULES:");
    expect(prompt).toContain("Master Universal License (MUL) clearance dispatch");
    expect(prompt).toContain("10000 bps");
    expect(prompt).toContain("payee_id platform");
  });
});

describe("Universal Global Identifiers", () => {
  it("exposes exactly 20 camelCase identifier keys", () => {
    expect(UNIVERSAL_GLOBAL_IDENTIFIER_COUNT).toBe(20);
    expect(UNIVERSAL_GLOBAL_IDENTIFIERS).toHaveLength(20);
    expect(UNIVERSAL_20_IDENTIFIER_KEYS).toEqual([
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
    ]);
    expect(isUniversalGlobalIdentifier("isrc")).toBe(true);
    expect(isUniversalGlobalIdentifier("ISRC")).toBe(false);
    expect(isUniversalGlobalIdentifier("orcid")).toBe(false);
    expect(boundIdentifierCount({ isrc: "US-AAA-00-00001", iswc: "  " })).toBe(1);
    expect(hasBoundIdentifier({ isrc: "US-AAA-00-00001" }, "isrc")).toBe(true);
    expect(hasBoundIdentifier({}, "iswc")).toBe(false);
  });
});

describe("rights pipelines", () => {
  it("covers all four pipelines", () => {
    expect(RIGHTS_PIPELINE_COUNT).toBe(4);
    expect(RIGHTS_PIPELINES).toEqual([
      "composition_performance",
      "composition_mechanical",
      "master_digital_performance",
      "master_interactive",
    ]);
    expect(RIGHTS_PIPELINE_LABELS.composition_mechanical).toBe(
      "Composition Mechanical",
    );
    expect(isRightsPipeline("master_interactive")).toBe(true);
    expect(isRightsPipeline("sync")).toBe(false);
  });
});
