/**
 * The MUL clearance transition's admin audit wrapper — the console mutation
 * discipline (creators.ts / allowlists.ts) applied to the MUL surface:
 *
 *   - every effective transition writes exactly ONE admin_action_log row
 *     with the field-level { field: { from, to } } diff;
 *   - if the audit insert fails after the transition committed, the change
 *     is compensated best-effort (the prior current row restored, logged,
 *     never thrown) and a sanitized admin_action_log_failure returns — a
 *     clearance change never stands unlogged.
 *
 * The machine itself is the vendored SDK's (covnant-sdk/src/mul/clearance.ts,
 * unmodifiable): this wrapper reads the prior state, calls the SDK's
 * transitionClearance, audits, and compensates. The SDK's typed refusals
 * (ClearanceTransitionError / MulClearanceValidationError) propagate — the
 * route maps them to the wire exactly as before; nothing here invents
 * machine rules or second-guesses a refusal.
 *
 * Compensation limit, on the record: the append-only transition-history row
 * the SDK writes cannot be removed (the Store seam has no delete), and a
 * FIRST transition (no prior row) cannot be un-created through the seam —
 * the console.error in each case states this honestly. Restoring the
 * current row is the best effort the seam allows; the operator's retry then
 * walks the machine from the restored state.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type ClearanceStore,
  type ClearanceTransitionInput,
  type MulClearance,
  type MulClearanceRecord,
  clearanceFromRecord,
  transitionClearance,
} from '../../../covnant-sdk/src/mul/clearance';
import { ADMIN_ACTOR, MUL_CLEARANCE_TRANSITION_ACTION, recordAdminAction } from './actionLog';
import type { AdminActionChanges, AdminStoreResult } from './types';

export interface MulClearanceTransitionSuccess {
  clearance: MulClearance;
  /** The audit record for THIS transition — every effective transition is logged. */
  action: { id: string; action: string; changes: AdminActionChanges };
}

/**
 * Field-level before/after for exactly the fields one transition changed —
 * state always (the machine refuses same-state no-ops), the licensee /
 * territory / term fields only when the transition altered them. A first
 * transition (no prior clearance) diffs from null — the honest "no row
 * existed".
 */
export function computeClearanceChanges(
  before: MulClearance | null,
  after: MulClearance,
): AdminActionChanges {
  const changes: AdminActionChanges = {
    state: { from: before?.state ?? null, to: after.state },
  };
  for (const field of ['licensee', 'territory', 'termStart', 'termEnd'] as const) {
    const from = before?.[field] ?? null;
    if (from !== after[field]) changes[field] = { from, to: after[field] };
  }
  return changes;
}

/**
 * Moves one asset's clearance along a legal machine edge and writes the
 * audit row. The SDK's typed refusals throw (the route maps them); this
 * wrapper's own failure modes — the audit insert and the compensation —
 * return a sanitized AdminStoreFailure, never a throw past the route.
 */
export async function transitionClearanceWithAudit(
  store: ClearanceStore,
  auditDb: SupabaseClient,
  input: ClearanceTransitionInput,
): Promise<AdminStoreResult<MulClearanceTransitionSuccess>> {
  // The SDK trims and validates assetCbtCode itself; the before-read mirrors
  // that trim so it addresses the same row the transition will.
  const assetCbtCode = input.assetCbtCode.trim();
  const beforeRecord: MulClearanceRecord | undefined = await store.getClearanceForAsset(assetCbtCode);
  const before = beforeRecord === undefined ? null : clearanceFromRecord(beforeRecord);

  const after = await transitionClearance(store, input);

  const changes = computeClearanceChanges(before, after);
  const logged = await recordAdminAction(auditDb, {
    actor: ADMIN_ACTOR,
    action: MUL_CLEARANCE_TRANSITION_ACTION,
    target_table: 'mul_clearances',
    target_row_id: after.assetCbtCode,
    changes,
  });
  if (!logged.ok) {
    // Audit-or-nothing: restore the prior current row best-effort (the
    // append-only history row the SDK wrote stays — the seam has no delete),
    // logged, never thrown.
    if (beforeRecord) {
      try {
        await store.upsertClearance(beforeRecord);
        console.error(
          `[admin] compensation: restored clearance state ${beforeRecord.state} for ${beforeRecord.asset_cbt_code} — action-log insert failed: ${logged.message} (the append-only history row of the refused transition remains)`,
        );
      } catch (revertError) {
        console.error(
          `[admin] COMPENSATION INCOMPLETE: clearance revert for ${beforeRecord.asset_cbt_code} also failed: ${
            revertError instanceof Error ? revertError.message : String(revertError)
          }`,
        );
      }
    } else {
      console.error(
        `[admin] COMPENSATION INCOMPLETE: no prior clearance row existed for ${after.assetCbtCode} and the store seam has no delete — the first transition could not be reverted; action-log insert failed: ${logged.message}`,
      );
    }
    return {
      ok: false,
      status: 502,
      code: 'admin_action_log_failed',
      message: 'Clearance transition was not recorded in the audit log; the change was reverted where the store allows. Retry.',
    };
  }

  return {
    ok: true,
    value: {
      clearance: after,
      action: { id: logged.id, action: MUL_CLEARANCE_TRANSITION_ACTION, changes },
    },
  };
}
