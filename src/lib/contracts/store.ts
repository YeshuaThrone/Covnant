/**
 * Contract draft store — spec §Contract vault ("Save stores a draft in
 * contracts → mark final → export").
 *
 * Mirrors the SDK singleton pattern: a globalThis-guarded in-memory registry
 * (survives dev HMR, not process restarts) with Supabase persistence when
 * credentials are configured. Documents are stored as rendered text; the
 * generator re-renders deterministically from the saved fields.
 */

import { getTemplate, type ContractIndustry } from './templates';
import { renderClauses, type AgreementContext } from './generator';
import { supabaseFromEnv } from '../supabase';

export type ContractStatus = 'DRAFT' | 'FINAL';

export interface StoredContract {
  id: string;
  cbtCode: string;
  templateId: string;
  industry: ContractIndustry;
  status: ContractStatus;
  fields: AgreementContext;
  document: string;
  /**
   * The creating session's registered-creator identity (the session-bound
   * payee id, migration 0062). NULL for rows predating 0062 and for
   * unattributed (pure-operator) saves — visible to operators/admins only.
   */
  creatorId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * The principal a contract read/finalize runs for (audit F6/F7, spec D7).
 * An operator (or the demo door) sees every row; a creator sees only the
 * rows their own session created — NULL-creator rows are operator-visible
 * only. `undefined` keeps the store's unscoped behavior for internal
 * callers (the seeded demo data, the operator-gated admin surfaces);
 * `null` is the no-principal case — nothing is visible.
 */
export type ContractViewer = { role: 'operator' } | { role: 'creator'; creatorId: string };

declare global {
  var __covnantContractStore: Map<string, StoredContract> | undefined;
}

function memoryStore(): Map<string, StoredContract> {
  if (!globalThis.__covnantContractStore) {
    globalThis.__covnantContractStore = new Map();
  }
  return globalThis.__covnantContractStore;
}

function newContractId(): string {
  const hex = crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  return `CTR-${hex}`;
}

export async function saveContract(
  input: {
    cbtCode: string;
    templateId: string;
    industry: ContractIndustry;
    context: AgreementContext;
    id?: string;
  },
  creatorId?: string | null,
): Promise<StoredContract> {
  const template = getTemplate(input.templateId);
  if (!template) throw new Error(`Unknown template: ${input.templateId}`);
  const existing = input.id ? await getContract(input.id) : undefined;
  if (existing?.status === 'FINAL') {
    throw new Error('This agreement is final and can no longer be edited.');
  }
  const now = Date.now();
  const record: StoredContract = {
    id: existing?.id ?? newContractId(),
    cbtCode: input.cbtCode,
    templateId: input.templateId,
    industry: input.industry,
    status: existing?.status ?? 'DRAFT',
    fields: input.context,
    // The server re-renders from the saved context — the stored document is
    // always the deterministic render of the stored fields, never client text.
    document: renderClauses(template, input.context),
    // Ownership stamp (spec D7): the creating session's creator id on a NEW
    // record; a re-save never re-stamps — the original owner keeps the row.
    creatorId: existing?.creatorId ?? (creatorId ?? null),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const supabase = supabaseFromEnv();
  if (supabase) {
    const { error } = await supabase.from('contracts').upsert({
      id: record.id,
      cbt_code: record.cbtCode,
      template_id: record.templateId,
      industry: record.industry,
      status: record.status,
      fields: record.fields,
      document: record.document,
      creator_id: record.creatorId,
      created_at: new Date(record.createdAt).toISOString(),
      updated_at: new Date(record.updatedAt).toISOString(),
    });
    if (error) throw new Error(`Contract store write failed: ${error.message}`);
  }
  memoryStore().set(record.id, record);
  return record;
}

export async function getContract(
  id: string,
  viewer?: ContractViewer | null,
): Promise<StoredContract | undefined> {
  // The no-principal case: a viewer that has proven no identity sees
  // nothing — no read runs at all.
  if (viewer === null) return undefined;
  const supabase = supabaseFromEnv();
  if (supabase) {
    // Creator-scoped read (spec D7): the filter runs in the query, so a
    // foreign or NULL-creator row comes back as "no data" — identical to an
    // unknown id, never a 403-style distinction.
    let query = supabase.from('contracts').select('*').eq('id', id);
    if (viewer?.role === 'creator') query = query.eq('creator_id', viewer.creatorId);
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error(`Contract store read failed: ${error.message}`);
    if (data) return rowToRecord(data as Record<string, unknown>);
  }
  const record = memoryStore().get(id);
  if (viewer?.role === 'creator' && record?.creatorId !== viewer.creatorId) return undefined;
  return record;
}

export async function listContracts(viewer?: ContractViewer | null): Promise<StoredContract[]> {
  // The no-principal case: a viewer that has proven no identity sees nothing.
  if (viewer === null) return [];
  const supabase = supabaseFromEnv();
  if (supabase) {
    let query = supabase
      .from('contracts')
      .select('*')
      .order('updated_at', { ascending: false });
    if (viewer?.role === 'creator') query = query.eq('creator_id', viewer.creatorId);
    const { data, error } = await query;
    if (error) throw new Error(`Contract store read failed: ${error.message}`);
    return (data ?? []).map(rowToRecord);
  }
  const all = [...memoryStore().values()].sort((a, b) => b.updatedAt - a.updatedAt);
  if (viewer?.role === 'creator') {
    return all.filter((record) => record.creatorId === viewer.creatorId);
  }
  return all;
}

export async function markContractFinal(
  id: string,
  viewer?: ContractViewer | null,
): Promise<StoredContract | undefined> {
  // The scoped read is the authorization: a foreign or NULL-creator row is
  // "not found" for a creator — undefined, the exact unknown-id shape the
  // finalize action maps to its not-found error.
  const existing = await getContract(id, viewer);
  if (!existing) return undefined;
  const updated: StoredContract = { ...existing, status: 'FINAL', updatedAt: Date.now() };
  const supabase = supabaseFromEnv();
  if (supabase) {
    // Defense in depth: the UPDATE re-checks the scope so a row that became
    // invisible between the read and the write is never finalized.
    let query = supabase.from('contracts').update({ status: 'FINAL' }).eq('id', id);
    if (viewer?.role === 'creator') query = query.eq('creator_id', viewer.creatorId);
    const { error } = await query;
    if (error) throw new Error(`Contract store write failed: ${error.message}`);
  }
  memoryStore().set(id, updated);
  return updated;
}

function rowToRecord(row: Record<string, unknown>): StoredContract {
  return {
    id: row.id as string,
    cbtCode: row.cbt_code as string,
    templateId: row.template_id as string,
    industry: row.industry as ContractIndustry,
    status: row.status as ContractStatus,
    fields: row.fields as AgreementContext,
    document: row.document as string,
    creatorId: (row.creator_id as string | null) ?? null,
    createdAt: new Date(row.created_at as string).getTime(),
    updatedAt: new Date(row.updated_at as string).getTime(),
  };
}
