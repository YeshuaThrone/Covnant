/**
 * Sandbox collection nodes — one per rights pipeline, pure and network-free.
 *
 * The sandbox nodes are fully exercisable today: they normalize inbound
 * payloads through the canonical parser (src/contracts/royalty-event.ts),
 * enforce their own pipeline mandate, and refuse everything they cannot
 * affirm. They carry no platform API clients and fetch nothing — live
 * clients activate by configuration later (registered through
 * registerCollectionNode), never by a code change to the framework.
 *
 * Two behaviors, both fail-closed:
 *
 * 1. `ingestWebhook` accepts a canonical-event wire payload — a single event
 *    object or a non-empty array of them — and returns canonical events or
 *    throws. A node never drops, filters, or reshapes an event silently: a
 *    payload that fails the canonical parser, or an event outside the node's
 *    pipeline mandate, is a typed rejection with a stable reason.
 *
 * 2. `parseStatement` validates the statement-file envelope and then fails
 *    closed with `statement_parser_not_configured`. The DDEX RDR/CWR/CSV
 *    parsers land in the parser PRs; until a format's parser is wired, the
 *    skeleton parses no industry format and refuses to pretend to. The
 *    envelope check means malformed files are structural rejections, not
 *    parser output.
 *
 * The v1 roster is the build spec's recommendation — Spotify (master digital
 * performance), YouTube Content ID (master interactive), ASCAP (composition
 * performance), The MLC (composition mechanical) — one node per pipeline so
 * the registry covers all four. Registry keys are lowercase identifiers;
 * they are registry vocabulary, distinct from the claims platform enum
 * values an event's `platform` field carries.
 */

import { parseCanonicalRoyaltyEvent, isRightsPipeline, STATEMENT_FORMATS } from '../contracts/royalty-event';
import type { CanonicalRoyaltyEvent, RightsPipeline, StatementFormat } from '../contracts/royalty-event';
import { SdkMalformedInputError, SdkNotConfiguredError } from './errors';
import type { CollectionNode, StatementFile } from './collection-node';

/** Constructor options for a sandbox node. */
export interface SandboxNodeOptions {
  /** Lowercase registry key, e.g. 'spotify' — see the module docblock. */
  readonly platform: string;
  /** The pipelines this node collects for; at least one, no duplicates. */
  readonly pipelines: readonly RightsPipeline[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lowercase registry keys — node vocabulary, not the claims platform enum. */
const PLATFORM_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The pure webhook transformation: payload → canonical events. Throws the
 * typed rejection for every input it cannot affirm — never an empty array,
 * never a filtered subset.
 */
function normalizeSandboxWebhookEvents(
  payload: unknown,
  pipelines: readonly RightsPipeline[],
): readonly CanonicalRoyaltyEvent[] {
  const items: readonly unknown[] | null = Array.isArray(payload)
    ? payload
    : isPlainObject(payload)
      ? [payload]
      : null;
  if (items === null) {
    throw new SdkMalformedInputError('webhook_payload_not_an_object');
  }
  if (items.length === 0) {
    throw new SdkMalformedInputError('empty_webhook_payload');
  }

  const events: CanonicalRoyaltyEvent[] = [];
  for (const [index, item] of items.entries()) {
    const parsed = parseCanonicalRoyaltyEvent(item);
    if (!parsed.ok) {
      throw new SdkMalformedInputError(parsed.reason, index);
    }
    if (!pipelines.includes(parsed.event.rightsPipeline)) {
      throw new SdkMalformedInputError(
        `pipeline_not_handled:${parsed.event.rightsPipeline}`,
        index,
      );
    }
    events.push(parsed.event);
  }
  return events;
}

/**
 * Envelope validation for statement files: structural checks only — the
 * format dispatch and the parsing itself belong to the parser framework.
 * Throws `SdkMalformedInputError` with a stable reason, or returns the file
 * narrowed past the runtime checks the type system cannot enforce.
 */
function assertStatementFileEnvelope(file: StatementFile): void {
  if (!isPlainObject(file)) {
    throw new SdkMalformedInputError('statement_file_not_an_object');
  }
  const { name, format, content } = file;
  if (typeof name !== 'string' || name.length === 0 || name.length > 512 || name !== name.trim()) {
    throw new SdkMalformedInputError('invalid_statement_file_name');
  }
  if (typeof format !== 'string' || !STATEMENT_FORMATS.includes(format as StatementFormat)) {
    throw new SdkMalformedInputError(`invalid_statement_file_format:${String(format)}`);
  }
  if (typeof content !== 'string' || content.length === 0) {
    throw new SdkMalformedInputError('empty_statement_file_content');
  }
}

/**
 * The sandbox node. `isConfigured()` is always true — sandbox operation
 * needs no credentials, the way sandbox ACH/RTP remains available without
 * provider keys. A live node overrides it to report its credential state
 * (the `isBaasLiveConfigured` posture) and registers itself in place of its
 * skeleton when its provider is configured.
 */
export class SandboxCollectionNode implements CollectionNode {
  readonly platform: string;
  readonly pipelines: readonly RightsPipeline[];

  constructor(options: SandboxNodeOptions) {
    const { platform, pipelines } = options;
    if (typeof platform !== 'string' || !PLATFORM_KEY_PATTERN.test(platform)) {
      throw new SdkMalformedInputError(`invalid_node_platform:${String(platform)}`);
    }
    if (!Array.isArray(pipelines) || pipelines.length === 0) {
      throw new SdkMalformedInputError('empty_node_pipelines');
    }
    for (const pipeline of pipelines) {
      if (!isRightsPipeline(pipeline)) {
        throw new SdkMalformedInputError(`invalid_node_pipeline:${String(pipeline)}`);
      }
    }
    if (new Set(pipelines).size !== pipelines.length) {
      throw new SdkMalformedInputError('duplicate_node_pipeline');
    }
    this.platform = platform;
    this.pipelines = [...pipelines];
  }

  /** Sandbox operation is always configured — no credentials exist to check. */
  isConfigured(): boolean {
    return true;
  }

  async ingestWebhook(payload: unknown): Promise<readonly CanonicalRoyaltyEvent[]> {
    return normalizeSandboxWebhookEvents(payload, this.pipelines);
  }

  // Async so every rejection is a rejected promise — a caller chaining
  // `.catch` on the result must see the failure, never a sync throw.
  async parseStatement(file: StatementFile): Promise<readonly CanonicalRoyaltyEvent[]> {
    assertStatementFileEnvelope(file);
    // Fail closed until the parser framework wires this format (parser PRs).
    // The envelope above is validated so the structural rejection surfaces
    // first; a well-formed file reaches exactly this typed refusal.
    throw new SdkNotConfiguredError('statement_parser_not_configured');
  }
}

/** Master Digital Performance — DSP streaming of masters (Spotify). */
export const SPOTIFY_SANDBOX_NODE = new SandboxCollectionNode({
  platform: 'spotify',
  pipelines: ['master_digital_performance'],
});

/** Master Interactive — UGC claims (YouTube Content ID). */
export const YOUTUBE_CONTENT_ID_SANDBOX_NODE = new SandboxCollectionNode({
  platform: 'youtube_content_id',
  pipelines: ['master_interactive'],
});

/** Composition Performance — performing-rights organizations (ASCAP). */
export const ASCAP_SANDBOX_NODE = new SandboxCollectionNode({
  platform: 'ascap',
  pipelines: ['composition_performance'],
});

/** Composition Mechanical — mechanical licensors (The MLC). */
export const THE_MLC_SANDBOX_NODE = new SandboxCollectionNode({
  platform: 'the_mlc',
  pipelines: ['composition_mechanical'],
});

/** The v1 sandbox roster — one node per pipeline, in mission order. */
export const SANDBOX_NODES: readonly CollectionNode[] = [
  ASCAP_SANDBOX_NODE,
  THE_MLC_SANDBOX_NODE,
  SPOTIFY_SANDBOX_NODE,
  YOUTUBE_CONTENT_ID_SANDBOX_NODE,
];
