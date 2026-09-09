/**
 * The FIRST creator_profiles store module — read (list + detail, every 0003
 * and 0004 column) and the platform's first compliance mutation.
 *
 * No memory fallback on purpose: creator_profiles has no in-memory shadow
 * (the signup core writes it service-role only), so a memory fallback would
 * serve an empty lie and let a compliance write silently vanish. When
 * Supabase credentials are absent the ROUTES fail closed 503 — the console
 * surfaces real rows or nothing. Callers pass the service-role client
 * (the covnantSignup core's pattern), which keeps every function here
 * testable against a plain mock.
 *
 * Mutation contract (this is the console's first-mutation path):
 *   - the patch is whitelist-validated BEFORE any write; the DB has no CHECK
 *     constraints (the enum domains exist only as column comments), so an
 *     invalid value is rejected here with nothing half-written;
 *   - every effective mutation writes exactly ONE admin_action_log row with
 *     field-level { field: { from, to } };
 *   - if the audit insert fails after the profile update committed, the
 *     update is compensated (reverted best-effort, logged, never thrown) —
 *     the operator gets a sanitized failure and retries clean; an unlogged
 *     compliance change must not stand.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ADMIN_ACTOR,
  CREATOR_COMPLIANCE_UPDATE_ACTION,
  recordAdminAction,
} from './actionLog';
import type { AdminActionChanges, AdminCreatorProfile, AdminStoreResult, CreatorCompliancePatch, KycStatus, TaxFormType } from './types';
import { KYC_STATUSES, TAX_FORM_TYPES } from './types';

/** Every creator_profiles column — 0003 identity + 0004 compliance. */
const PROFILE_COLUMNS =
  'id, stage_name, legal_name, email, phone, phone_verified_at, core_industry, title, udr_terms_accepted_at, created_at, kyc_status, tax_form_type, tax_verified, bank_account_linked';

function rowFromDb(row: Record<string, unknown>): AdminCreatorProfile {
  return {
    id: row.id as string,
    stage_name: row.stage_name as string,
    legal_name: row.legal_name as string,
    email: row.email as string,
    phone: (row.phone as string | null) ?? null,
    phone_verified_at: (row.phone_verified_at as string | null) ?? null,
    core_industry: row.core_industry as string,
    title: (row.title as string | null) ?? null,
    udr_terms_accepted_at: row.udr_terms_accepted_at as string,
    created_at: (row.created_at as string | null) ?? '',
    kyc_status: (row.kyc_status as KycStatus | null) ?? null,
    tax_form_type: (row.tax_form_type as TaxFormType | null) ?? null,
    tax_verified: (row.tax_verified as boolean | null) ?? null,
    bank_account_linked: (row.bank_account_linked as boolean | null) ?? null,
  };
}

/** All creators, newest first — every 0003 + 0004 column. */
export async function listCreators(db: SupabaseClient): Promise<AdminStoreResult<AdminCreatorProfile[]>> {
  const { data, error } = await db
    .from('creator_profiles')
    .select(PROFILE_COLUMNS)
    .order('created_at', { ascending: false });
  if (error) {
    return { ok: false, status: 502, code: 'creator_list_failed', message: 'Creator profiles could not be read.' };
  }
  return { ok: true, value: (data ?? []).map(rowFromDb) };
}

/** One creator by id, or 404 — every 0003 + 0004 column. */
export async function getCreator(db: SupabaseClient, id: string): Promise<AdminStoreResult<AdminCreatorProfile>> {
  const { data, error } = await db
    .from('creator_profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) {
    return { ok: false, status: 502, code: 'creator_read_failed', message: 'Creator profile could not be read.' };
  }
  if (!data) {
    return { ok: false, status: 404, code: 'creator_not_found', message: 'No creator profile with that id.' };
  }
  return { ok: true, value: rowFromDb(data) };
}

export type CompliancePatchValidation =
  | { ok: true; value: CreatorCompliancePatch }
  | { ok: false; status: 400; code: string; message: string };

/**
 * Whitelist + enum validation of a compliance PATCH body. Unknown fields —
 * including the read-only columns (bank_account_linked, email, stage_name,
 * …) — are REJECTED, not silently dropped: silently dropping a field would
 * half-write the operator's intent.
 */
export function validateCompliancePatch(input: unknown): CompliancePatchValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, status: 400, code: 'malformed_body', message: 'Request body must be a JSON object.' };
  }
  const patch: CreatorCompliancePatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'kyc_status') {
      if (typeof value !== 'string' || !KYC_STATUSES.includes(value as KycStatus)) {
        return {
          ok: false,
          status: 400,
          code: 'invalid_kyc_status',
          message: 'kyc_status must be one of: PENDING_INITIALIZATION, PENDING, VERIFIED, REJECTED.',
        };
      }
      patch.kyc_status = value as KycStatus;
    } else if (key === 'tax_form_type') {
      if (typeof value !== 'string' || !TAX_FORM_TYPES.includes(value as TaxFormType)) {
        return {
          ok: false,
          status: 400,
          code: 'invalid_tax_form_type',
          message: 'tax_form_type must be one of: W9, W8BEN, EIN.',
        };
      }
      patch.tax_form_type = value as TaxFormType;
    } else if (key === 'tax_verified') {
      if (typeof value !== 'boolean') {
        return { ok: false, status: 400, code: 'invalid_tax_verified', message: 'tax_verified must be a boolean.' };
      }
      patch.tax_verified = value;
    } else {
      return { ok: false, status: 400, code: 'invalid_field', message: `Field is not admin-editable: ${key}.` };
    }
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, status: 400, code: 'empty_patch', message: 'No editable compliance fields supplied.' };
  }
  return { ok: true, value: patch };
}

/** Field-level before/after for exactly the fields the patch changes. */
export function computeComplianceChanges(
  before: AdminCreatorProfile,
  patch: CreatorCompliancePatch,
): AdminActionChanges {
  const changes: AdminActionChanges = {};
  for (const field of ['kyc_status', 'tax_form_type', 'tax_verified'] as const) {
    const to = patch[field];
    if (to === undefined) continue;
    const from = before[field];
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}

export interface ComplianceUpdateSuccess {
  profile: AdminCreatorProfile;
  /**
   * The audit record for THIS mutation — null only for a no-op patch (no
   * effective change performed, so there is no mutation to audit).
   */
  action: { id: string; action: string; changes: AdminActionChanges } | null;
}

/**
 * Applies a validated compliance patch and writes the audit row. Never
 * throws — every failure mode returns a sanitized AdminStoreFailure.
 */
export async function updateCreatorCompliance(
  db: SupabaseClient,
  id: string,
  patch: CreatorCompliancePatch,
): Promise<AdminStoreResult<ComplianceUpdateSuccess>> {
  const beforeResult = await getCreator(db, id);
  if (!beforeResult.ok) return beforeResult;
  const before = beforeResult.value;

  const changes = computeComplianceChanges(before, patch);
  if (Object.keys(changes).length === 0) {
    // A patch that changes nothing performs no write and logs nothing —
    // there is no mutation to audit.
    return { ok: true, value: { profile: before, action: null } };
  }

  const merged = {
    kyc_status: patch.kyc_status ?? before.kyc_status,
    tax_form_type: patch.tax_form_type ?? before.tax_form_type,
    tax_verified: patch.tax_verified ?? before.tax_verified,
  };

  const { data, error } = await db
    .from('creator_profiles')
    .update(merged)
    .eq('id', id)
    .select(PROFILE_COLUMNS)
    .maybeSingle();
  if (error) {
    return { ok: false, status: 502, code: 'compliance_update_failed', message: 'Compliance update could not be applied.' };
  }
  if (!data) {
    // The row vanished between read and update — nothing was written.
    return { ok: false, status: 404, code: 'creator_not_found', message: 'No creator profile with that id.' };
  }
  const after = rowFromDb(data);

  const logged = await recordAdminAction(db, {
    actor: ADMIN_ACTOR,
    action: CREATOR_COMPLIANCE_UPDATE_ACTION,
    target_table: 'creator_profiles',
    target_row_id: id,
    changes,
  });
  if (!logged.ok) {
    // Audit-or-nothing: revert the profile update best-effort (compensation
    // discipline — logged, never thrown) and report the failure.
    const reverted = await db
      .from('creator_profiles')
      .update({
        kyc_status: before.kyc_status,
        tax_form_type: before.tax_form_type,
        tax_verified: before.tax_verified,
      })
      .eq('id', id);
    if (reverted.error) {
      console.error(`[admin] COMPENSATION INCOMPLETE: compliance revert for ${id} also failed: ${reverted.error.message}`);
    } else {
      console.error(`[admin] compensation: reverted compliance update for ${id} — action-log insert failed: ${logged.message}`);
    }
    return {
      ok: false,
      status: 502,
      code: 'admin_action_log_failed',
      message: 'Compliance update was not recorded in the audit log; the change was reverted. Retry.',
    };
  }

  return {
    ok: true,
    value: { profile: after, action: { id: logged.id, action: CREATOR_COMPLIANCE_UPDATE_ACTION, changes } },
  };
}
