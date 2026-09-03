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
  createdAt: number;
  updatedAt: number;
}

declare global {
  // eslint-disable-next-line no-var
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

export async function saveContract(input: {
  cbtCode: string;
  templateId: string;
  industry: ContractIndustry;
  context: AgreementContext;
  id?: string;
}): Promise<StoredContract> {
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
      created_at: new Date(record.createdAt).toISOString(),
      updated_at: new Date(record.updatedAt).toISOString(),
    });
    if (error) throw new Error(`Contract store write failed: ${error.message}`);
  }
  memoryStore().set(record.id, record);
  return record;
}

export async function getContract(id: string): Promise<StoredContract | undefined> {
  const supabase = supabaseFromEnv();
  if (supabase) {
    const { data, error } = await supabase.from('contracts').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`Contract store read failed: ${error.message}`);
    if (data) return rowToRecord(data as Record<string, unknown>);
  }
  return memoryStore().get(id);
}

export async function listContracts(): Promise<StoredContract[]> {
  const supabase = supabaseFromEnv();
  if (supabase) {
    const { data, error } = await supabase
      .from('contracts')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) throw new Error(`Contract store read failed: ${error.message}`);
    return (data ?? []).map(rowToRecord);
  }
  return [...memoryStore().values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function markContractFinal(id: string): Promise<StoredContract | undefined> {
  const existing = await getContract(id);
  if (!existing) return undefined;
  const updated: StoredContract = { ...existing, status: 'FINAL', updatedAt: Date.now() };
  const supabase = supabaseFromEnv();
  if (supabase) {
    const { error } = await supabase.from('contracts').update({ status: 'FINAL' }).eq('id', id);
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
    createdAt: new Date(row.created_at as string).getTime(),
    updatedAt: new Date(row.updated_at as string).getTime(),
  };
}
