// Webhook ingestors — Cursor's Phase 3/4 drop (DSP royalty + BaaS payout
// callbacks). Async adaptation only (Store PR contract): store and engine
// calls are awaited; the event_id idempotency order (check before any money
// moves), the DSP fallback event-id derivation, and the returned shapes are
// untouched.

import type { Store } from "@/lib/server/store";
import type {
  BaasTransferRecord,
  SplitRunRecord,
} from "@/lib/don/types";
import type {
  BaasWebhookEventRecord,
  DspWebhookEventRecord,
  PayoutReversalRecord,
  SovereignVaultRecord,
  SplitReversalRecord,
} from "@/modules/don/records";
import type {
  BaasWebhookPayload,
  DspWebhookPayload,
} from "@/lib/don/validation";
import {
  calculateUdrSplits,
  type SplitCalculateSuccess,
} from "./udrSplits";
import { reverseSplitRun } from "./splitReversal";
import { reverseVaultPayout, settleVaultPayout } from "@/modules/vaults/engine";

export type DspWebhookIngestResult =
  | {
      ok: true;
      idempotent: boolean;
      event: DspWebhookEventRecord;
      split_run?: SplitRunRecord;
      reversal?: SplitReversalRecord;
      split?: SplitCalculateSuccess["value"];
    }
  | { ok: false; status: number; code: string; message: string };

export async function ingestDspWebhook(
  store: Store,
  input: DspWebhookPayload,
  now: Date = new Date(),
): Promise<DspWebhookIngestResult> {
  const eventId =
    input.event_id?.trim() ||
    [
      input.source,
      input.event,
      input.period ?? "",
      input.split_run_id ?? "",
      JSON.stringify(input.line_items ?? []),
    ].join(":");
  const prior = await store.getDspWebhookEvent(eventId);
  if (prior) return { ok: true, idempotent: true, event: prior };

  if (input.event === "royalty.reversed") {
    const splitRunId = input.split_run_id?.trim() ?? "";
    if (!splitRunId) {
      return {
        ok: false,
        status: 422,
        code: "missing_split_run_id",
        message: "split_run_id is required to reverse a royalty report.",
      };
    }
    const reversed = await reverseSplitRun(store, splitRunId, now);
    if (!reversed.ok) return reversed;
    const event = await store.insertDspWebhookEvent({
      event_id: eventId,
      event: input.event,
      source: input.source,
      split_run_id: splitRunId,
      payload_json: JSON.stringify(input),
      created_at: now.toISOString(),
    });
    return {
      ok: true,
      idempotent: reversed.idempotent,
      event,
      split_run: reversed.split_run,
      reversal: reversed.reversal,
    };
  }

  const split = await calculateUdrSplits(
    store,
    {
      source: input.source,
      period: input.period ?? null,
      currency: input.currency ?? "USD",
      settle: false,
      rail: input.rail ?? "rtp",
      line_items: input.line_items ?? [],
    },
    now,
  );
  if (!split.ok) return split;
  const event = await store.insertDspWebhookEvent({
    event_id: eventId,
    event: input.event,
    source: input.source,
    split_run_id: split.value.split_run.id,
    payload_json: JSON.stringify(input),
    created_at: now.toISOString(),
  });
  return { ok: true, idempotent: false, event, split: split.value };
}

export type BaasWebhookIngestResult =
  | {
      ok: true;
      idempotent: boolean;
      event: BaasWebhookEventRecord;
      transfer: BaasTransferRecord;
      vault: SovereignVaultRecord;
      reversal: PayoutReversalRecord | null;
    }
  | { ok: false; status: number; code: string; message: string };

export async function ingestBaasWebhook(
  store: Store,
  input: BaasWebhookPayload,
  now: Date = new Date(),
): Promise<BaasWebhookIngestResult> {
  const transfer = await store.getBaasTransfer(input.transfer_id);
  if (!transfer) {
    return {
      ok: false,
      status: 404,
      code: "transfer_not_found",
      message: "No BaaS transfer matches that id.",
    };
  }
  const eventId = input.event_id?.trim() || `${input.transfer_id}:${input.event}`;
  const prior = await store.getWebhookEvent(eventId);
  if (prior) {
    // Replay: no financial effect. The vault is re-read read-only to satisfy
    // the success envelope.
    const vault = await store.getVault(transfer.payee_id);
    if (!vault) {
      return {
        ok: false,
        status: 404,
        code: "vault_not_found",
        message: "No sovereign vault exists for that payee.",
      };
    }
    return { ok: true, idempotent: true, event: prior, transfer, vault, reversal: null };
  }

  if (input.event === "payout.settled") {
    const settled = await settleVaultPayout(store, input.transfer_id, now);
    if (!settled.ok) return settled;
    const event = await store.insertWebhookEvent({
      event_id: eventId,
      event: input.event,
      transfer_id: input.transfer_id,
      payload_json: JSON.stringify(input),
      reversal_id: null,
      created_at: now.toISOString(),
    });
    return {
      ok: true,
      idempotent: settled.idempotent,
      event,
      transfer: settled.transfer,
      vault: settled.vault,
      reversal: null,
    };
  }

  const reversed = await reverseVaultPayout(
    store,
    input.transfer_id,
    input.event,
    now,
  );
  if (!reversed.ok) return reversed;
  const event = await store.insertWebhookEvent({
    event_id: eventId,
    event: input.event,
    transfer_id: input.transfer_id,
    payload_json: JSON.stringify(input),
    reversal_id: reversed.reversal.id,
    created_at: now.toISOString(),
  });
  return {
    ok: true,
    idempotent: reversed.idempotent,
    event,
    transfer: reversed.transfer,
    vault: reversed.vault,
    reversal: reversed.reversal,
  };
}
