export interface AgentMissionConfig {
  missionStatement: string;
  architectureFocus: string[];
  mandatoryRuleSet: string[];
}

export const COVENANT_AGENT_PREP: AgentMissionConfig = {
  missionStatement: "we are about to build the royalty collection SDK",
  architectureFocus: [
    "Master Universal License (MUL) clearance dispatch",
    "20 Universal Global Identifiers (ISRC, ISWC, ISAN, EIDR, DOI, EPC/RFID, NIL, etc.)",
    "Global DSP, Social UGC (Meta/TikTok/YouTube), and PRO API collection nodes",
    "Automated Split Execution & Black-Box Royalty Recovery",
  ],
  mandatoryRuleSet: [
    "Strict TypeScript typing across all collection payloads and statement parsers",
    "Split percentage calculations MUST strictly validate to 100% (10000 bps)",
    "Ensure coverage across all 4 rights pipelines: Composition Performance, Composition Mechanical, Master Digital Performance, and Master Interactive",
    "Maintain zero-fluff, production-ready output for SDK builds",
    "Integer cents only; leftover dust sweeps to payee_id platform, never to a creator",
    "sum(creator_allocations) + company_dust === gross on every line item",
    "Party shares must sum to exactly 10000 bps (100%). Convert sharePercentage with percentToBps (Math.round(percent * 100)).",
    "Reuse Don Engine allocateWithCompanyDustSweep. Do not reimplement split math.",
    "Sandbox collection only. Do not call live DSP, PRO, Plaid, Column, Unit, or https://api.covenant.io.",
    "Failures return { ok: false, code, message }. Do not throw for split or collection validation.",
  ],
};

export class CovenantAgentPrepSDK {
  public static getFormattedSystemPrompt(): string {
    return `
=== COVENANT SDK BUILD DIRECTIVE ===
MISSION: "${COVENANT_AGENT_PREP.missionStatement}"

CORE ARCHITECTURE:
${COVENANT_AGENT_PREP.architectureFocus.map((item) => `- ${item}`).join("\n")}

MANDATORY RULES:
${COVENANT_AGENT_PREP.mandatoryRuleSet.map((rule) => `- ${rule}`).join("\n")}
====================================
    `.trim();
  }
}
