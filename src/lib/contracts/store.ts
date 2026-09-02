/**
 * Contract draft store — spec §Contract vault ("Save stores a draft in
 * contracts → mark final → export").
 *
 * Mirrors the SDK singleton pattern: a globalThis-guarded in-memory registry
 * (survives dev HMR, not process restarts) with Supabase persistence when
 * credentials are configured. Documents are stored as rendered text; the
 * generator re-renders deterministically from the saved fields.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ContractIndustry } from './templates';
import type { AgreementFields } from './generator';
import { SUPABASE_URL_ENV, SUPABASE_SERVICE_ROLE_KEY_ENV } from '../data-source';

export type ContractStatus = 'DRAFT' | 'FINAL';

export interface StoredContract {
  id: string;
  cbtCode: string;
  templateId: string;
  industry: ContractIndustry;
  status: ContractStatus;
  fields: AgreementFields;
  document: string;
  createdAt: number;
  updatedAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __covnantContractStore: Map<string, StoredContract> | undefined;
}

function supabaseFromEnv(): SupabaseClient | undefined {
  const url = process.env[SUPABASE_URL_ENV];
  const key = process.env[SUPABASE_SERVICE_ROLE_KEY_ENV];
  return url && key ? createClient(url, key) : undefined;
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
  fields: AgreementFields;
  document: string;
  id?: string;
}): Promise<StoredContract> {
  const existing = input.id ? await getContract(input.id) : undefined;
  const now = Date.now();
  const record: StoredContract = {
    id: existing?.id ?? newContractId(),
    cbtCode: input.cbtCode,
    templateId: input.templateId,
    industry: input.industry,
    // A final agreement is immutable — edits after final are rejected upstream.
    status: existing?.status ?? 'DRAFT',
    fields: input.fields,
    document: input.document,
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
    fields: row.fields as AgreementFields,
    document: row.document as string,
    createdAt: new Date(row.created_at as string).getTime(),
    updatedAt: new Date(row.updated_at as string).getTime(),
  };
}
