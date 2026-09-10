/**
 * resolveCovnantMe — the session-scoped creator aggregate, shared verbatim by
 * GET /api/covnant/me (the API contract) and the (workspace) server surfaces
 * (the dashboard home + the shell's identity state), so the two can never
 * disagree about what a session's creator data is.
 *
 * Everything resolves from the VERIFIED SESSION and nothing else: the auth
 * user comes from supabase.auth.getUser() (the JWT validated against the
 * auth server — never a client-supplied id/email/query param), the profile
 * row is read under the creator_profiles select-own RLS policy (id =
 * auth.uid(), migration 0003), the registry holder entry is matched
 * strictly by the SESSION email against the designated CBT-SIGNUP-REGISTRY
 * row, and the escrow totals flow through the SAME shared math
 * (/api/artist/dashboard's escrowBalanceForHolder + findRightsHolder) so
 * the surfaces can never disagree about what a holder has settled.
 *
 * The aggregate extends the API response with the display slice the
 * bank-home dashboard reads — the bounded recent-royalty strip (max 10,
 * READ-ONLY, fail-closed) and per-currency settled totals, both computed by
 * the pure creator slice over the ONE ledger read. registeredAssets is the
 * creator-scoped count of registry rows that carry the holder.
 *
 * Errors use the ONE named-code family: 401 no_session / session_invalid,
 * 404 profile_not_found / holder_not_found, 502 profile_read_failed /
 * registry_read_failed / escrow_read_failed (fail closed — a read error is
 * never surfaced as empty data), 503 supabase_not_configured. The API route
 * maps !ok resolutions onto its envelope; pages render the honest visitor /
 * degraded states from the same union.
 *
 * READ-ONLY: zero writes — no ledger, registry, or profile mutation. The
 * registry/ledger reads use the service-role client (the registry JSONB has
 * no authenticated-role grant; the research's service-role hop), but every
 * identifier in those reads is server-derived.
 *
 * React cache(): one resolution per server request even when both the
 * layout (sidebar identity) and the page (dashboard home) consume it.
 */

import { cache } from 'react';

import {
  EscrowLedgerReadError,
  UNVERIFIED_FALLBACK_TAX_PROFILE,
  escrowBalanceForHolder,
  fetchCreatorLedgerRows,
  findRightsHolder,
} from '@/lib/escrow/balance';
import { storedVirtualAccount } from '@/lib/covnant/provisioning';
import { normalizeEngine } from '@/lib/covnant/uct';
import type { CreatorProfile, CovnantMeResponse } from '@/lib/covnant/types';
import {
  createServerSupabaseClient,
  hasSupabaseSessionCookies,
  readSupabasePublicEnv,
} from '@/lib/server/supabaseSsr';
import { supabaseFromEnv } from '@/lib/supabase';
import {
  creatorSettlementsFromDbRows,
  holderAssetCbtCodes,
  registeredAssetsForHolder,
} from '@/lib/ledger/creatorSlice';

/** The designated self-serve identity registry row (signup route header). */
const SIGNUP_REGISTRY_CBT_CODE = 'CBT-SIGNUP-REGISTRY';

/** The profile columns the aggregate discloses — the full row, 0003 + 0004. */
const PROFILE_COLUMNS =
  'id, stage_name, legal_name, email, phone, phone_verified_at, core_industry, title, udr_terms_accepted_at, kyc_status, tax_form_type, tax_verified, bank_account_linked, created_at';

/** The cbt_assets shape this aggregate reads (registry + escrow holder scan). */
interface AssetRow {
  cbt_code?: string | null;
  rights_holders?: unknown;
}

/** The signup-registry holder entry — the PR #26 shape + issuance facts. */
interface RegistryHolderEntry {
  rightsHolderId?: unknown;
  email?: unknown;
  role?: unknown;
  uct?: unknown;
  uctCreatedAt?: unknown;
  uctJurisdiction?: unknown;
  engine?: unknown;
}

function isRegistryHolderEntry(value: unknown): value is RegistryHolderEntry {
  return typeof value === 'object' && value !== null && 'rightsHolderId' in value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
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
 * Validates the identity block off the holder entry. The mint writes these
 * fields as non-empty strings (engine pre-validated against the engine
 * vocabulary); a read-time violation is registry corruption — fail closed,
 * never a partial identity.
 */
function holderIdentity(
  entry: RegistryHolderEntry,
): { ok: true; identity: CovnantMeResponse['identity'] } | { ok: false } {
  const { uct, uctCreatedAt, uctJurisdiction, engine } = entry;
  if (!isNonEmptyString(uct) || !isNonEmptyString(uctCreatedAt) || !isNonEmptyString(uctJurisdiction)) {
    return { ok: false };
  }
  if (engine !== undefined && !isNonEmptyString(engine)) {
    return { ok: false };
  }
  const normalizedEngine = engine === undefined ? undefined : normalizeEngine(engine);
  if (engine !== undefined && normalizedEngine === null) {
    return { ok: false };
  }
  return {
    ok: true,
    identity: {
      uct,
      uctCreatedAt,
      jurisdiction: uctJurisdiction,
      ...(normalizedEngine ? { engine: normalizedEngine } : {}),
    },
  };
}

/** The failed resolution — the named-code family the API envelope and the honest page states share. */
export interface CovnantMeFailure {
  ok: false;
  status: 401 | 404 | 502 | 503;
  reason: string;
  message: string;
}

export type CovnantMeResolution =
  | { ok: true; data: CovnantMeResponse }
  | CovnantMeFailure;

export const resolveCovnantMe = cache(async (): Promise<CovnantMeResolution> => {
  // Fail-closed environment checks first — sanitized named codes, zero reads.
  if (!readSupabasePublicEnv()) {
    return { ok: false, status: 503, reason: 'supabase_not_configured', message: 'Supabase credentials are not configured.' };
  }
  if (!(await hasSupabaseSessionCookies())) {
    return { ok: false, status: 401, reason: 'no_session', message: 'No session — sign in to load the creator aggregate.' };
  }
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { ok: false, status: 503, reason: 'supabase_not_configured', message: 'Supabase credentials are not configured.' };
  }

  // The authoritative identity: the JWT validated against the auth server.
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return { ok: false, status: 401, reason: 'session_invalid', message: 'The session is absent or invalid.' };
  }
  const user = userData.user;

  // (a) The creator_profiles row for auth.uid() — under the select-own RLS
  // policy the session's token enforces. Missing row = fail closed.
  const { data: profile, error: profileError } = await supabase
    .from('creator_profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', user.id)
    .maybeSingle();
  if (profileError) {
    console.error('creator_profiles read failed:', profileError.message);
    return { ok: false, status: 502, reason: 'profile_read_failed', message: 'Failed to load the creator profile.' };
  }
  if (profile === null) {
    return { ok: false, status: 404, reason: 'profile_not_found', message: 'No creator profile exists for this session.' };
  }

  // Service-role reads for the registry + ledger — the same posture
  // /api/artist/dashboard uses. Every identifier is server-derived above.
  const db = supabaseFromEnv();
  if (!db) {
    return { ok: false, status: 503, reason: 'supabase_not_configured', message: 'Supabase credentials are not configured.' };
  }
  const { data: assetRows, error: assetsError } = await db
    .from('cbt_assets')
    .select('cbt_code, rights_holders');
  if (assetsError) {
    console.error('cbt_assets read failed:', assetsError.message);
    return { ok: false, status: 502, reason: 'registry_read_failed', message: 'Failed to load the creator registry.' };
  }
  const rows = (assetRows ?? []) as AssetRow[];
  const registryRow = rows.find((row) => row.cbt_code === SIGNUP_REGISTRY_CBT_CODE);
  const holders =
    registryRow && Array.isArray(registryRow.rights_holders) ? registryRow.rights_holders : [];

  // (b) The SESSION email's holder entry — never an arbitrary email.
  const sessionEmail = (user.email ?? '').trim().toLowerCase();
  const holder = findHolderByEmail(holders, sessionEmail);
  if (holder === null) {
    return { ok: false, status: 404, reason: 'holder_not_found', message: 'No rights-holder registration exists for this session.' };
  }
  if (!isNonEmptyString(holder.rightsHolderId)) {
    console.error('Signup registry holder entry is missing rightsHolderId.');
    return { ok: false, status: 502, reason: 'registry_read_failed', message: 'Failed to load the creator registry.' };
  }
  const identity = holderIdentity(holder);
  if (!identity.ok || !isNonEmptyString(holder.role)) {
    console.error('Signup registry holder entry is missing its identity fields.');
    return { ok: false, status: 502, reason: 'registry_read_failed', message: 'Failed to load the creator registry.' };
  }

  // (c) Per-holder escrow totals — the shared pure math over ONE fail-closed
  // ledger read that also carries the display columns for the dashboard
  // slice. BigInt unit strings, never a float rollup. Fail closed: a ledger
  // read error must never surface as a zero balance.
  const escrowHolder = findRightsHolder(rows, holder.rightsHolderId);
  const taxProfile = escrowHolder?.taxProfile ?? UNVERIFIED_FALLBACK_TAX_PROFILE;
  let balance: ReturnType<typeof escrowBalanceForHolder>;
  let recentSlice: ReturnType<typeof creatorSettlementsFromDbRows>;
  try {
    const ledgerRows = await fetchCreatorLedgerRows(db);
    balance = escrowBalanceForHolder({
      disbursementsByRow: ledgerRows.map((row) =>
        Array.isArray(row.disbursements) ? row.disbursements : [],
      ),
      rightsHolderId: holder.rightsHolderId,
      taxProfile,
    });
    recentSlice = creatorSettlementsFromDbRows({
      dbRows: ledgerRows,
      rightsHolderId: holder.rightsHolderId,
    });
  } catch (error) {
    if (error instanceof EscrowLedgerReadError) {
      console.error('escrow balance read failed:', error.message);
      return { ok: false, status: 502, reason: 'escrow_read_failed', message: 'Failed to load the creator settlements.' };
    }
    throw error;
  }

  // Provisioning is STATUS ONLY via storedVirtualAccount() — never numbers.
  const provisioned = storedVirtualAccount(holder);

  // Contracts scoped to the holder: the agreements whose cbt_code is one of
  // the holder's registered assets. Bounded read, fail closed like the rest.
  const assetCodes = holderAssetCbtCodes(rows, holder.rightsHolderId);
  const { count: activeContracts, error: contractsError } = await db
    .from('contracts')
    .select('id', { count: 'exact', head: true })
    .in('cbt_code', assetCodes);
  if (contractsError) {
    console.error('contracts read failed:', contractsError.message);
    return { ok: false, status: 502, reason: 'contracts_read_failed', message: 'Failed to load the creator contracts.' };
  }

  const data: CovnantMeResponse = {
    profile: profile as CreatorProfile,
    identity: identity.identity,
    role: holder.role,
    provisioning: provisioned
      ? { status: 'PROVISIONED' }
      : { status: 'PENDING', reason: 'INCREASE_NOT_PROVISIONED' },
    settlements: {
      grossEarnings: balance.grossUnits.toString(),
      taxWithheld: balance.taxWithheldUnits.toString(),
      availableEscrowBalance: balance.availableUnits.toString(),
      isTaxVerified: taxProfile.isVerified,
    },
    registeredAssets: registeredAssetsForHolder(rows, holder.rightsHolderId),
    activeContracts: activeContracts ?? 0,
    settlementsByCurrency: recentSlice.totalsByCurrency,
    recentSettlements: recentSlice.recent,
  };
  return { ok: true, data };
});
