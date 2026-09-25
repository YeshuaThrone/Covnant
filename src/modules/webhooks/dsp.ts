/**
 * DSP / catalog royalty webhook ingestor — royalty.report and
 * royalty.adjusted auto-trigger UDR splits; royalty.reversed inverts the
 * original split run through the reversal ledger.
 *
 * Landing adaptation (one-engine law): the ingestor bodies already live in
 * Covnant's canonical async adaptation, src/lib/server/webhooks.ts (the same
 * Cursor Phase 3/4 drop). This module preserves the EmeraldVal PR #41 import
 * surface (@/modules/webhooks/dsp) for the MCP layer without duplicating any
 * money-moving logic — it normalizes the drop's optional input fields to the
 * canonical DspWebhookPayload shape and delegates to the canonical ingestor.
 */

import type { RoyaltyLineItemInput, SettlementRail } from "@/lib/don/types";
import type { Store } from "@/lib/server/store";
import type { DspWebhookEvent } from "@/modules/don/constants";
import {
  ingestDspWebhook as ingestDspWebhookCanonical,
} from "@/lib/server/webhooks";

export type DspWebhookInput = {
  event: DspWebhookEvent;
  event_id?: string;
  source: string;
  period?: string | null;
  currency?: string;
  rail?: SettlementRail;
  split_run_id?: string;
  line_items?: RoyaltyLineItemInput[];
};

export function dspWebhookEventId(input: DspWebhookInput): string {
  if (input.event_id !== undefined && input.event_id.trim() !== "") {
    return input.event_id.trim();
  }
  return [
    input.source,
    input.event,
    input.period ?? "",
    input.split_run_id ?? "",
    JSON.stringify(input.line_items ?? []),
  ].join(":");
}

export function ingestDspWebhook(
  store: Store,
  input: DspWebhookInput,
  now: Date = new Date(),
) {
  return ingestDspWebhookCanonical(
    store,
    {
      event: input.event,
      event_id: input.event_id,
      source: input.source,
      period: input.period ?? null,
      currency: input.currency ?? "USD",
      rail: input.rail ?? "rtp",
      split_run_id: input.split_run_id,
      line_items: input.line_items ?? [],
    },
    now,
  );
}
