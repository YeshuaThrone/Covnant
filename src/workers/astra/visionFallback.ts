/**
 * CVT Astra extraction agent — RECON_VISION_* fallback seam (PR 6).
 *
 * Reuses PR 2's vision-assist configuration (src/workers/recon/visionEngine.ts
 * owns the env contract; Astra MUST NOT re-define it) as the traversal's
 * fallback for unexpected layouts: when a profile's deterministic login
 * selectors miss the live dashboard, the traversal asks the vision engine
 * to locate the controls in a redacted page capture — and when the seam is
 * unset, the fallback fails CLOSED: the traversal records the failure with
 * a redacted reason and moves on. Astra never falls back to guessing
 * selectors, and vision assistance is never required for the deterministic
 * path to work.
 *
 * The request payload is scrubbed through the same redaction gate as every
 * other outbound string — the vision engine receives a credential-free
 * page capture, pinned by the no-credential-leak test.
 */

import { redactCredentials } from './credentials';

/**
 * PR 2's env contract, read through its canonical home. Importing the
 * recon worker's reader keeps ONE definition of the seam (drift here
 * would silently fork the fail-closed behavior the platform relies on).
 */
import {
  type VisionEngineConfig,
  readVisionEngineConfig,
} from '@/workers/recon/visionEngine';

export type { VisionEngineConfig };

/** What the vision locator needs to find on a drifted page. */
export interface VisionControlQuery {
  /** What to look for, in plain language — e.g. "email input field". */
  control: 'username_input' | 'password_input' | 'submit_button' | 'statement_link';
  /** Redacted page HTML for the engine to reason over. */
  pageHtml: string;
}

/** The locator's answer — a selector for the queried control. */
export interface VisionControlAnswer {
  selector: string;
}

/** The engine client's HTTP contract (OpenAI-compatible for testability). */
export interface VisionEngineClient {
  locateControl(query: VisionControlQuery): Promise<VisionControlAnswer | null>;
}

/** True when the PR 2 vision seam is configured (any engine reachable). */
export function visionFallbackConfigured(): boolean {
  return readVisionEngineConfig() !== null;
}

/**
 * The fail-closed locator: null when the seam is unset OR the engine
 * returns nothing usable. Never throws — a fallback's failure is the
 * traversal's failure, recorded with a redacted reason, not a crash lane.
 */
export async function locateControlViaVision(
  query: VisionControlQuery,
  secrets: readonly string[],
  client: VisionEngineClient | null = defaultVisionClient(),
): Promise<VisionControlAnswer | null> {
  if (client === null) {
    return null; // seam unset — fail closed
  }
  const redactedHtml = redactCredentials(query.pageHtml, secrets);
  try {
    return await client.locateControl({ ...query, pageHtml: redactedHtml });
  } catch {
    // The engine being down is the same as it being unset: fail closed.
    return null;
  }
}

/**
 * The HTTP engine client for the configured seam. Uses PR 2's env contract
 * exactly (RECON_VISION_URL / RECON_VISION_API_KEY / RECON_VISION_MODEL).
 */
export function defaultVisionClient(): VisionEngineClient | null {
  const config = readVisionEngineConfig();
  if (config === null) {
    return null;
  }
  return {
    async locateControl(query) {
      const response = await fetch(`${config.url}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: buildRedactedVisionRequest(config.model, query),
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as {
        choices?: readonly { message?: { content?: string } }[];
      };
      const content = payload.choices?.[0]?.message?.content ?? '';
      const selector = extractSelector(content);
      return selector === null ? null : { selector };
    },
  };
}

/** The redacted outbound request body — the leak test's vision lane. */
export function buildRedactedVisionRequest(
  model: string,
  query: VisionControlQuery,
): string {
  return JSON.stringify({
    model,
    messages: [
      {
        role: 'system',
        content:
          'You locate form controls and links in page HTML. Answer with a single CSS selector only.',
      },
      {
        role: 'user',
        content: `Control: ${query.control}\n\nPage HTML:\n${query.pageHtml}`,
      },
    ],
  });
}

function extractSelector(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const fenced = trimmed.match(/```(?:css)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? trimmed).trim().split('\n')[0]?.trim() ?? '';
  // Only accept plausible selectors — the engine's answer drives a real
  // fill/click, so a prose answer must never become a selector.
  if (candidate.length === 0 || candidate.length > 200) {
    return null;
  }
  if (!/^[a-zA-Z0-9\s\-[#.\[\]="'()_:>*+~]+$/u.test(candidate)) {
    return null;
  }
  return candidate;
}
