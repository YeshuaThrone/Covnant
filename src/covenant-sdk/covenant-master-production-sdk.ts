/**
 * Barrel for the production collection pipeline.
 * Implementation lives in the focused modules; this file is the import path
 * from the master-SDK paste (`covenant-master-production-sdk`).
 */

export { CovenantMasterEngineFacade } from "./facade";
export type { SystemSweepResult } from "./facade";
export type { UniversalWorkManifest, Universal20Identifiers } from "./types";
export { CovenantIngestionEngine, CovenantClearanceDispatchNode } from "./covenant-connectors-and-clearance";
export { CovenantUniversalBlackBoxSweeper } from "./universal-blackbox-sweeper";
export type {
  RoyaltyChannelSource,
  UnclaimedRoyaltyRecord,
} from "./universal-blackbox-sweeper";
export {
  CovenantExternalDataIngestionEngine,
  DEFAULT_LUMINATE_RATE_MICROS,
  SANDBOX_LUMINATE_URL,
  yieldCentsFromUnits,
} from "./external-data-connectors";
export type {
  JaxstaCreditRecord,
  LuminateConsumptionPayload,
} from "./external-data-connectors";
export { CovenantDisputeResolutionNode } from "./dispute";
export { CovenantFXSettlementNode } from "./fx";
export { CovenantSplitLedgerNode, DEFAULT_ADMIN_FEE_BPS } from "./split-ledger";
export { CovenantAuditProofGenerator } from "./audit-proof";
export { CovenantMcpRegistry } from "./mcp-registry";
export { CovenantMcpToolHost, COVENANT_MCP_TOOLS } from "./mcp-tools";
export { COVENANT_HTTP_MOUNTS } from "./routes/app";
