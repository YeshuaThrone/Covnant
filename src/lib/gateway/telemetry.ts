/**
 * Creator telemetry & gateway admin store — CovnantSDK backend wiring.
 *
 * Mirrors the ledger store's contract: Supabase persistence when credentials
 * are present (server-only service-role credential), a globalThis-guarded
 * in-memory index otherwise, so the gateway routes run in both data modes.
 * Rows map one-to-one onto supabase/migrations/0003_gateway_telemetry.sql:
 *
 *   creator_telemetry         <- insertCreatorTelemetry / listCreatorTelemetry
 *   platform_admin_allowlists <- isPlatformAdmin (admin ledger gate)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseFromEnv } from '@/lib/supabase';

export interface CreatorTelemetryInput {
  authUserId: string;
  legalName: string;
  artistName: string;
  regularEmail: string;
  businessEmail?: string;
  phone: string;
  phoneVerified: boolean;
  verifiedAt: string;
}

export interface CreatorTelemetryRecord extends CreatorTelemetryInput {
  id: string;
}

/** camelCase app payload -> creator_telemetry columns (0003_gateway_telemetry.sql). */
export function toCreatorTelemetryDbRow(record: CreatorTelemetryInput): Record<string, unknown> {
  return {
    auth_user_id: record.authUserId,
    legal_name: record.legalName,
    artist_name: record.artistName,
    regular_email: record.regularEmail,
    business_email: record.businessEmail ? record.businessEmail : null,
    phone: record.phone,
    phone_verified: record.phoneVerified,
    verified_at: record.verifiedAt,
  };
}

function rowFromDb(data: Record<string, unknown>): CreatorTelemetryRecord {
  return {
    id: String(data.id),
    authUserId: String(data.auth_user_id ?? ''),
    legalName: String(data.legal_name ?? ''),
    artistName: String(data.artist_name ?? ''),
    regularEmail: String(data.regular_email ?? ''),
    businessEmail: data.business_email ? String(data.business_email) : undefined,
    phone: String(data.phone ?? ''),
    phoneVerified: data.phone_verified === true,
    verifiedAt: String(data.verified_at ?? ''),
  };
}

declare global {
  var __covnantTelemetryIndex: CreatorTelemetryRecord[] | undefined;
  var __covnantGatewayAdmins: Set<string> | undefined;
}

function memoryIndex(): CreatorTelemetryRecord[] {
  if (!globalThis.__covnantTelemetryIndex) globalThis.__covnantTelemetryIndex = [];
  return globalThis.__covnantTelemetryIndex;
}

function memoryAdmins(): Set<string> {
  if (!globalThis.__covnantGatewayAdmins) globalThis.__covnantGatewayAdmins = new Set<string>();
  return globalThis.__covnantGatewayAdmins;
}

/**
 * Persist one verified registration: newest-first memory index, plus a
 * creator_telemetry insert when the service-role credential is configured.
 * The caller's JWT is verified upstream in the route; the table's RLS insert
 * policy (auth.uid() = auth_user_id) scopes any direct client write path.
 */
export async function insertCreatorTelemetry(
  record: CreatorTelemetryInput,
  db: SupabaseClient | undefined = supabaseFromEnv()
): Promise<CreatorTelemetryRecord> {
  const row: CreatorTelemetryRecord = { id: crypto.randomUUID(), ...record };
  memoryIndex().unshift(row);

  if (db) {
    const { error } = await db.from('creator_telemetry').insert([toCreatorTelemetryDbRow(record)]);
    if (error) throw new Error(`Creator telemetry insert failed: ${error.message}`);
  }
  return row;
}

/** Newest-first telemetry for the admin ledger read (admin-gated upstream in the route). */
export async function listCreatorTelemetry(
  db: SupabaseClient | undefined = supabaseFromEnv()
): Promise<CreatorTelemetryRecord[]> {
  if (db) {
    const { data, error } = await db
      .from('creator_telemetry')
      .select('*')
      .order('created_at', { ascending: false });
    if (!error && data) return data.map(rowFromDb);
  }
  return [...memoryIndex()];
}

/**
 * Explicit server-side admin check against platform_admin_allowlists. Runs
 * before any privileged read in /api/admin/ledger; RLS mirrors the same
 * contract for direct client reads ("telemetry select admin" policy).
 */
export async function isPlatformAdmin(
  db: SupabaseClient,
  authUserId: string
): Promise<boolean> {
  const { data, error } = await db
    .from('platform_admin_allowlists')
    .select('id')
    .eq('auth_user_id', authUserId)
    .limit(1);
  return !error && Array.isArray(data) && data.length > 0;
}

/** Memory-mode admin grant (local/dev fixture; no Supabase credentials configured). */
export function grantMemoryAdmin(authUserId: string): void {
  memoryAdmins().add(authUserId);
}

export function isMemoryAdmin(authUserId: string): boolean {
  return memoryAdmins().has(authUserId);
}

/** Test isolation hook — clears both memory indexes. */
export function resetGatewayMemoryState(): void {
  globalThis.__covnantTelemetryIndex = undefined;
  globalThis.__covnantGatewayAdmins = undefined;
}
