/**
 * The session-bound creator identity — the ONLY door to the live dashboard
 * data. Mirrors GET /api/covnant/me's fail-closed posture: the identity
 * resolves from the VERIFIED SESSION and nothing else (the auth user comes
 * from supabase.auth.getUser() — the JWT validated against the auth server,
 * never a client-supplied id/email/query param), the profile row is read
 * under the creator_profiles select-own RLS policy (migration 0003), and the
 * registry holder entry is matched strictly by the SESSION email against the
 * designated CBT-SIGNUP-REGISTRY row.
 *
 * The registry holder's rightsHolderId is the Don store's payee key — the
 * sovereign vault, GL journals, and payout holds are all keyed by it — so
 * this module is where "which vault is mine?" is answered. It never returns
 * more than the greeting/readiness facts: no UCT, no account numbers (the
 * signup contract's disclosure rule holds here too).
 */

import { storedVirtualAccount } from '@/lib/covnant/provisioning';
import {
  createServerSupabaseClient,
  hasSupabaseSessionCookies,
  readSupabasePublicEnv,
} from '@/lib/server/supabaseSsr';
import { supabaseFromEnv } from '@/lib/supabase';

/** The designated self-serve identity registry row (signup route header). */
const SIGNUP_REGISTRY_CBT_CODE = 'CBT-SIGNUP-REGISTRY';

/** The creator_profiles columns the dashboard identity needs (0003 + 0004). */
const PROFILE_COLUMNS = 'id, stage_name, kyc_status, bank_account_linked';

/** The registry holder entry the dashboard identity reads. */
interface RegistryHolderEntry {
  rightsHolderId?: unknown;
  email?: unknown;
  payoutRouting?: unknown;
}

/** The cbt_assets shape this module reads (registry scan). */
interface AssetRow {
  cbt_code?: string | null;
  rights_holders?: unknown;
}

/**
 * A read FAILED — a server-side error (profile/registry read error, or
 * registry corruption such as a holder entry missing its rightsHolderId).
 * Fail closed: never surfaced as a signed-out or empty state; the route maps
 * it to the named 502 codes and the page renders its error state.
 */
export class SessionCreatorReadError extends Error {
  constructor(
    public readonly code: 'profile_read_failed' | 'registry_read_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SessionCreatorReadError';
  }
}

/** The session-bound identity facts the dashboard aggregate needs. */
export type SessionCreator = {
  /** The registry rightsHolderId — the Don store's payee key. */
  payee_id: string;
  stage_name: string;
  kyc_status: string;
  bank_account_linked: boolean;
  provisioning_status: 'PROVISIONED' | 'PENDING';
};

export type SessionCreatorResolution =
  | { kind: 'anonymous' }
  | { kind: 'unregistered'; reason: 'profile_not_found' | 'holder_not_found' }
  | { kind: 'registered'; creator: SessionCreator };

function isRegistryHolderEntry(value: unknown): value is RegistryHolderEntry {
  return typeof value === 'object' && value !== null && 'rightsHolderId' in value;
}

/**
 * The session email's holder entry — the ONLY lookup key. Compared against
 * the signup's stored normalization (trim + lowercase, signupValidation.ts),
 * so a session email in any case/whitespace form matches its own holder and
 * NEVER anyone else's.
 */
function findHolderByEmail(holders: unknown[], sessionEmail: string): RegistryHolderEntry | null {
  for (const holder of holders) {
    if (!isRegistryHolderEntry(holder)) continue;
    if (typeof holder.email === 'string' && holder.email.trim().toLowerCase() === sessionEmail) {
      return holder;
    }
  }
  return null;
}

/**
 * Resolves the signed-in creator from the request's session cookies — or the
 * honest non-registered state. Read FAILURES throw (SessionCreatorReadError);
 * everything else resolves.
 *
 * Without a configured Supabase there are no sessions at all — that is the
 * anonymous state, not an error (the middleware passes through unconfigured
 * environments the same way).
 */
export async function resolveSessionCreator(): Promise<SessionCreatorResolution> {
  if (!readSupabasePublicEnv()) {
    return { kind: 'anonymous' };
  }
  if (!(await hasSupabaseSessionCookies())) {
    return { kind: 'anonymous' };
  }
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { kind: 'anonymous' };
  }

  // The authoritative identity: the JWT validated against the auth server.
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    // An expired/invalid session is the signed-out state for a display
    // surface — the middleware refreshes live tokens on every navigation.
    return { kind: 'anonymous' };
  }
  const user = userData.user;

  // (a) The creator_profiles row for auth.uid() — under the select-own RLS
  // policy the session's token enforces. Missing row = unenrolled.
  const { data: profile, error: profileError } = await supabase
    .from('creator_profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', user.id)
    .maybeSingle();
  if (profileError) {
    console.error('creator_profiles read failed:', profileError.message);
    throw new SessionCreatorReadError('profile_read_failed', 'Failed to load the creator profile.');
  }
  if (profile === null) {
    return { kind: 'unregistered', reason: 'profile_not_found' };
  }

  // Service-role read for the registry — the same posture /api/covnant/me
  // uses (the registry JSONB has no authenticated-role grant). Every
  // identifier in the lookup is server-derived above.
  const db = supabaseFromEnv();
  if (!db) {
    return { kind: 'anonymous' };
  }
  const { data: assetRows, error: assetsError } = await db
    .from('cbt_assets')
    .select('cbt_code, rights_holders');
  if (assetsError) {
    console.error('cbt_assets read failed:', assetsError.message);
    throw new SessionCreatorReadError('registry_read_failed', 'Failed to load the creator registry.');
  }
  const rows = (assetRows ?? []) as AssetRow[];
  const registryRow = rows.find((row) => row.cbt_code === SIGNUP_REGISTRY_CBT_CODE);
  const holders =
    registryRow && Array.isArray(registryRow.rights_holders) ? registryRow.rights_holders : [];

  // (b) The SESSION email's holder entry — never an arbitrary email.
  const sessionEmail = (user.email ?? '').trim().toLowerCase();
  const holder = findHolderByEmail(holders, sessionEmail);
  if (holder === null) {
    return { kind: 'unregistered', reason: 'holder_not_found' };
  }
  if (typeof holder.rightsHolderId !== 'string' || holder.rightsHolderId.trim() === '') {
    console.error('Signup registry holder entry is missing rightsHolderId.');
    throw new SessionCreatorReadError('registry_read_failed', 'Failed to load the creator registry.');
  }

  return {
    kind: 'registered',
    creator: {
      payee_id: holder.rightsHolderId,
      stage_name: profile.stage_name,
      kyc_status: profile.kyc_status,
      bank_account_linked: profile.bank_account_linked,
      provisioning_status: storedVirtualAccount(holder) ? 'PROVISIONED' : 'PENDING',
    },
  };
}
