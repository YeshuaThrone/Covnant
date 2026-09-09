/**
 * admin_action_log access — the append-only audit trail (migration 0005).
 *
 * INSERT-only by construction: this module exposes no update or delete
 * path, and the table's RLS grants nobody but the service role any access
 * (no anon/authenticated policies exist). Every admin console mutation
 * writes EXACTLY ONE row here, with field-level before/after in `changes`:
 *   { kyc_status: { from: 'PENDING_INITIALIZATION', to: 'PENDING' } }
 * — never a whole-object snapshot. Provenance on every write is the house
 * style (the ledger stamps provenance the same way).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AdminActionChanges } from './types';

/**
 * Operator identity. The shared-secret gate has no per-human identity —
 * the constant 'admin' until the session layer arrives and upgrades it.
 */
export const ADMIN_ACTOR = 'admin';

export const CREATOR_COMPLIANCE_UPDATE_ACTION = 'creator.compliance.update';
export const ALLOWLIST_STATUS_FLIP_ACTION = 'allowlist.status_flip';

export interface AdminActionEntry {
  actor: string;
  action: string;
  target_table: string;
  target_row_id: string | null;
  changes: AdminActionChanges;
}

export interface AdminActionRecord extends AdminActionEntry {
  id: string;
  created_at: string;
}

/**
 * Appends one audit row and returns its id. Returns a failure instead of
 * throwing — the mutating store decides the compensation (revert or report);
 * a logging layer must never crash the surface it audits.
 */
export async function recordAdminAction(
  db: SupabaseClient,
  entry: AdminActionEntry,
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const { data, error } = await db
    .from('admin_action_log')
    .insert({
      actor: entry.actor,
      action: entry.action,
      target_table: entry.target_table,
      target_row_id: entry.target_row_id,
      changes: entry.changes,
    })
    .select('id')
    .single();
  if (error || !data) {
    return { ok: false, message: error?.message ?? 'admin_action_log insert returned no row.' };
  }
  return { ok: true, id: data.id };
}
