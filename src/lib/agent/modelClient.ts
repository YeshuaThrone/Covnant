/**
 * The registration agent's ONLY outbound integration: one Anthropic Messages
 * API call in tool-use mode, with the draft schema as the tool definition.
 *
 * Server-side only — the API key arrives as a parameter from the route's env
 * read and is never logged, never returned, and never imported into client
 * code (the import-boundary test walks this module's graph too). Anthropic
 * has no native strict-JSON mode; the tool-use block + the route's zod
 * re-validation is the mitigation, and an unusable response is an honest
 * {ok:false} — never a repaired or partial draft.
 */

import {
  AGENT_DRAFT_TOOL_NAME,
  AGENT_REGISTRATION_SYSTEM_PROMPT,
  AGENT_TOOL_DEFINITION,
} from './registrationDraft';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/** Hard ceiling on one model round-trip; a hung call must not hold the request. */
export const AGENT_MODEL_TIMEOUT_MS = 30_000;

/** Max tokens for the draft response — a three-pool draft is far below this. */
export const AGENT_MODEL_MAX_TOKENS = 4_096;

export type AgentModelResult =
  | { ok: true; toolInput: unknown }
  | { ok: false; error: string };

/** The subset of an Anthropic content block this client understands. */
interface ToolUseBlock {
  type?: unknown;
  name?: unknown;
  input?: unknown;
}

/**
 * Extract the draft tool input from a Messages API response body: the single
 * `tool_use` block named AGENT_DRAFT_TOOL_NAME. Anything else — prose-only
 * output, a different tool, truncated content — is a failure, never a guess.
 */
export function extractDraftToolInput(payload: unknown): AgentModelResult {
  const content =
    typeof payload === 'object' && payload !== null && 'content' in payload
      ? (payload as { content?: unknown }).content
      : undefined;
  if (!Array.isArray(content)) {
    return { ok: false, error: 'Model response carried no content blocks.' };
  }
  for (const block of content as ToolUseBlock[]) {
    if (block?.type === 'tool_use' && block.name === AGENT_DRAFT_TOOL_NAME) {
      return { ok: true, toolInput: block.input };
    }
  }
  return {
    ok: false,
    error: `Model response carried no ${AGENT_DRAFT_TOOL_NAME} tool_use block.`,
  };
}

/**
 * One draft request to one model id. Returns the raw tool input (unvalidated)
 * or a named failure — the route owns validation, escalation, and envelopes.
 */
export async function requestRegistrationDraft(
  modelId: string,
  description: string,
  apiKey: string,
): Promise<AgentModelResult> {
  let response: Response;
  try {
    response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: AGENT_MODEL_MAX_TOKENS,
        system: AGENT_REGISTRATION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: description }],
        tools: [AGENT_TOOL_DEFINITION],
        // Force the tool: the route wants structured input or nothing.
        tool_choice: { type: 'tool', name: AGENT_DRAFT_TOOL_NAME },
      }),
      signal: AbortSignal.timeout(AGENT_MODEL_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      error: `Anthropic request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok) {
    return { ok: false, error: `Anthropic API responded ${response.status}.` };
  }
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null) {
    return { ok: false, error: 'Anthropic response was not JSON.' };
  }
  return extractDraftToolInput(payload);
}
