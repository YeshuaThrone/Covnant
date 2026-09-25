/**
 * The vault identifier attach's admin audit wrapper — the console mutation
 * discipline (creators.ts / allowlists.ts) applied to the vault surface:
 *
 *   - every EFFECTIVE attach writes exactly ONE admin_action_log row with
 *     the field-level { field: { from, to } } diff, keyed by the persisted
 *     JSONB field (`mapped_identifiers.iswc`) — never a whole-object
 *     snapshot;
 *   - the idempotent replay (attached:false — the identical pair is already
 *     attached) performs no write and logs nothing, exactly the no-op-patch
 *     rule in creators.ts: there is no mutation to audit;
 *   - if the audit insert fails after the attach committed, the change is
 *     compensated best-effort (the prior mapped_identifiers value for the
 *     kind restored, or the kind's key removed when none existed — logged,
 *     never thrown) and a sanitized failure returns — an attach never
 *     stands unlogged.
 *
 * The attach itself stays the vault adapter's (`attachExternalIdentifier`,
 * src/lib/covnant/vault.ts — the FOR UPDATE transaction and the single
 * canonicalizer live there). This wrapper reads the prior value, calls the
 * adapter, audits, and compensates; the adapter's failure reasons pass
 * through verbatim for the route's wire mapping.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Db } from '@/lib/db';
import {
  type VaultIdentifierInput,
  attachExternalIdentifier,
  normalizeVaultIdentifier,
  vaultIdentifierStorageKey,
} from '@/lib/covnant/vault';
import { ADMIN_ACTOR, VAULT_IDENTIFIER_ATTACH_ACTION, recordAdminAction } from './actionLog';
import type { AdminActionChanges } from './types';

export interface VaultIdentifierAttachSuccess {
  attached: boolean;
  cvtCode: string;
  cbtCode: string;
  /**
   * The audit record for THIS attach — null only for the idempotent no-op
   * replay (no effective change performed, so there is no mutation to audit).
   */
  action: { id: string; action: string; changes: AdminActionChanges } | null;
}

export type VaultIdentifierAttachResult =
  | { ok: true; value: VaultIdentifierAttachSuccess }
  | { ok: false; reason: 'ASSET_NOT_FOUND' | 'INVALID_IDENTIFIER' | 'AUDIT_LOG_FAILED' };

/** Field-level before/after for one effective attach, keyed by the persisted JSONB field. */
export function computeAttachChanges(
  key: string,
  priorValue: string | null,
  canonical: string,
): AdminActionChanges {
  return { [`mapped_identifiers.${key}`]: { from: priorValue, to: canonical } };
}

/**
 * Attaches one external identifier and writes the audit row. The adapter's
 * failure reasons return as-is; audit and compensation failures collapse
 * into AUDIT_LOG_FAILED — never a throw past the route.
 */
export async function attachVaultIdentifierWithAudit(
  db: Db,
  auditDb: SupabaseClient,
  assetRef: string,
  identifier: VaultIdentifierInput,
): Promise<VaultIdentifierAttachResult> {
  const key = vaultIdentifierStorageKey(identifier.kind);

  // The prior value for this kind — the diff's `from` and the compensation's
  // restore target. Read before the attach exactly the getCreator-before-patch
  // way; best-effort compensation tolerates a racing writer (the adapter's
  // own attach is the FOR UPDATE transactional write).
  const prior = await db.query<{ mapped_identifiers: unknown }>(
    'SELECT mapped_identifiers FROM cbt_assets WHERE cvt_code = $1',
    [assetRef],
  );
  const stored = (prior.rows[0]?.mapped_identifiers ?? {}) as Record<string, unknown>;
  const existing = stored[key];
  const priorValue = typeof existing === 'string' && existing.trim() !== '' ? existing : null;

  const result = await attachExternalIdentifier(db, assetRef, identifier);
  if (!result.ok) {
    return result; // Adapter refusal — no mutation happened, pass through for the wire mapping.
  }
  if (!result.attached) {
    // The identical pair was already attached — a no-op, nothing to audit.
    return { ok: true, value: { attached: false, cvtCode: result.cvtCode, cbtCode: result.cbtCode, action: null } };
  }

  // The attach succeeded, so the value was valid — the same registry
  // canonicalizer the adapter stores under proves it here.
  const canonical = normalizeVaultIdentifier(identifier.kind, identifier.value);
  if (canonical === null) {
    // Unreachable behind an attached:true result — defended, never assumed.
    console.error(`[admin] vault attach audit skipped: ${identifier.kind} value failed re-canonicalization for ${result.cvtCode}`);
    return { ok: true, value: { attached: true, cvtCode: result.cvtCode, cbtCode: result.cbtCode, action: null } };
  }

  const changes = computeAttachChanges(key, priorValue, canonical);
  const logged = await recordAdminAction(auditDb, {
    actor: ADMIN_ACTOR,
    action: VAULT_IDENTIFIER_ATTACH_ACTION,
    target_table: 'cbt_assets',
    target_row_id: result.cvtCode,
    changes,
  });
  if (!logged.ok) {
    // Audit-or-nothing: restore the prior mapped_identifiers value for this
    // kind best-effort (logged, never thrown).
    try {
      if (priorValue !== null) {
        await db.query(
          `UPDATE cbt_assets
              SET mapped_identifiers = COALESCE(mapped_identifiers, '{}'::jsonb) || jsonb_build_object($1, $2)
            WHERE cvt_code = $3`,
          [key, priorValue, result.cvtCode],
        );
        console.error(`[admin] compensation: restored mapped_identifiers.${key} on ${result.cvtCode} — action-log insert failed: ${logged.message}`);
      } else {
        await db.query(
          `UPDATE cbt_assets
              SET mapped_identifiers = COALESCE(mapped_identifiers, '{}'::jsonb) - $1
            WHERE cvt_code = $2`,
          [key, result.cvtCode],
        );
        console.error(`[admin] compensation: removed mapped_identifiers.${key} from ${result.cvtCode} — action-log insert failed: ${logged.message}`);
      }
    } catch (revertError) {
      console.error(
        `[admin] COMPENSATION INCOMPLETE: mapped_identifiers.${key} revert for ${result.cvtCode} also failed: ${
          revertError instanceof Error ? revertError.message : String(revertError)
        }`,
      );
    }
    return { ok: false, reason: 'AUDIT_LOG_FAILED' };
  }

  return {
    ok: true,
    value: {
      attached: true,
      cvtCode: result.cvtCode,
      cbtCode: result.cbtCode,
      action: { id: logged.id, action: VAULT_IDENTIFIER_ATTACH_ACTION, changes },
    },
  };
}
