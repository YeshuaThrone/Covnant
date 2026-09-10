// Recoupment engine — Cursor's Phase 3/4 drop (recoupment sweep).
//
// sweepRecoupment is the pure bps arithmetic; applyRecoupmentSweep wires it
// to the store: recouped cents land in the platform vault's available balance
// (locked invariant 5 — never a creator), the excess goes to the payee's
// chosen bucket, and the per-split-run ledger row is written when a run id is
// supplied. Async adaptation only (Store PR contract): the store calls are
// awaited; the sweep math is untouched.

import type { Store } from "@/lib/server/store";
import {
  BPS_DENOMINATOR,
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
} from "@/modules/don/constants";
import { creditVault } from "@/modules/vaults/engine";
import type { VaultCreditTarget } from "@/modules/vaults/balances";

export type RecoupmentSweepInput = {
  incoming_cents: number;
  recoupment_target_cents: number;
  recoupment_current_cents: number;
  recoupment_bps?: number;
};

export type RecoupmentSweepResult = {
  recouped_cents: number;
  excess_cents: number;
  recoupment_current_cents: number;
  recoupment_remaining_cents: number;
  completed: boolean;
};

export function sweepRecoupment(input: RecoupmentSweepInput): RecoupmentSweepResult {
  const bps = input.recoupment_bps ?? 10_000;
  const remaining = Math.max(
    0,
    input.recoupment_target_cents - input.recoupment_current_cents,
  );
  if (input.incoming_cents < 1 || remaining < 1 || bps < 1) {
    return {
      recouped_cents: 0,
      excess_cents: Math.max(0, input.incoming_cents),
      recoupment_current_cents: input.recoupment_current_cents,
      recoupment_remaining_cents: remaining,
      completed: remaining === 0,
    };
  }
  const recouped = Math.min(
    Math.floor((input.incoming_cents * bps) / BPS_DENOMINATOR),
    remaining,
    input.incoming_cents,
  );
  return {
    recouped_cents: recouped,
    excess_cents: input.incoming_cents - recouped,
    recoupment_current_cents: input.recoupment_current_cents + recouped,
    recoupment_remaining_cents: remaining - recouped,
    completed: remaining - recouped === 0,
  };
}

export type RecoupmentSweepOptions = {
  excess_target?: VaultCreditTarget;
  split_run_id?: string;
};

export type RecoupmentSweepOutcome = {
  applied: boolean;
  recouped_cents: number;
  excess_cents: number;
  recoupment_current_cents: number;
  recoupment_remaining_cents: number;
  completed: boolean;
  recoupment_target_cents: number;
};

export async function applyRecoupmentSweep(
  store: Store,
  payeeId: string,
  payeeName: string,
  incomingCents: number,
  now: Date = new Date(),
  options: RecoupmentSweepOptions = {},
): Promise<RecoupmentSweepOutcome> {
  const excessTarget = options.excess_target ?? "available";
  const advance = await store.getRecoupmentAdvance(payeeId);
  if (!advance) {
    return {
      applied: false,
      recouped_cents: 0,
      excess_cents: incomingCents,
      recoupment_target_cents: 0,
      recoupment_current_cents: 0,
      recoupment_remaining_cents: 0,
      completed: true,
    };
  }
  const swept = sweepRecoupment({
    incoming_cents: incomingCents,
    recoupment_target_cents: advance.recoupment_target_cents,
    recoupment_current_cents: advance.recoupment_current_cents,
    recoupment_bps: advance.recoupment_bps,
  });
  if (swept.recouped_cents > 0) {
    await store.upsertRecoupmentAdvance({
      ...advance,
      recoupment_current_cents: swept.recoupment_current_cents,
      updated_at: now.toISOString(),
    });
    await creditVault(
      store,
      COMPANY_VARIANCE_PAYEE_ID,
      COMPANY_VARIANCE_PAYEE_NAME,
      swept.recouped_cents,
      "available",
      now,
    );
  }
  if (swept.excess_cents > 0) {
    await creditVault(store, payeeId, payeeName, swept.excess_cents, excessTarget, now);
  }
  if (options.split_run_id && incomingCents > 0) {
    await store.insertRecoupmentLedger({
      creator_id: payeeId,
      split_run_id: options.split_run_id,
      incoming_cents: incomingCents,
      recouped_cents: swept.recouped_cents,
      excess_cents: swept.excess_cents,
      recoupment_current_cents: swept.recoupment_current_cents,
      created_at: now.toISOString(),
    });
  }
  return {
    applied: true,
    ...swept,
    recoupment_target_cents: advance.recoupment_target_cents,
  };
}
