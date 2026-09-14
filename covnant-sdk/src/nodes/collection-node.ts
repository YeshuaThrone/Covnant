/**
 * The collection-node framework — the SDK's per-platform collection points.
 *
 * A CollectionNode is one platform's collection surface (a DSP, a UGC
 * platform, a PRO, a mechanical licensor): it turns that platform's inbound
 * material — webhook payloads and statement files — into canonical royalty
 * events (src/contracts/royalty-event.ts) and nothing else. Matching,
 * clearance, and settlement live downstream; a node never touches money.
 *
 * Two disciplines shape this module:
 *
 * 1. Fail-closed, always. `getCollectionNode` is the only way to reach a
 *    node, and it refuses every path that is not a working, configured node:
 *    an unknown platform and a registered-but-unconfigured node throw the
 *    same typed SdkNotConfiguredError(`${platform}_not_configured`). There
 *    is no null return, no default node, no silent no-op path — callers
 *    either hold a node or hold an exception. This is the src/services/baas
 *    posture (`baas_not_configured`) carried over. The two cases are
 *    deliberately indistinguishable to callers: the registry's shape is not
 *    something the SDK leaks.
 *
 * 2. The registry is the spine. NODE_REGISTRY fixes the v1 sandbox roster —
 *    one node per rights pipeline, so all four pipelines are representable.
 *    `isConfigured()` sits on the CollectionNode interface itself: the
 *    fail-closed gate is type-enforced, because every node must answer the
 *    configuration question before the registry will hand it out.
 *    registerCollectionNode is the single seam (mirroring setBaasAdapter)
 *    through which a configured live node replaces its sandbox skeleton —
 *    live clients activate by configuration, never by code change here.
 *
 * `StatementFile` is the envelope `parseStatement` consumes: name, wire
 * format, and text content. The format dispatch and the parsing belong to
 * the parser framework (parser PRs); the skeleton nodes validate the
 * envelope and fail closed until then.
 */

import type {
  CanonicalRoyaltyEvent,
  RightsPipeline,
} from '../contracts/royalty-event';
import { SdkNotConfiguredError } from './errors';
import { SANDBOX_NODES } from './sandbox-nodes';

export { SdkMalformedInputError, SdkNotConfiguredError } from './errors';
export { SANDBOX_NODES } from './sandbox-nodes';

/** A statement file handed to a node's parseStatement — the envelope only. */
export interface StatementFile {
  /** Source file name, e.g. 'ascap-2026-08.csv' — audit provenance. */
  readonly name: string;
  /** The wire format the file carries — the parser framework's dispatch key. */
  readonly format: 'ddex-rdr' | 'cwr' | 'csv';
  /** The file's text content. Industry statements are text; binary arrives later. */
  readonly content: string;
}

/**
 * One platform's collection surface. Every member is load-bearing:
 * `pipelines` is the node's collection mandate (events outside it are
 * rejected), and `isConfigured` is the fail-closed gate the registry
 * consults — the interface forces every implementer to answer it.
 */
export interface CollectionNode {
  /** Lowercase registry key, e.g. 'spotify' — registry vocabulary. */
  readonly platform: string;
  /** The pipelines this node collects for; at least one. */
  readonly pipelines: readonly RightsPipeline[];
  /**
   * Whether this node is usable right now. Sandbox nodes answer true —
   * sandbox operation needs no credentials; a live node reports its
   * credential state (the isBaasLiveConfigured posture).
   */
  isConfigured(): boolean;
  /**
   * Normalize one webhook payload (a single event object or a non-empty
   * array) into canonical events. Malformed input is a typed rejection —
   * never a filtered subset or an empty result.
   */
  ingestWebhook(payload: unknown): Promise<readonly CanonicalRoyaltyEvent[]>;
  /**
   * Parse one statement file into canonical events. Fail-closed per format
   * until the parser framework wires that format.
   */
  parseStatement(file: StatementFile): Promise<readonly CanonicalRoyaltyEvent[]>;
}

/** The platform → node map the registry reads. Keys are node platforms. */
export type CollectionNodeRegistry = Readonly<Record<string, CollectionNode>>;

/**
 * Registry construction: duplicate platforms are a wiring error, not a
 * shadowing situation — refuse at construction time.
 *
 * The record is created with a null prototype so lookups with untrusted
 * platform keys ('__proto__', 'constructor', …) can never reach inherited
 * members — they resolve to undefined and the gate throws.
 */
function registryWithNodes(
  nodes: readonly CollectionNode[],
): Record<string, CollectionNode> {
  const registry = Object.create(null) as Record<string, CollectionNode>;
  for (const node of nodes) {
    if (registry[node.platform] !== undefined) {
      throw new SdkNotConfiguredError(`duplicate_node_platform:${node.platform}`);
    }
    registry[node.platform] = node;
  }
  return registry;
}

/** Build a registry from nodes; a duplicate platform is a construction bug. */
export function buildNodeRegistry(nodes: readonly CollectionNode[]): CollectionNodeRegistry {
  return registryWithNodes(nodes);
}

/** The v1 registry — the sandbox roster, one node per pipeline. */
export const NODE_REGISTRY: CollectionNodeRegistry = buildNodeRegistry(SANDBOX_NODES);

/**
 * The live registry the getter consults. Starts identical to NODE_REGISTRY;
 * the seams below swap it. NODE_REGISTRY itself is never mutated.
 */
let liveRegistry: CollectionNodeRegistry = NODE_REGISTRY;

/**
 * Registration seam — mirrors setBaasAdapter. Tests register stubs here; a
 * later configuration layer registers a live node in place of its sandbox
 * skeleton when its provider credentials exist.
 */
export function registerCollectionNode(node: CollectionNode): void {
  liveRegistry = registryWithNodes([...Object.values(liveRegistry), node]);
}

/** Restore the built-in sandbox registry — tests call this when done. */
export function resetCollectionNodes(): void {
  liveRegistry = NODE_REGISTRY;
}

/**
 * The only way to reach a collection node. Fail-closed, always: unknown
 * platform and unconfigured node throw the same typed error, and there is
 * no fallback that returns a do-nothing node.
 */
export function getCollectionNode(platform: string): CollectionNode {
  const node = liveRegistry[platform];
  if (!node?.isConfigured()) {
    // Fail closed, always — the baas_not_configured posture, carried over.
    throw new SdkNotConfiguredError(`${platform}_not_configured`);
  }
  return node;
}
