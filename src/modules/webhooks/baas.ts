/**
 * Sandbox BaaS webhook ingestor — payout.settled / returned / failed.
 *
 * Landing adaptation (one-engine law): the ingestor bodies already live in
 * Covnant's canonical async adaptation, src/lib/server/webhooks.ts (the same
 * Cursor Phase 3/4 drop, awaited against the 72-method async Store). This
 * module preserves the EmeraldVal PR #41 import surface
 * (@/modules/webhooks/baas) for the MCP layer without duplicating any
 * money-moving logic — every ingest delegates to the canonical ingestor.
 */

import type { Store } from "@/lib/server/store";
import type { BaasWebhookEvent } from "@/modules/don/constants";
import {
  ingestBaasWebhook as ingestBaasWebhookCanonical,
} from "@/lib/server/webhooks";

export type BaasWebhookInput = {
  event: BaasWebhookEvent;
  transfer_id: string;
  event_id?: string;
};

export function webhookEventId(input: BaasWebhookInput): string {
  return input.event_id?.trim() || `${input.transfer_id}:${input.event}`;
}

export function ingestBaasWebhook(
  store: Store,
  input: BaasWebhookInput,
  now: Date = new Date(),
) {
  return ingestBaasWebhookCanonical(store, input, now);
}
