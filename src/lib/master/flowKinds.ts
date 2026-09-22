/**
 * The registered economic flow kinds — the platform-intelligence layer's
 * STRUCTURAL vocabulary (2026-09-22 founder directive: the intelligence
 * layer speaks structure, never counterparty names).
 *
 * Registered additively over the atomic entity classes, the same pattern
 * as the taxonomy: every atomic entity type settles through exactly one
 * flow kind, mapped from the class's own canon semantics — the
 * sponsorship and athlete-contract forms ARE brand-partnership money,
 * the tournament event IS the prize purse, the stream and social-channel
 * forms ARE platform content monetization, and the six rights-holding
 * classes settle as royalty distributions. No kind is invented beyond
 * what the entity classes carry; adding a twelfth entity type forces a
 * registered decision here at compile time.
 */

import type { SovereignAtomicEntity } from './CovnantAtomicDataSDK';

/** The registered economic flow kinds — the analytics' structural rows. */
export type FlowKind =
  | 'ROYALTY_DISTRIBUTION'
  | 'BRAND_PARTNERSHIP'
  | 'PRIZE_PURSE'
  | 'PLATFORM_CONTENT_MONETIZATION';

/** Display labels — the flow-kind rows' verbatim vocabulary. */
export const FLOW_KIND_LABELS: Record<FlowKind, string> = {
  ROYALTY_DISTRIBUTION: 'Royalty Distribution',
  BRAND_PARTNERSHIP: 'Brand Partnership',
  PRIZE_PURSE: 'Prize Purse',
  PLATFORM_CONTENT_MONETIZATION: 'Platform Content Monetization',
};

/** The registered mapping — every atomic entity type's flow kind of record. */
const FLOW_KIND_BY_ENTITY_TYPE: {
  readonly [K in SovereignAtomicEntity['entityType']]: FlowKind;
} = {
  // The rights-holding classes — recurring rights-holder royalties.
  MASTER_RECORDING: 'ROYALTY_DISTRIBUTION',
  FEATURE_FILM: 'ROYALTY_DISTRIBUTION',
  LINEAR_TV: 'ROYALTY_DISTRIBUTION',
  PODCAST_NETWORK: 'ROYALTY_DISTRIBUTION',
  STAGE_PERFORMANCE: 'ROYALTY_DISTRIBUTION',
  LITERARY_WORK: 'ROYALTY_DISTRIBUTION',
  // The connective brand money — contracts and deals.
  ATHLETE_CONTRACT: 'BRAND_PARTNERSHIP',
  SPONSORSHIP_DEAL: 'BRAND_PARTNERSHIP',
  // Competition money — the canon purse escrow.
  TOURNAMENT_EVENT: 'PRIZE_PURSE',
  // Creator-yield platform money — streams and social channels.
  ESPORTS_STREAM: 'PLATFORM_CONTENT_MONETIZATION',
  SOCIAL_CHANNEL: 'PLATFORM_CONTENT_MONETIZATION',
};

/** The flow kind of record of a bound atomic entity — total over the union. */
export function flowKindForEntity(entity: SovereignAtomicEntity): FlowKind {
  return FLOW_KIND_BY_ENTITY_TYPE[entity.entityType];
}

/**
 * The registered display label of a flow-kind row — the analytics' middle
 * cut maps its structural rows through the registered labels. An
 * unregistered string renders as itself (never swallowed).
 */
export function flowKindLabel(kind: string): string {
  return FLOW_KIND_LABELS[kind as FlowKind] ?? kind;
}
