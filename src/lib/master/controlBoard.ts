/**
 * ControlBoard — the shared wire/board types of the Covnant Control Board
 * (founder directive, 2026-09-20): the entity-bound card shapes the
 * /templates page renders, the per-sector API response the vertical tab
 * handlers hydrate from, and the pure merge that folds sector responses
 * into one vertical's board data.
 *
 * PURE TYPES + PURE FUNCTIONS ONLY — imported by both the server page and
 * the client board; no store, no server-only module may leak in here.
 */

import type { AtomicContractRecord, ContractTemplateRecord } from './masterStore';
import type {
  AtomicExecutionTelemetry,
  SovereignAtomicEntity,
} from './CovnantAtomicDataSDK';
import type { AtomicSector, GlobalEntertainmentCategory } from './taxonomy';

/** One factory template card's data — the record plus its bound entity. */
export interface EntityBoundFactoryTemplate {
  readonly record: ContractTemplateRecord;
  readonly entity: SovereignAtomicEntity | null;
  readonly execution: AtomicExecutionTelemetry | null;
}

/** One atomic card's data — record, bound entity, and execution telemetry. */
export interface EntityBoundAtomicRecord {
  readonly record: AtomicContractRecord;
  readonly entity: SovereignAtomicEntity | null;
  readonly execution: AtomicExecutionTelemetry | null;
}

/**
 * GET /api/v1/entities/[sector] — the per-sector entity feed. The atomic
 * records are the sector's own; the factory templates are the parent
 * vertical's (vertical-scoped, so identical across a vertical's sector
 * responses — the tab handler dedupes via mergeSectorResponses).
 */
export interface SectorEntitiesResponse {
  readonly ok: true;
  readonly sector: AtomicSector;
  readonly vertical: GlobalEntertainmentCategory;
  readonly demo: boolean;
  readonly atomicRecords: readonly EntityBoundAtomicRecord[];
  readonly factoryTemplates: readonly EntityBoundFactoryTemplate[];
}

/** One vertical section's board data — both grids, entity-bound. */
export interface VerticalBoardData {
  readonly vertical: GlobalEntertainmentCategory;
  readonly factoryTemplates: readonly EntityBoundFactoryTemplate[];
  readonly atomicRecords: readonly EntityBoundAtomicRecord[];
}

/** The whole board's state — the verticals currently rendered. */
export interface ControlBoardState {
  readonly demo: boolean;
  readonly active: GlobalEntertainmentCategory | null;
  readonly verticals: readonly VerticalBoardData[];
}

/**
 * Fold a vertical's per-sector responses into one vertical's board data.
 * The factory list is vertical-scoped (identical in every sector response),
 * so the first response carries it; the atomic records concatenate in
 * sector order. Pure — the client's only merge step.
 */
export function mergeSectorResponses(
  vertical: GlobalEntertainmentCategory,
  responses: readonly SectorEntitiesResponse[],
): VerticalBoardData {
  const factoryTemplates = responses[0]?.factoryTemplates ?? [];
  const atomicRecords = responses.flatMap((response) => response.atomicRecords);
  return { vertical, factoryTemplates, atomicRecords };
}
