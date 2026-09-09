/**
 * platform_allowlists admin store — read + the ACTIVE/REVOKED flip.
 *
 * platform_allowlists is DOMAIN DATA (social channels cleared per CBT code),
 * read by the engine's hydration lookup and the health probe — the admin
 * console is this table's first human interface. The flip is a real
 * mutation, so it follows the house mutation discipline: whitelist-free (the
 * status flip is the only operation), exactly ONE admin_action_log row with
 * the field-level before/after, best-effort compensation when the audit
 * insert fails, sanitized errors — never a throw past the response.
 * Allowlist CREATION is deferred (v1 does flips only).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ADMIN_ACTOR,
  ALLOWLIST_STATUS_FLIP_ACTION,
  recordAdminAction,
} from './actionLog';
import type { AdminActionChanges, AdminStoreResult } from './types';

export type AllowlistStatus = 'ACTIVE' | 'REVOKED';

/** One platform_allowlists row (migration 0001) — the console's flip target. */
export interface AdminAllowlistRow {
  id: string;
  platform: string;
  target_account_id: string;
  cbt_code: string;
  creator_incentive_share_pct: number;
  status: AllowlistStatus;
  created_at: string;
}

const ALLOWLIST_COLUMNS =
  'id, platform, target_account_id, cbt_code, creator_incentive_share_pct, status, created_at';

function rowFromDb(row: Record<string, unknown>): AdminAllowlistRow {
  return {
    id: row.id as string,
    platform: row.platform as string,
    target_account_id: row.target_account_id as string,
    cbt_code: row.cbt_code as string,
    creator_incentive_share_pct: Number(row.creator_incentive_share_pct),
    status: row.status as AllowlistStatus,
    created_at: (row.created_at as string | null) ?? '',
  };
}

/** All allowlist rows, newest first. */
export async function listAllowlists(db: SupabaseClient): Promise<AdminStoreResult<AdminAllowlistRow[]>> {
  const { data, error } = await db
    .from('platform_allowlists')
    .select(ALLOWLIST_COLUMNS)
    .order('created_at', { ascending: false });
  if (error) {
    return { ok: false, status: 502, code: 'allowlist_list_failed', message: 'Allowlists could not be read.' };
  }
  return { ok: true, value: (data ?? []).map(rowFromDb) };
}

/** One allowlist row by id, or 404. */
export async function getAllowlist(db: SupabaseClient, id: string): Promise<AdminStoreResult<AdminAllowlistRow>> {
  const { data, error } = await db
    .from('platform_allowlists')
    .select(ALLOWLIST_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    return { ok: false, status: 502, code: 'allowlist_read_failed', message: 'Allowlist row could not be read.' };
  }
  if (!data) {
    return { ok: false, status: 404, code: 'allowlist_not_found', message: 'No allowlist row with that id.' };
  }
  return { ok: true, value: rowFromDb(data) };
}

export interface AllowlistFlipSuccess {
  allowlist: AdminAllowlistRow;
  /** The audit record for THIS flip. */
  action: { id: string; action: string; changes: AdminActionChanges };
}

/**
 * Flips a row ACTIVE ↔ REVOKED and writes the audit row. Never throws —
 * every failure mode returns a sanitized AdminStoreFailure.
 */
export async function flipAllowlistStatus(
  db: SupabaseClient,
  id: string,
): Promise<AdminStoreResult<AllowlistFlipSuccess>> {
  const current = await getAllowlist(db, id);
  if (!current.ok) return current;
  const before = current.value;
  const next: AllowlistStatus = before.status === 'ACTIVE' ? 'REVOKED' : 'ACTIVE';

  const { data, error } = await db
    .from('platform_allowlists')
    .update({ status: next })
    .eq('id', id)
    .select(ALLOWLIST_COLUMNS)
    .maybeSingle();
  if (error) {
    return { ok: false, status: 502, code: 'allowlist_update_failed', message: 'Allowlist update could not be applied.' };
  }
  if (!data) {
    // The row vanished between read and update — nothing was written.
    return { ok: false, status: 404, code: 'allowlist_not_found', message: 'No allowlist row with that id.' };
  }
  const after = rowFromDb(data);

  const changes: AdminActionChanges = { status: { from: before.status, to: next } };
  const logged = await recordAdminAction(db, {
    actor: ADMIN_ACTOR,
    action: ALLOWLIST_STATUS_FLIP_ACTION,
    target_table: 'platform_allowlists',
    target_row_id: id,
    changes,
  });
  if (!logged.ok) {
    // Audit-or-nothing: revert the flip best-effort (compensation discipline
    // — logged, never thrown) and report the failure.
    const reverted = await db.from('platform_allowlists').update({ status: before.status }).eq('id', id);
    if (reverted.error) {
      console.error(`[admin] COMPENSATION INCOMPLETE: allowlist revert for ${id} also failed: ${reverted.error.message}`);
    } else {
      console.error(`[admin] compensation: reverted allowlist flip for ${id} — action-log insert failed: ${logged.message}`);
    }
    return {
      ok: false,
      status: 502,
      code: 'admin_action_log_failed',
      message: 'Allowlist flip was not recorded in the audit log; the change was reverted. Retry.',
    };
  }

  return {
    ok: true,
    value: { allowlist: after, action: { id: logged.id, action: ALLOWLIST_STATUS_FLIP_ACTION, changes } },
  };
}
